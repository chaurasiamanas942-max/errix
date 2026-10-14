// GET /api/v1/usage: how much of today's free quota the signed-in user has used.
import { authenticate } from '@/lib/auth';
import { CFG } from '@/lib/config';
import { err } from '@/lib/http';
import { usageToday } from '@/lib/quota';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticate(req);
  if (!auth.ok) return err(auth.status, auth.message, 'auth');

  try {
    const used = await usageToday(auth.user.key);
    return new Response(
      JSON.stringify({
        user: auth.user.login,
        chat: { used: used.chat, limit: CFG.chatPerDay },
        voice: { used: used.voice, limit: CFG.voicePerDay },
        resets: '00:00 UTC (5:30 AM IST)'
      }),
      { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
    );
  } catch (e) {
    console.error('usage error', e);
    return err(503, 'The usage service is unavailable.', 'unavailable');
  }
}
