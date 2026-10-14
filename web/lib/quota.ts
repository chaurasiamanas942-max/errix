// lib/quota.ts: daily limits (stored in Supabase) plus a best-effort per-minute limiter.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { CFG } from './config';

let client: SupabaseClient | undefined;

function db(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Supabase environment variables are missing.');
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return client;
}

export type Kind = 'chat' | 'voice';

export interface QuotaResult {
  ok: boolean;
  reason?: 'user' | 'global';
  used?: number;
  limit?: number;
}

/** Atomically counts one request. Returns ok:false when a limit is reached. */
export async function consume(userKey: string, kind: Kind): Promise<QuotaResult> {
  const { data, error } = await db().rpc('consume_quota', {
    p_user: userKey,
    p_kind: kind,
    p_limit: kind === 'chat' ? CFG.chatPerDay : CFG.voicePerDay,
    p_global_limit: kind === 'chat' ? CFG.globalChatPerDay : CFG.globalVoicePerDay
  });
  if (error) throw new Error(error.message);
  return data as QuotaResult;
}

export async function usageToday(userKey: string): Promise<{ chat: number; voice: number }> {
  const day = new Date().toISOString().slice(0, 10); // UTC day, same as the SQL function
  const { data } = await db()
    .from('usage_daily')
    .select('chat_requests, voice_requests')
    .eq('user_key', userKey)
    .eq('day', day)
    .maybeSingle();
  return { chat: data?.chat_requests ?? 0, voice: data?.voice_requests ?? 0 };
}

// Per-minute limiter. It lives in memory, so it is only a best-effort guard on serverless.
// The daily limit in the database is the hard limit.
const hits = new Map<string, number[]>();

export function burstOk(userKey: string): boolean {
  const now = Date.now();
  const recent = (hits.get(userKey) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= CFG.perMinute) {
    hits.set(userKey, recent);
    return false;
  }
  recent.push(now);
  hits.set(userKey, recent);
  if (hits.size > 5000) hits.clear();
  return true;
}

export const RESET_NOTE = 'Limits reset at 5:30 AM IST. For unlimited use, add your own API key with "Errix: Set API Key".';
