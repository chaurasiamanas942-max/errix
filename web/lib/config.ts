// lib/config.ts: every limit lives here and can be changed with environment variables.

function int(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export const CFG = {
  // The server chooses the models, so the extension never needs updating when Groq retires one.
  chatModel: process.env.CHAT_MODEL || 'openai/gpt-oss-120b',
  voiceModel: process.env.VOICE_MODEL || 'whisper-large-v3',
  // Set REASONING_EFFORT to an empty string if you switch to a model that does not support it.
  reasoningEffort: process.env.REASONING_EFFORT ?? 'low',

  chatPerDay: int('CHAT_PER_DAY', 30),
  voicePerDay: int('VOICE_PER_DAY', 20),
  globalChatPerDay: int('GLOBAL_CHAT_PER_DAY', 3000),
  globalVoicePerDay: int('GLOBAL_VOICE_PER_DAY', 1500),
  perMinute: int('PER_MINUTE', 5),

  maxInputChars: int('MAX_INPUT_CHARS', 40000),
  // Reasoning tokens count toward this limit, so keep it generous.
  maxCompletionTokens: int('MAX_COMPLETION_TOKENS', 3000),
  maxAudioBytes: int('MAX_AUDIO_BYTES', 3_000_000),
  minAccountAgeDays: int('MIN_ACCOUNT_AGE_DAYS', 7)
};
