// src/voice.ts
import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';

const MAX_AUDIO_BYTES = 24 * 1024 * 1024; // Whisper endpoints reject files over about 25 MB
const LISTEN_TIMEOUT_MS = 3 * 60 * 1000;

export interface VoiceOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  language?: string;
  signal?: AbortSignal;
}

interface Recording {
  data: Buffer;
  mime: string;
}

// Small recording page, served from 127.0.0.1 so the browser allows the microphone.
const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Errix Voice</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#12121a;color:#f2f2f8;font-family:system-ui,sans-serif;text-align:center}
.wrap{padding:24px}
button{width:120px;height:120px;border-radius:50%;border:0;font-size:44px;cursor:pointer;color:#fff;background:linear-gradient(135deg,#7C5CFF,#22D3EE)}
button.rec{background:#e5484d;animation:p 1.2s infinite}
@keyframes p{50%{transform:scale(1.07)}}
#msg{margin-top:22px;min-height:24px;color:#9a9ab0}
</style></head><body><div class="wrap">
<button id="b">🎙</button><div id="msg">Click the microphone and start talking</div></div>
<script>
const b=document.getElementById('b'),msg=document.getElementById('msg');
let rec,chunks=[],stream,timer;
async function start(){
  try{stream=await navigator.mediaDevices.getUserMedia({audio:true});}
  catch(e){msg.textContent='Microphone blocked. Allow it in the address bar and reload.';return;}
  const mime=['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4'].find(m=>MediaRecorder.isTypeSupported(m))||'';
  rec=new MediaRecorder(stream,mime?{mimeType:mime}:undefined);
  chunks=[];
  rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
  rec.onstop=send;
  rec.start();
  b.classList.add('rec');b.textContent='⏹';msg.textContent='Listening… click again to stop';
  timer=setTimeout(stop,120000);
}
function stop(){
  clearTimeout(timer);
  if(rec&&rec.state!=='inactive')rec.stop();
  stream.getTracks().forEach(t=>t.stop());
  b.classList.remove('rec');b.disabled=true;b.textContent='…';msg.textContent='Sending…';
}
async function send(){
  const blob=new Blob(chunks,{type:rec.mimeType||'audio/webm'});
  try{
    const r=await fetch('/TOKEN/audio',{method:'POST',headers:{'Content-Type':blob.type},body:blob});
    if(!r.ok)throw new Error(r.status);
    b.textContent='✔';msg.textContent='Done. You can close this tab and go back to VS Code.';
  }catch(e){b.textContent='⚠';msg.textContent='Could not send audio: '+e.message;}
}
b.onclick=()=>{if(rec&&rec.state==='recording')stop();else if(!b.disabled)start();};
</script></body></html>`;

/** Starts a one-time local server, opens the recording page, and waits for the audio. */
function captureAudio(signal?: AbortSignal): Promise<Recording | undefined> {
  const token = crypto.randomBytes(16).toString('hex');

  return new Promise<Recording | undefined>((resolve, reject) => {
    if (signal?.aborted) return resolve(undefined);

    let done = false;
    const cleanup = (): void => {
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      server.close();
      (server as any).closeAllConnections?.();
    };
    const finish = (value: Recording | undefined): void => {
      if (done) return;
      cleanup();
      resolve(value);
    };
    const fail = (err: Error): void => {
      if (done) return;
      cleanup();
      reject(err);
    };
    const onAbort = (): void => finish(undefined);

    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === `/${token}`) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(PAGE.replace('TOKEN', token));
        return;
      }

      if (req.method === 'POST' && req.url === `/${token}/audio`) {
        const parts: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_AUDIO_BYTES) {
            res.writeHead(413);
            res.end();
            req.destroy();
            fail(new Error('The recording is too long. Keep it under about 2 minutes.'));
            return;
          }
          parts.push(chunk);
        });
        req.on('end', () => {
          if (done) return;
          res.writeHead(200);
          res.end('ok');
          finish({
            data: Buffer.concat(parts),
            mime: String(req.headers['content-type'] ?? 'audio/webm')
          });
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const timer = setTimeout(() => finish(undefined), LISTEN_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort);
    server.on('error', fail);

    // Port 0 = any free port; 127.0.0.1 = reachable only from this computer.
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      void vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${port}/${token}`));
    });
  });
}

async function transcribe(rec: Recording, o: VoiceOptions): Promise<string> {
  const baseUrl = (o.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const ext = rec.mime.includes('ogg') ? 'ogg' : rec.mime.includes('mp4') ? 'm4a' : 'webm';

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(rec.data)], { type: rec.mime }), `speech.${ext}`);
  form.append('model', o.model);
  form.append('response_format', 'json');
  if (o.language) form.append('language', o.language);

  const res = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${o.apiKey}` },
    body: form,
    signal: o.signal
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Transcription API ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { text?: string };
  return (json.text ?? '').trim();
}

/** Returns the spoken text, '' if nothing was recognized, or undefined if cancelled. */
export async function recordAndTranscribe(o: VoiceOptions): Promise<string | undefined> {
  const rec = await captureAudio(o.signal);
  if (!rec) return undefined;
  return transcribe(rec, o);
}