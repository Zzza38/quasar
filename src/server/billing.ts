import { createHmac, timingSafeEqual } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { AI_BETA } from '@/domain/ai';
import { BetaService } from './betas';
import type { Service } from './service';

/**
 * Quasar AI Plus (README "AI task helpers"): a Stripe subscription that raises the daily AI quota on the server's
 * model. The core app and own-key AI stay free. Hidden until STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and
 * STRIPE_PRICE_MONTHLY are set.
 *
 * Stripe is called over its REST API with fetch, and webhook signatures are checked here (HMAC-SHA256 of
 * "<timestamp>.<raw body>"), so there is no SDK dependency. Checkout and the billing portal are Stripe-hosted pages:
 * no card data touches this server. Subscription state comes only from signed webhooks at /api/stripe/webhook.
 */

export type StripeConfig = { secretKey: string; webhookSecret: string; prices: { month: string; year?: string }; origin: string };
export type StripeFetch = (input: string, init: RequestInit) => Promise<Response>;

export function stripeConfig(env: Record<string, string | undefined> = process.env): StripeConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim();
  const month = env.STRIPE_PRICE_MONTHLY?.trim();
  const origin = (env.NEXTAUTH_URL ?? '').trim().replace(/\/+$/, '');
  if (!secretKey || !webhookSecret || !month || !/^https?:\/\//.test(origin)) return null;
  if (!/^(sk|rk)_(test|live)_/.test(secretKey)) throw new Error('STRIPE_SECRET_KEY must be a Stripe secret or restricted key (sk_… or rk_…).');
  if (!webhookSecret.startsWith('whsec_')) throw new Error('STRIPE_WEBHOOK_SECRET must be the endpoint signing secret (whsec_…).');
  const year = env.STRIPE_PRICE_YEARLY?.trim();
  return { secretKey, webhookSecret, prices: { month, ...(year ? { year } : {}) }, origin };
}

const STRIPE_API = 'https://api.stripe.com/v1';
/** Webhooks older than this are refused, so a captured request can't be replayed later. */
export const WEBHOOK_TOLERANCE_S = 300;
/** Plus stays on while a renewal payment is retried (past_due); it ends when Stripe gives up or the member cancels. */
const PLUS_STATUSES = new Set(['active', 'trialing', 'past_due']);
const PRICE_CACHE_MS = 3_600_000;

export const checkoutSchema = z.object({ interval: z.enum(['month', 'year']) });
export class WebhookSignatureError extends Error {}

type Price = { interval: 'month' | 'year'; amount: number | null; currency: string };
type SubscriptionRow = { subscription_id: string; status: string; current_period_end: string | null; cancel_at_period_end: number; event_created: number };
type StripeSubscription = { id: string; customer: string; status: string; cancel_at_period_end?: boolean; current_period_end?: number;
  metadata?: Record<string, string>; items?: { data?: Array<{ price?: { id?: string }; current_period_end?: number }> } };
type StripeEvent = { id: string; type: string; created: number; data: { object: Record<string, unknown> } };

const fail = (code: TRPCError['code'], message: string): never => { throw new TRPCError({ code, message }); };
const priceCache = new Map<string, { at: number; price: Price | null }>();

export class BillingService {
  constructor(
    private readonly service: Service,
    private readonly options: { config?: StripeConfig | null; fetcher?: StripeFetch; now?: () => Date; inBeta?: (userId: string) => boolean } = {},
  ) {}
  private get db() { return this.service.db; }
  private config(): StripeConfig | null { return this.options.config !== undefined ? this.options.config : stripeConfig(); }
  private now(): Date { return this.options.now?.() ?? new Date(); }
  private inBeta(userId: string): boolean {
    return this.options.inBeta ? this.options.inBeta(userId) : new BetaService(this.service).joined(userId).some(beta => beta.key === AI_BETA);
  }

  /** The member's latest subscription, newest period first. */
  private subscription(userId: string): SubscriptionRow | undefined {
    return this.db.prepare(`SELECT subscription_id, status, current_period_end, cancel_at_period_end, event_created FROM billing_subscriptions
      WHERE user_id=? ORDER BY (status IN ('active','trialing','past_due')) DESC, current_period_end DESC LIMIT 1`).get(userId) as SubscriptionRow | undefined;
  }

  /** True while the member has a live Plus subscription. Works without Stripe configured (it reads stored state only). */
  isPlus(userId: string): boolean {
    const row = this.subscription(userId);
    return !!row && PLUS_STATUSES.has(row.status);
  }

  /** What Account → AI shows. Prices come from Stripe, cached for an hour; a failed lookup just leaves the amount out. */
  async status(userId: string) {
    this.service.user(userId);
    const config = this.config();
    if (!config || !this.inBeta(userId)) return { enabled: false as const };
    const row = this.subscription(userId);
    const plus = !!row && PLUS_STATUSES.has(row.status);
    const prices = (await Promise.all((Object.entries(config.prices) as Array<['month' | 'year', string]>).map(([interval, id]) => this.price(config, interval, id)))).filter((price): price is Price => price !== null);
    return {
      enabled: true as const,
      plan: plus ? 'plus' as const : 'free' as const,
      status: row?.status ?? null,
      renewsAt: plus ? row!.current_period_end : null,
      cancelAtPeriodEnd: plus && !!row!.cancel_at_period_end,
      hasCustomer: !!this.customerId(userId),
      prices,
    };
  }

