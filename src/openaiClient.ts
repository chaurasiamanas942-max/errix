// src/openaiClient.ts
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export interface StreamChatOptions {
  apiKey: string;
  baseUrl?: string;
  model: string;
  temperature?: number;
  messages: ChatMessage[];
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}

/**
 * Streams a chat completion from an OpenAI-compatible endpoint.
 * Returns the full accumulated reply text.
 */
export async function streamChat(opts: StreamChatOptions): Promise<string> {
  const baseUrl = (opts.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.2,
      stream: true,
    }),
    signal: opts.signal,
  });
 if (!res.ok) {
    const body = await res.text().catch(() => '');
    let message = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body);
      if (parsed?.error?.message) message = parsed.error.message;
    } catch {
      /* not JSON */
    }
    throw new Error(res.status === 429 ? message : `API ${res.status}: ${message}`);
  }

if (!res.body) {
  throw new Error('Response body is missing (streaming not supported by the endpoint or network layer)');
}

const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by \n\n
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      const lines = part.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            opts.onDelta?.(delta);
          }
        } catch {
          // Ignore malformed keep-alive / partial chunks
        }
      }
    }
  }

  return full;
}