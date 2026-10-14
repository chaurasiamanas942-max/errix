// src/provider.ts
import * as vscode from 'vscode';

/** Errix Cloud API. Override with the errix.cloudUrl setting when testing locally. */
export const CLOUD_URL = 'https://errix-jet.vercel.app/api/v1';

/** A GitHub sign-in token (gho_..., ghu_...) means "use Errix Cloud". */
export function isCloudKey(apiKey: string): boolean {
  return /^gh[a-z]_/.test(apiKey);
}

export function resolveProvider(apiKey: string): {
  baseUrl: string;
  model: string;
  voiceModel: string;
} {
  const c = vscode.workspace.getConfiguration('errix');

  if (isCloudKey(apiKey)) {
    // The server chooses the real models, so these names are ignored.
    return {
      baseUrl: c.get<string>('cloudUrl', '').trim() || CLOUD_URL,
      model: 'errix-cloud',
      voiceModel: 'errix-cloud'
    };
  }

  const groq = apiKey.startsWith('gsk_');
  return {
    baseUrl:
      c.get<string>('baseUrl', '').trim() ||
      (groq ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1'),
    model:
      c.get<string>('model', '').trim() ||
      (groq ? 'openai/gpt-oss-120b' : 'gpt-4o-mini'),
    voiceModel:
      c.get<string>('voiceModel', '').trim() ||
      (groq ? 'whisper-large-v3' : 'whisper-1')
  };
}