  /** A Stripe Checkout page for Plus. One customer per account, reused across checkouts and the portal. */
  async checkout(userId: string, raw: z.input<typeof checkoutSchema>): Promise<{ url: string }> {
    const user = this.service.user(userId);
    const config = this.ready(userId);
    const { interval } = checkoutSchema.parse(raw);
    const price = config.prices[interval];
    if (!price) fail('BAD_REQUEST', 'That billing period isn’t available.');
    if (this.isPlus(userId)) fail('CONFLICT', 'You already have Plus. Manage it from Account → AI.');
    let customer = this.customerId(userId);
    if (!customer) {
      const created = await this.stripe(config, '/customers', { email: user.email, name: user.fullName || user.displayName || '', 'metadata[user_id]': userId }, `customer-${userId}`) as { id: string };
      customer = created.id;
      this.db.prepare('INSERT OR IGNORE INTO billing_customers(user_id,customer_id,created_at) VALUES(?,?,?)').run(userId, customer, this.now().toISOString());
      customer = this.customerId(userId) ?? customer;
    }
    const session = await this.stripe(config, '/checkout/sessions', {
      mode: 'subscription', customer, client_reference_id: userId,
      'line_items[0][price]': price!, 'line_items[0][quantity]': '1',
      'subscription_data[metadata][user_id]': userId, allow_promotion_codes: 'true',
      success_url: `${config.origin}/tasks?billing=success`, cancel_url: `${config.origin}/tasks?billing=cancel`,
    }) as { url?: string };
    if (!session.url) fail('SERVICE_UNAVAILABLE', 'Stripe didn’t return a checkout page. Try again in a minute.');
    this.service.audit(userId, 'billing.checkout', null, { interval });
    return { url: session.url! };
  }

  /** Stripe's billing portal: change card, switch period, cancel, download receipts. */
  async portal(userId: string): Promise<{ url: string }> {
    this.service.user(userId);
    const config = this.ready(userId);
    const customer = this.customerId(userId);
    if (!customer) fail('BAD_REQUEST', 'There’s no billing account yet. Get Plus first.');
    const session = await this.stripe(config, '/billing_portal/sessions', { customer: customer!, return_url: `${config.origin}/tasks` }) as { url?: string };
    if (!session.url) fail('SERVICE_UNAVAILABLE', 'Stripe didn’t return the billing page. Try again in a minute.');
    return { url: session.url! };
  }

  /**
   * Handles one webhook delivery. The event ID is recorded in the same transaction as its effect, so a retry after a
   * failure runs again and a duplicate delivery does nothing. Throws WebhookSignatureError for anything unsigned.
   */
  webhook(body: string, signature: string | null): { handled: boolean; type: string } {
    const config = this.config();
    if (!config) throw new WebhookSignatureError('Billing is not configured.');
    verifySignature(body, signature, config.webhookSecret, this.now());
    const event = JSON.parse(body) as StripeEvent;
    if (!event?.id || !event.type || !event.data?.object) throw new WebhookSignatureError('Not a Stripe event.');
    return this.db.transaction(() => {
      if (!this.db.prepare('INSERT OR IGNORE INTO stripe_events(id,type,received_at) VALUES(?,?,?)').run(event.id, event.type, this.now().toISOString()).changes) return { handled: false, type: event.type };
      const object = event.data.object;
      if (event.type === 'checkout.session.completed') {
        const userId = typeof object.client_reference_id === 'string' ? object.client_reference_id : null;
        const customer = typeof object.customer === 'string' ? object.customer : null;
        if (userId && customer && this.userExists(userId)) this.db.prepare('INSERT OR IGNORE INTO billing_customers(user_id,customer_id,created_at) VALUES(?,?,?)').run(userId, customer, this.now().toISOString());
      } else if (event.type.startsWith('customer.subscription.')) {
        this.applySubscription(object as unknown as StripeSubscription, event.created, event.type === 'customer.subscription.deleted');
      }
      return { handled: true, type: event.type };
    }).immediate();
  }

