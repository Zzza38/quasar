import { describe, expect, it, vi } from 'vitest';
import { loadPushSettings, rememberEnrollment, reminderPanel, type PushServer } from './notification-settings';

const KEY = new Uint8Array([4, 1, 2, 3]);
const OLD_KEY = new Uint8Array([4, 9, 9, 9]);
const publicKey = btoa(String.fromCharCode(...KEY)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function server(overrides: Partial<PushServer> = {}): PushServer {
  return {
    config: vi.fn(async () => ({ enabled: true, publicKey })),
    unsubscribe: vi.fn(async () => undefined),
    status: vi.fn(async () => ({ subscribed: true })),
    ...overrides,
  };
}

function registration(key: Uint8Array | null) {
  const subscription = key && { endpoint: 'https://push.example/abc', options: { applicationServerKey: key.slice().buffer, userVisibleOnly: true }, unsubscribe: vi.fn(async () => true) };
  return { subscription, register: async () => ({ pushManager: { getSubscription: async () => subscription } }) };
}

describe('loading push settings', () => {
  it('shows the account-wide config even when registering the worker fails', async () => {
    const onConfig = vi.fn();
    await expect(loadPushSettings('a', server(), async () => { throw new DOMException('denied', 'SecurityError'); }, onConfig)).rejects.toThrow('denied');
    expect(onConfig).toHaveBeenCalledWith({ enabled: true, publicKey });
  });

  it('shows the config even when the status check fails', async () => {
    const onConfig = vi.fn();
    const fails = server({ status: async () => { throw new Error('503'); } });
    await expect(loadPushSettings('a', fails, registration(KEY).register, onConfig)).rejects.toThrow('503');
    expect(onConfig).toHaveBeenCalledOnce();
  });

  it('loads the config without push where the browser cannot receive it', async () => {
    const onConfig = vi.fn();
    const api = server();
    expect(await loadPushSettings('a', api, null, onConfig)).toBeUndefined();
    expect(onConfig).toHaveBeenCalledOnce();
    expect(api.status).not.toHaveBeenCalled();
  });

  it('reports the enrolled endpoint only when the server still has it for this account', async () => {
    expect(await loadPushSettings('a', server(), registration(KEY).register, () => {})).toBe('https://push.example/abc');
    expect(await loadPushSettings('a', server({ status: async () => ({ subscribed: false }) }), registration(KEY).register, () => {})).toBeNull();
    expect(await loadPushSettings('a', server(), registration(null).register, () => {})).toBeNull();
  });

  it('drops a subscription made with an old server key and reports none', async () => {
    const api = server();
    const stale = registration(OLD_KEY);
    expect(await loadPushSettings('a', api, stale.register, () => {})).toBeNull();
    expect(api.unsubscribe).toHaveBeenCalledWith({ accountId: 'a', endpoint: 'https://push.example/abc' });
    expect(stale.subscription?.unsubscribe).toHaveBeenCalled();
    expect(api.status).not.toHaveBeenCalled();
  });
});

describe('remembering enrollment for the setup checklist', () => {
  function storage() {
    const items = new Map<string, string>();
    return { items, get: () => ({ setItem: (key: string, value: string) => void items.set(key, value), removeItem: (key: string) => void items.delete(key) }) };
  }

  it('clears the flag when the server no longer has this browser enrolled', () => {
    const store = storage();
    store.items.set('quasar-push:a', 'https://push.example/abc');
    rememberEnrollment('quasar-push:a', null, store.get);
    expect(store.items.has('quasar-push:a')).toBe(false);
  });

  it('sets the flag when the server reports this browser enrolled', () => {
    const store = storage();
    rememberEnrollment('quasar-push:a', 'https://push.example/abc', store.get);
    expect(store.items.get('quasar-push:a')).toBe('https://push.example/abc');
  });

  it('ignores storage that is unavailable', () => {
    expect(() => rememberEnrollment('quasar-push:a', null, () => { throw new Error('private mode'); })).not.toThrow();
  });
});

describe('the reminder panel while the enrollment check runs', () => {
  const ready = { supported: true, online: true, permission: 'default' as NotificationPermission, config: { enabled: true, publicKey }, enabled: false };

  it('keeps saying it is checking, with the button held, after the config arrives but before the check settles', () => {
    const panel = reminderPanel({ ...ready, checking: true });
    expect(panel.description).toBe('Checking browser reminders…');
    expect(panel.disabled).toBe(true);
  });

  it('offers enabling only once the check has settled', () => {
    const panel = reminderPanel({ ...ready, checking: false });
    expect(panel.description).toMatch(/^Enable reminders on this browser/);
    expect(panel.disabled).toBe(false);
  });

  it('lets an enrolled browser disable once checked, and not before', () => {
    expect(reminderPanel({ ...ready, enabled: true, checking: false }).disabled).toBe(false);
    expect(reminderPanel({ ...ready, enabled: true, checking: true }).disabled).toBe(true);
  });
});
