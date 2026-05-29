/**
 * VisBait — Tier Expiry Checker
 * Cloudflare Worker with Cron Trigger — runs daily at midnight UTC
 *
 * Checks profiles.tier_expires_at — if expired, downgrades to free.
 *
 * DEPLOY:
 * 1. Create new Cloudflare Worker
 * 2. Paste this code
 * 3. Add Cron Trigger: 0 0 * * * (every day at midnight UTC)
 * 4. Set environment variables (same as stripe-webhook):
 *    SUPABASE_URL, SUPABASE_SERVICE_KEY
 *
 * SQL needed in Supabase:
 *   alter table public.profiles add column if not exists tier_expires_at timestamptz;
 *   alter table public.profiles add column if not exists tier_status text default 'active';
 */

export default {

  // ── HTTP handler (for manual triggers/health checks) ──
  async fetch(request, env) {
    if (request.method === 'GET') {
      const result = await checkExpiredTiers(env);
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('Method not allowed', { status: 405 });
  },

  // ── Cron handler — runs daily ──
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkExpiredTiers(env));
  }
};

async function checkExpiredTiers(env) {
  const now = new Date().toISOString();
  console.log(`Checking expired tiers at ${now}`);

  try {
    // Find all users whose tier has expired
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/profiles?tier_expires_at=lt.${encodeURIComponent(now)}&tier=neq.free&select=id,email,tier,tier_expires_at`,
      {
        headers: {
          'apikey':         env.SUPABASE_SERVICE_KEY,
          'Authorization':  `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          'Accept-Profile': 'public'
        }
      }
    );

    const expired = await res.json();
    if (!Array.isArray(expired) || !expired.length) {
      console.log('No expired tiers found');
      return { downgraded: 0, checked_at: now };
    }

    console.log(`Found ${expired.length} expired tier(s)`);
    let downgraded = 0;

    for (const user of expired) {
      try {
        // Downgrade to free
        await fetch(
          `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`,
          {
            method: 'PATCH',
            headers: {
              'Content-Type':   'application/json',
              'apikey':         env.SUPABASE_SERVICE_KEY,
              'Authorization':  `Bearer ${env.SUPABASE_SERVICE_KEY}`,
              'Accept-Profile': 'public',
              'Content-Profile':'public'
            },
            body: JSON.stringify({
              tier: 'free',
              tier_expires_at: null,
              tier_status: 'expired'
            })
          }
        );

        // Log it
        await fetch(`${env.SUPABASE_URL}/rest/v1/billing_events`, {
          method: 'POST',
          headers: {
            'Content-Type':   'application/json',
            'apikey':         env.SUPABASE_SERVICE_KEY,
            'Authorization':  `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'Accept-Profile': 'public',
            'Content-Profile':'public'
          },
          body: JSON.stringify({
            email:      user.email,
            event_type: 'tier.expired',
            tier:       'free',
            price_id:   null,
            created_at: now
          })
        });

        console.log(`Downgraded ${user.email} from ${user.tier} to free (expired: ${user.tier_expires_at})`);
        downgraded++;

      } catch (err) {
        console.error(`Failed to downgrade ${user.email}:`, err.message);
      }
    }

    return { downgraded, checked_at: now };

  } catch (err) {
    console.error('Expiry check failed:', err);
    return { error: err.message, checked_at: now };
  }
}
