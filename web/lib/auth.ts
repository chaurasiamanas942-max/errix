// lib/auth.ts: verifies the GitHub token that the VS Code extension sends.
// We only read the numeric GitHub user id. The token itself is never stored.
import { createHash } from 'node:crypto';
import { CFG } from './config';

export interface User {
  key: string; // e.g. "github:12345"
  login: string;
}

export type AuthResult =
  | { ok: true; user: User }
  | { ok: false; status: number; message: string };

const cache = new Map<string, { user: User; exp: number }>();
const TTL_MS = 5 * 60 * 1000;

export async function authenticate(req: Request): Promise<AuthResult> {
  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || token.length > 500) {
    return { ok: false, status: 401, message: 'Sign in with GitHub in VS Code to use Errix.' };
  }

  const id = createHash('sha256').update(token).digest('hex');
  const hit = cache.get(id);
  if (hit && hit.exp > Date.now()) return { ok: true, user: hit.user };

  let res: Response;
  try {
    res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'errix-api'
      },
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    return { ok: false, status: 503, message: 'Could not reach GitHub to verify your sign-in. Try again.' };
  }
  if (!res.ok) {
    return { ok: false, status: 401, message: 'Your GitHub sign-in expired. Sign in again.' };
  }

  const u = (await res.json()) as { id?: number; login?: string; created_at?: string };
  if (!u.id) {
    return { ok: false, status: 401, message: 'Could not verify your GitHub account.' };
  }

  if (CFG.minAccountAgeDays > 0 && u.created_at) {
    const ageDays = (Date.now() - Date.parse(u.created_at)) / 86_400_000;
    if (ageDays < CFG.minAccountAgeDays) {
      return {
        ok: false,
        status: 403,
        message: `Your GitHub account must be at least ${CFG.minAccountAgeDays} days old to use the free tier.`
      };
    }
  }

  const user: User = { key: `github:${u.id}`, login: u.login ?? '' };
  if (cache.size > 5000) cache.clear();
  cache.set(id, { user, exp: Date.now() + TTL_MS });
  return { ok: true, user };
}