  private applySubscription(sub: StripeSubscription, created: number, deleted: boolean): void {
    // The customer mapping decides the account; metadata is only trusted when it agrees or the customer is new to us.
    const mapped = this.db.prepare('SELECT user_id FROM billing_customers WHERE customer_id=?').pluck().get(sub.customer) as string | undefined;
    const claimed = sub.metadata?.user_id;
    const userId = mapped ?? (claimed && this.userExists(claimed) && !this.customerId(claimed) ? claimed : undefined);
    if (!userId) { console.error(`[billing] subscription ${sub.id} has no matching account; ignored`); return; }
    if (!mapped) this.db.prepare('INSERT OR IGNORE INTO billing_customers(user_id,customer_id,created_at) VALUES(?,?,?)').run(userId, sub.customer, this.now().toISOString());
    const existing = this.db.prepare('SELECT event_created FROM billing_subscriptions WHERE subscription_id=?').get(sub.id) as { event_created: number } | undefined;
    if (existing && existing.event_created > created) return;
    // Newer API versions moved the period end onto the subscription item.
    const periodEnd = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
    const was = this.isPlus(userId);
    this.db.prepare(`INSERT INTO billing_subscriptions(subscription_id,user_id,customer_id,price_id,status,current_period_end,cancel_at_period_end,event_created,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(subscription_id) DO UPDATE SET status=excluded.status, price_id=excluded.price_id, current_period_end=excluded.current_period_end,
      cancel_at_period_end=excluded.cancel_at_period_end, event_created=excluded.event_created, updated_at=excluded.updated_at`)
      .run(sub.id, userId, sub.customer, sub.items?.data?.[0]?.price?.id ?? null, deleted ? 'canceled' : sub.status,
        periodEnd ? new Date(periodEnd * 1000).toISOString() : null, sub.cancel_at_period_end ? 1 : 0, created, this.now().toISOString());
    const now = this.isPlus(userId);
    if (was !== now) this.service.audit(userId, now ? 'billing.plusStart' : 'billing.plusEnd', null, { subscription: sub.id, status: deleted ? 'canceled' : sub.status });
  }

  private ready(userId: string): StripeConfig {
    const config = this.config();
    if (!config) return fail('PRECONDITION_FAILED', 'Plus isn’t available on this server.');
    if (!this.inBeta(userId)) fail('FORBIDDEN', 'AI features are in a beta. Join it in Account to use them.');
    return config;
  }
  private customerId(userId: string): string | undefined {
    return this.db.prepare('SELECT customer_id FROM billing_customers WHERE user_id=?').pluck().get(userId) as string | undefined;
  }
  private userExists(userId: string): boolean { return !!this.db.prepare('SELECT 1 FROM users WHERE id=?').get(userId); }

  private async price(config: StripeConfig, interval: 'month' | 'year', id: string): Promise<Price | null> {
    const cached = priceCache.get(id);
    if (cached && Date.now() - cached.at < PRICE_CACHE_MS) return cached.price;
    let price: Price | null = { interval, amount: null, currency: 'usd' };
    try {
      const body = await this.stripe(config, `/prices/${encodeURIComponent(id)}`) as { unit_amount?: number | null; currency?: string };
      price = { interval, amount: body.unit_amount ?? null, currency: body.currency ?? 'usd' };
    } catch { /* Shown without an amount; Checkout still shows the real one. */ }
    priceCache.set(id, { at: Date.now(), price });
    return price;
  }

  /** One Stripe API call: form-encoded POST when there is a body, else GET. Stripe's own error text is logged, not shown. */
  private async stripe(config: StripeConfig, path: string, form?: Record<string, string>, idempotencyKey?: string): Promise<unknown> {
    let response: Response;
    try {
      response = await (this.options.fetcher ?? fetch)(`${STRIPE_API}${path}`, {
        method: form ? 'POST' : 'GET',
        signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${config.secretKey}`, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
        ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      });
    } catch { return fail('SERVICE_UNAVAILABLE', 'Couldn’t reach Stripe. Try again in a minute.'); }
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    if (!response.ok) {
      console.error(`[billing] Stripe ${path.split('/')[1]} returned HTTP ${response.status}: ${payload?.error?.message?.slice(0, 300) ?? ''}`);
      return fail('SERVICE_UNAVAILABLE', 'Stripe couldn’t do that right now. Try again in a minute.');
    }
    return payload;
  }
}

/** Checks a Stripe-Signature header ("t=…,v1=…[,v1=…]") against the raw body. */
export function verifySignature(body: string, header: string | null, secret: string, now: Date = new Date()): void {
  if (!header) throw new WebhookSignatureError('Missing signature.');
  const parts = header.split(',').map(part => part.split('=', 2) as [string, string]);
  const timestamp = Number(parts.find(([key]) => key === 't')?.[1]);
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!Number.isFinite(timestamp) || signatures.length === 0) throw new WebhookSignatureError('Malformed signature.');
  if (Math.abs(now.getTime() / 1000 - timestamp) > WEBHOOK_TOLERANCE_S) throw new WebhookSignatureError('Signature timestamp is too old.');
  const expected = Buffer.from(signWebhook(body, secret, timestamp), 'hex');
  const ok = signatures.some(signature => { const given = Buffer.from(signature, 'hex'); return given.length === expected.length && timingSafeEqual(given, expected); });
  if (!ok) throw new WebhookSignatureError('Signature does not match.');
}
export const signWebhook = (body: string, secret: string, timestamp: number) => createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
