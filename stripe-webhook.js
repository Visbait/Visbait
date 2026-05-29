/**
 * VisBait — Stripe Webhook Handler
 * Deploy as a Cloudflare Worker at: workers.visbait.com/stripe-webhook
 *
 * Listens for Stripe events and updates Supabase profiles.tier accordingly.
 *
 * ENVIRONMENT VARIABLES (set in Cloudflare Workers dashboard):
 *   STRIPE_WEBHOOK_SECRET   — from Stripe Dashboard > Webhooks > Signing secret
 *   SUPABASE_URL            — https://bahewejrwczhlwnairmk.supabase.co
 *   SUPABASE_SERVICE_KEY    — from Supabase > Settings > API > service_role key (NOT anon key)
 *
 * STRIPE PRICE IDs:
 *   Pro   price_1TYWw2QumanVqQxDucW38ku4  ($7.99/mo)
 *   Elite price_1TYWw7QumanVqQxDJp5djM41  ($14.99/mo)
 */

const PRICE_TO_TIER = {
  'price_1TYWw2QumanVqQxDucW38ku4': 'pro',
  'price_1TYWw7QumanVqQxDJp5djM41': 'elite'
};

export default {
  async fetch(request, env) {

    // Only accept POST
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const body = await request.text();
    const sig  = request.headers.get('stripe-signature');

    // ── Verify Stripe signature ──
    let event;
    try {
      event = await verifyStripeSignature(body, sig, env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature failed:', err.message);
      return new Response('Invalid signature', { status: 400 });
    }

    console.log('Stripe event:', event.type);

    try {
      switch (event.type) {

        // ── Payment succeeded — upgrade tier ──
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'invoice.payment_succeeded': {
          const sub = event.data.object;
          const customerId = sub.customer || (sub.subscription && sub.subscription.customer);
          const priceId    = getPriceId(sub);
          const tier       = PRICE_TO_TIER[priceId] || null;

          if (customerId && tier) {
            const email = await getEmailFromCustomer(customerId, env);
            if (email) {
              await updateUserTier(email, tier, env);
              await logBillingEvent(email, event.type, tier, priceId, env);
              console.log(`Upgraded ${email} to ${tier}`);
            }
          }
          break;
        }

        // ── Subscription cancelled — honor billing period or 30 days (whichever longer) ──
        case 'customer.subscription.deleted': {
          const sub = event.data.object;
          const customerId = sub.customer;

          if (customerId) {
            const email = await getEmailFromCustomer(customerId, env);
            if (email) {
              // current_period_end is Unix timestamp from Stripe
              const periodEnd    = sub.current_period_end ? sub.current_period_end * 1000 : Date.now();
              const thirtyDays   = Date.now() + (30 * 24 * 60 * 60 * 1000);
              // Honor whichever is longer: paid billing period OR 30 days from now
              const expiresAt    = new Date(Math.max(periodEnd, thirtyDays)).toISOString();
              const priceId      = getPriceId(sub);
              const tier         = PRICE_TO_TIER[priceId] || 'pro';

              // Keep tier active but set expiry — daily job will downgrade after expiry
              await updateUserTierWithExpiry(email, tier, expiresAt, env);
              await logBillingEvent(email, event.type, tier, priceId, env);
              console.log(`Canceled: ${email} keeps ${tier} until ${expiresAt}`);
            }
          }
          break;
        }

        // ── Payment failed — immediate grace period (30 days) ──
        case 'invoice.payment_failed': {
          const sub = event.data.object;
          const customerId = sub.customer;

          if (customerId) {
            const email = await getEmailFromCustomer(customerId, env);
            if (email) {
              const expiresAt = new Date(Date.now() + (30 * 24 * 60 * 60 * 1000)).toISOString();
              await updateUserTierWithExpiry(email, 'pro', expiresAt, env);
              await logBillingEvent(email, event.type, 'payment_failed', null, env);
              console.log(`Payment failed: ${email} grace period until ${expiresAt}`);
            }
          }
          break;
        }

        default:
          console.log('Unhandled event type:', event.type);
      }
    } catch (err) {
      console.error('Webhook handler error:', err);
      return new Response('Handler error', { status: 500 });
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

/* ─── Get price ID from subscription or invoice object ─── */
function getPriceId(obj) {
  if (obj.items && obj.items.data && obj.items.data[0]) {
    return obj.items.data[0].price && obj.items.data[0].price.id;
  }
  if (obj.lines && obj.lines.data && obj.lines.data[0]) {
    return obj.lines.data[0].price && obj.lines.data[0].price.id;
  }
  return null;
}

/* ─── Fetch customer email from Stripe ─── */
async function getEmailFromCustomer(customerId, env) {
  const res = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
    headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` }
  });
  const customer = await res.json();
  return customer.email || null;
}

/* ─── Update profiles.tier in Supabase ─── */
async function updateUserTier(email, tier, env) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Accept-Profile':'public',
        'Content-Profile':'public',
        'Prefer':        'return=representation'
      },
      body: JSON.stringify({ tier, tier_expires_at: null }) // active sub — no expiry
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase update failed: ${err}`);
  }
  return res.json();
}

/* ─── Update tier with expiry date (canceled subs) ─── */
async function updateUserTierWithExpiry(email, tier, expiresAt, env) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Accept-Profile':'public',
        'Content-Profile':'public',
        'Prefer':        'return=representation'
      },
      body: JSON.stringify({
        tier,
        tier_expires_at: expiresAt,
        tier_status: 'canceled' // so app can show "cancels on X date" banner
      })
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase update failed: ${err}`);
  }
  return res.json();
}

/* ─── Log billing event to Supabase billing_events table ─── */
async function logBillingEvent(email, eventType, tier, priceId, env) {
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
      email,
      event_type: eventType,
      tier,
      price_id: priceId,
      created_at: new Date().toISOString()
    })
  });
}

/* ─── Verify Stripe webhook signature ─── */
async function verifyStripeSignature(body, header, secret) {
  if (!header || !secret) throw new Error('Missing signature or secret');

  const parts     = header.split(',');
  const timestamp = parts.find(p => p.startsWith('t=')).split('=')[1];
  const signature = parts.find(p => p.startsWith('v1=')).split('=').slice(1).join('=');

  const signedPayload = `${timestamp}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');

  if (computed !== signature) throw new Error('Signature mismatch');

  // Reject events older than 5 minutes
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp);
  if (age > 300) throw new Error('Timestamp too old');

  return JSON.parse(body);
}
