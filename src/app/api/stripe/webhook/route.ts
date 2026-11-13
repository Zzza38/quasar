import { BillingService, stripeConfig, WebhookSignatureError } from '@/server/billing';
import { getDb } from '@/server/db';
import { Service } from '@/server/service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Stripe events are a few KB; anything far larger is not one. */
const MAX_BODY_BYTES = 512_000;

/**
 * Stripe's webhook (src/server/billing.ts). Signed with STRIPE_WEBHOOK_SECRET; a bad signature is a 400 and Stripe
 * stops retrying it, while a server error is a 500 so Stripe retries the event later.
 */
export async function POST(request: Request) {
  if (!stripeConfig()) return new Response('Billing is not set up', { status: 404 });
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return new Response('Too large', { status: 413 });
  try {
    const result = new BillingService(new Service(getDb())).webhook(body, request.headers.get('stripe-signature'));
    return Response.json({ received: true, handled: result.handled });
  } catch (error) {
    if (error instanceof WebhookSignatureError) return new Response(error.message, { status: 400 });
    console.error(`[billing] webhook failed: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}`);
    return new Response('Webhook handling failed', { status: 500 });
  }
}
