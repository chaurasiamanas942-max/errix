// src/provider.ts
import * as vscode from 'vscode';

export function resolveProvider(apiKey: string): {
  baseUrl: string;
  model: string;
  voiceModel: string;
} {
  const c = vscode.workspace.getConfiguration('errix');
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