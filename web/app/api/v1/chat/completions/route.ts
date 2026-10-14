// POST /api/v1/chat/completions: OpenAI-compatible chat endpoint (streaming).
import { authenticate } from '@/lib/auth';
import { CFG } from '@/lib/config';
import { err } from '@/lib/http';
import { burstOk, consume, RESET_NOTE } from '@/lib/quota';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // the longest a Hobby function may run

const UPSTREAM = 'https://api.groq.com/openai/v1/chat/completions';
const ROLES = new Set(['system', 'user', 'assistant']);

export async function POST(req: Request): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth.ok) return err(auth.status, auth.message, 'auth');
  const { user } = auth;

  if (!process.env.GROQ_API_KEY) return err(500, 'The server is not configured yet.', 'config');

  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, 'Invalid JSON.', 'bad_request');
  }

  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 60) {
    return err(400, 'Invalid messages.', 'bad_request');
  }

  // Only forward what we expect. The client cannot choose the model or token limits.
  const clean: { role: string; content: string }[] = [];
  let chars = 0;
  for (const m of messages) {
    if (!m || !ROLES.has(m.role) || typeof m.content !== 'string') {
      return err(400, 'Invalid message.', 'bad_request');
    }
    chars += m.content.length;
    clean.push({ role: m.role, content: m.content });
  }
  if (chars > CFG.maxInputChars) {
    return err(
      413,
      `This request is too large (${chars} characters, the limit is ${CFG.maxInputChars}). Start a new chat or attach fewer files.`,
      'too_large'
    );
  }

  if (!burstOk(user.key)) {
    return err(429, 'Too many requests in one minute. Wait a moment and try again.', 'rate_limited', {
      'Retry-After': '30'
    });
  }

  let quota;
  try {
    quota = await consume(user.key, 'chat');
  } catch (e) {
    console.error('quota error', e);
    return err(503, 'The usage service is unavailable. Try again shortly.', 'unavailable');
  }
  if (!quota.ok) {
    const message =
      quota.reason === 'global'
        ? `Errix's free tier is full for today. Try again tomorrow, or add your own API key with "Errix: Set API Key".`
        : `You have used your ${quota.limit} free chats for today. ${RESET_NOTE}`;
    return err(429, message, 'quota_exceeded');
  }

  const temperature =
    typeof body.temperature === 'number' ? Math.min(Math.max(body.temperature, 0), 1) : 0.2;

  const upstream = await fetch(UPSTREAM, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: CFG.chatModel,
      messages: clean,
      temperature,
      stream: true,
      max_completion_tokens: CFG.maxCompletionTokens,
      ...(CFG.reasoningEffort ? { reasoning_effort: CFG.reasoningEffort } : {})
    }),
    signal: req.signal
  }).catch(() => null);

  if (!upstream) return err(502, 'The AI provider could not be reached.', 'upstream');
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    console.error('upstream error', upstream.status, detail.slice(0, 300));
    return err(502, 'The AI provider returned an error. Try again.', 'upstream');
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no'
    }
  });
}
