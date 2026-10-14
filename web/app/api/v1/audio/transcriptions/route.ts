// POST /api/v1/audio/transcriptions: OpenAI-compatible speech-to-text endpoint.
import { authenticate } from '@/lib/auth';
import { CFG } from '@/lib/config';
import { err } from '@/lib/http';
import { burstOk, consume, RESET_NOTE } from '@/lib/quota';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const UPSTREAM = 'https://api.groq.com/openai/v1/audio/transcriptions';

export async function POST(req: Request): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth.ok) return err(auth.status, auth.message, 'auth');
  const { user } = auth;

  if (!process.env.GROQ_API_KEY) return err(500, 'The server is not configured yet.', 'config');

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return err(400, 'Invalid upload.', 'bad_request');
  }

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return err(400, 'Missing audio file.', 'bad_request');
  }
  if (file.size > CFG.maxAudioBytes) {
    return err(413, 'The recording is too long. Keep it under about a minute.', 'too_large');
  }

  if (!burstOk(user.key)) {
    return err(429, 'Too many requests in one minute. Wait a moment and try again.', 'rate_limited', {
      'Retry-After': '30'
    });
  }

  let quota;
  try {
    quota = await consume(user.key, 'voice');
  } catch (e) {
    console.error('quota error', e);
    return err(503, 'The usage service is unavailable. Try again shortly.', 'unavailable');
  }
  if (!quota.ok) {
    const message =
      quota.reason === 'global'
        ? `Errix's free voice quota is full for today. Try again tomorrow, or add your own API key with "Errix: Set API Key".`
        : `You have used your ${quota.limit} free voice recordings for today. ${RESET_NOTE}`;
    return err(429, message, 'quota_exceeded');
  }

  const out = new FormData();
  out.append('file', file, file.name || 'speech.webm');
  out.append('model', CFG.voiceModel); // the client's model name is ignored
  out.append('response_format', 'json');
  const language = form.get('language');
  if (typeof language === 'string' && /^[a-z]{2,3}$/i.test(language)) {
    out.append('language', language);
  }

  const upstream = await fetch(UPSTREAM, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: out,
    signal: req.signal
  }).catch(() => null);

  if (!upstream) return err(502, 'The speech provider could not be reached.', 'upstream');
  const text = await upstream.text();
  if (!upstream.ok) {
    console.error('upstream error', upstream.status, text.slice(0, 300));
    return err(502, 'The speech provider returned an error. Try again.', 'upstream');
  }

  return new Response(text, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
