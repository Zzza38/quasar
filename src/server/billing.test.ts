import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { BillingService, WebhookSignatureError, signWebhook, stripeConfig, verifySignature, type StripeConfig, type StripeFetch } from './billing';
import { AiService } from './ai';
import { AI_PLUS_SORT_DAILY_LIMIT, AI_SORT_DAILY_LIMIT } from '@/domain/ai';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const SECRET = 'whsec_test_secret';
const config: StripeConfig = { secretKey: 'sk_test_123', webhookSecret: SECRET, prices: { month: 'price_month', year: 'price_year' }, origin: 'https://quasar.example' };
const NOW = new Date('2026-10-26T15:00:00Z');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function fixture(fetcher: Mock<StripeFetch> = vi.fn<StripeFetch>(), inBeta = true) {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  const user = () => {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, 'Ada', 'Ada Tester', NOW.toISOString());
    return id;
  };
  const billing = new BillingService(service, { config, fetcher, now: () => NOW, inBeta: () => inBeta });
  return { db, service, user, billing, fetcher };
}
/** A webhook delivery as Stripe signs it. */
function deliver(billing: BillingService, event: Record<string, unknown>, at = NOW) {
  const body = JSON.stringify(event);
  const t = Math.floor(at.getTime() / 1000);
  return billing.webhook(body, `t=${t},v1=${signWebhook(body, SECRET, t)}`);
}
const subscriptionEvent = (id: string, type: string, created: number, sub: Record<string, unknown>) =>
  ({ id, type, created, data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', cancel_at_period_end: false, items: { data: [{ price: { id: 'price_month' }, current_period_end: 1_795_000_000 }] }, ...sub } } });

describe('Quasar AI Plus billing', () => {
  it('is off until the Stripe keys, a price and the origin are set, and rejects pasted-in-the-wrong-box keys', () => {
    expect(stripeConfig({})).toBeNull();
    const env = { STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_WEBHOOK_SECRET: 'whsec_1', STRIPE_PRICE_MONTHLY: 'price_1', NEXTAUTH_URL: 'https://getquasarapp.com/' };
    expect(stripeConfig(env)).toEqual({ secretKey: 'sk_test_1', webhookSecret: 'whsec_1', prices: { month: 'price_1' }, origin: 'https://getquasarapp.com' });
    expect(stripeConfig({ ...env, STRIPE_PRICE_YEARLY: 'price_2' })?.prices).toEqual({ month: 'price_1', year: 'price_2' });
    expect(() => stripeConfig({ ...env, STRIPE_SECRET_KEY: 'pk_test_1' })).toThrow('secret');
    expect(() => stripeConfig({ ...env, STRIPE_WEBHOOK_SECRET: 'sk_test_1' })).toThrow('whsec_');
  });

  it('accepts only correctly signed, recent webhooks', () => {
    const body = '{"id":"evt_1"}';
    const t = Math.floor(NOW.getTime() / 1000);
    expect(() => verifySignature(body, `t=${t},v1=${signWebhook(body, SECRET, t)}`, SECRET, NOW)).not.toThrow();
    // Stripe sends several v1 values while a secret is being rolled.
    expect(() => verifySignature(body, `t=${t},v1=${'0'.repeat(64)},v1=${signWebhook(body, SECRET, t)}`, SECRET, NOW)).not.toThrow();
    expect(() => verifySignature(body, null, SECRET, NOW)).toThrow(WebhookSignatureError);
    expect(() => verifySignature(`${body} `, `t=${t},v1=${signWebhook(body, SECRET, t)}`, SECRET, NOW)).toThrow('does not match');
    expect(() => verifySignature(body, `t=${t},v1=${signWebhook(body, 'whsec_other', t)}`, SECRET, NOW)).toThrow('does not match');
    expect(() => verifySignature(body, `t=${t - 301},v1=${signWebhook(body, SECRET, t - 301)}`, SECRET, NOW)).toThrow('too old');
  });

  it('creates one Stripe customer per account and opens Checkout for the chosen period', async () => {
    const fetcher = vi.fn<StripeFetch>()
      .mockResolvedValueOnce(json({ id: 'cus_1' }))
      .mockResolvedValueOnce(json({ url: 'https://checkout.stripe.com/c/1' }))
      .mockResolvedValueOnce(json({ url: 'https://checkout.stripe.com/c/2' }));
    const f = fixture(fetcher);
    const ada = f.user();
    expect(await f.billing.checkout(ada, { interval: 'year' })).toEqual({ url: 'https://checkout.stripe.com/c/1' });
    const [customerUrl, customerInit] = fetcher.mock.calls[0];
    expect(customerUrl).toBe('https://api.stripe.com/v1/customers');
    expect((customerInit.headers as Record<string, string>).authorization).toBe('Bearer sk_test_123');
    expect((customerInit.headers as Record<string, string>)['idempotency-key']).toBe(`customer-${ada}`);
    expect(new URLSearchParams(String(customerInit.body)).get('metadata[user_id]')).toBe(ada);
    const session = new URLSearchParams(String(fetcher.mock.calls[1][1].body));
    expect(Object.fromEntries(session)).toMatchObject({ mode: 'subscription', customer: 'cus_1', client_reference_id: ada, 'line_items[0][price]': 'price_year',
      'subscription_data[metadata][user_id]': ada, success_url: 'https://quasar.example/tasks?billing=success', cancel_url: 'https://quasar.example/tasks?billing=cancel' });
    // A second checkout reuses the customer.
    await f.billing.checkout(ada, { interval: 'month' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[2][0]).toBe('https://api.stripe.com/v1/checkout/sessions');
  });

  it('is only for the ai-tasks beta, and hides Stripe’s error text', async () => {
    const outside = fixture(vi.fn<StripeFetch>(), false);
    const bea = outside.user();
    expect(await outside.billing.status(bea)).toEqual({ enabled: false });
    await expect(outside.billing.checkout(bea, { interval: 'month' })).rejects.toThrow('beta');
    const failing = fixture(vi.fn<StripeFetch>().mockResolvedValue(json({ error: { message: 'No such price: price_month; a similar object exists in live mode' } }, 400)));
    await expect(failing.billing.checkout(failing.user(), { interval: 'month' })).rejects.toThrow('Stripe couldn’t do that right now');
  });

  it('turns Plus on and off from subscription webhooks, once per event and never backwards', async () => {
    const f = fixture(vi.fn<StripeFetch>().mockImplementation(async () => json({ unit_amount: 500, currency: 'usd' })));
    const ada = f.user();
    expect(f.billing.isPlus(ada)).toBe(false);
    expect(deliver(f.billing, { id: 'evt_c', type: 'checkout.session.completed', created: 100, data: { object: { client_reference_id: ada, customer: 'cus_1' } } })).toEqual({ handled: true, type: 'checkout.session.completed' });
    deliver(f.billing, subscriptionEvent('evt_1', 'customer.subscription.created', 101, {}));
    expect(f.billing.isPlus(ada)).toBe(true);
    expect(await f.billing.status(ada)).toMatchObject({ enabled: true, plan: 'plus', status: 'active', cancelAtPeriodEnd: false, renewsAt: new Date(1_795_000_000_000).toISOString(),
      prices: [{ interval: 'month', amount: 500, currency: 'usd' }, { interval: 'year', amount: 500, currency: 'usd' }] });
    // The same event again does nothing; an older event arriving late can't undo a newer one.
    expect(deliver(f.billing, subscriptionEvent('evt_1', 'customer.subscription.created', 101, {})).handled).toBe(false);
    deliver(f.billing, subscriptionEvent('evt_3', 'customer.subscription.updated', 103, { cancel_at_period_end: true }));
    deliver(f.billing, subscriptionEvent('evt_2', 'customer.subscription.updated', 102, { status: 'incomplete' }));
    expect(await f.billing.status(ada)).toMatchObject({ plan: 'plus', cancelAtPeriodEnd: true });
    // A failed renewal keeps Plus while Stripe retries; deletion ends it.
    deliver(f.billing, subscriptionEvent('evt_4', 'customer.subscription.updated', 104, { status: 'past_due' }));
    expect(f.billing.isPlus(ada)).toBe(true);
    deliver(f.billing, subscriptionEvent('evt_5', 'customer.subscription.deleted', 105, { status: 'canceled' }));
    expect(f.billing.isPlus(ada)).toBe(false);
    const audit = f.db.prepare("SELECT action FROM audit_log WHERE actor_id=? AND action LIKE 'billing.%' ORDER BY rowid").pluck().all(ada);
    expect(audit).toEqual(['billing.plusStart', 'billing.plusEnd']);
  });

  it('never lets subscription metadata move Plus onto another account', () => {
    const f = fixture();
    const ada = f.user(), eve = f.user();
    deliver(f.billing, { id: 'evt_c', type: 'checkout.session.completed', created: 100, data: { object: { client_reference_id: ada, customer: 'cus_1' } } });
    deliver(f.billing, subscriptionEvent('evt_1', 'customer.subscription.created', 101, { metadata: { user_id: eve } }));
    expect(f.billing.isPlus(ada)).toBe(true);
    expect(f.billing.isPlus(eve)).toBe(false);
    // A subscription for a customer nobody knows, naming no real account, is ignored.
    deliver(f.billing, subscriptionEvent('evt_2', 'customer.subscription.created', 102, { id: 'sub_2', customer: 'cus_9', metadata: { user_id: 'nobody' } }));
    expect(f.db.prepare("SELECT count(*) FROM billing_subscriptions WHERE subscription_id='sub_2'").pluck().get()).toBe(0);
    expect(() => f.billing.webhook('{"id":"evt_x"}', 't=1,v1=00')).toThrow(WebhookSignatureError);
  });

  it('raises the AI daily quota for Plus members', () => {
    const f = fixture();
    const ada = f.user();
    const ai = (plus: boolean) => new AiService(f.service, { config: { url: 'https://ai.example/v1', key: '', model: 'm', json: true, openRouter: false }, inBeta: () => true, codex: null, plus: () => plus, billing: true });
    expect(ai(false).status(ada)).toMatchObject({ plan: 'free', quota: { sort: { limit: AI_SORT_DAILY_LIMIT } } });
    expect(ai(true).status(ada)).toMatchObject({ plan: 'plus', quota: { sort: { limit: AI_PLUS_SORT_DAILY_LIMIT } } });
  });
});
