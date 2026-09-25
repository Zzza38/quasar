'use client';

import { useEffect, useState } from 'react';
import { serviceWorkerEnabled } from '@/client/service-worker-support';
import { api, errorMessage } from '@/client/api';
import { Icon } from './icon';
import { Button, ErrorText, Hint, Toggle } from './primitives';
import { Label } from './ui/label';

function applicationKey(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(decoded, char => char.charCodeAt(0));
}

function sameKey(subscription: Pick<PushSubscription, 'options'>, key: Uint8Array): boolean {
  const current = subscription.options.applicationServerKey;
  if (!current) return true;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((byte, i) => byte === key[i]);
}

type PushConfig = { enabled: boolean; publicKey: string | null };
type PushRegistration = { pushManager: { getSubscription(): Promise<Pick<PushSubscription, 'endpoint' | 'options' | 'unsubscribe'> | null> } };
export type PushServer = {
  config(): Promise<PushConfig>;
  unsubscribe(input: { accountId: string; endpoint: string }): Promise<unknown>;
  status(input: { accountId: string; endpoint: string }): Promise<{ subscribed: boolean }>;
};
const pushServer: PushServer = {
  config: () => api.notifications.config.query(),
  unsubscribe: input => api.notifications.unsubscribe.mutate(input),
  status: input => api.notifications.status.mutate(input),
};

/**
 * Loads the account-wide push config, then this browser's enrollment. The config goes to `onConfig` as soon as it
 * arrives, so a failing browser step (registering the worker, a stale-key cleanup, the status check) never hides the
 * account-wide chat switch. Resolves to the endpoint the server has enrolled for this account, null when it has none,
 * or undefined when this browser cannot push (`register` is null).
 */
export async function loadPushSettings(accountId: string, server: PushServer, register: (() => Promise<PushRegistration>) | null, onConfig: (config: PushConfig) => void): Promise<string | null | undefined> {
  // Sign-in already registered the worker for offline use; repeating it alongside the config query is a no-op that
  // warms it up, so enabling later needs no wait. Its failure is reported below, only after the config is shown.
  const registering = register ? Promise.resolve().then(register) : null;
  registering?.catch(() => undefined);
  const config = await server.config();
  onConfig(config);
  if (!registering) return undefined;
  const registration = await registering;
  let subscription = await registration.pushManager.getSubscription();
  // A subscription made with a previous server key cannot be reused. Drop it now, outside the click, so
  // enabling later needs no extra network round-trips before the browser prompt.
  if (subscription && config.publicKey && !sameKey(subscription, applicationKey(config.publicKey))) {
    await server.unsubscribe({ accountId, endpoint: subscription.endpoint });
    await subscription.unsubscribe(); subscription = null;
  }
  if (!subscription) return null;
  return (await server.status({ accountId, endpoint: subscription.endpoint })).subscribed ? subscription.endpoint : null;
}

/**
 * The setup checklist reads `quasar-push:<account>` to tick "Turn on reminders", so it follows what the server
 * reports: a browser dropped after a 410, taken over by another account or reset by a key change clears it.
 */
export function rememberEnrollment(key: string, endpoint: string | null, storage: () => Pick<Storage, 'setItem' | 'removeItem'> = () => localStorage): void {
  try {
    if (endpoint) storage().setItem(key, endpoint);
    else storage().removeItem(key);
  } catch { /* private mode */ }
}

/**
 * The reminder panel's hint and whether its button responds. Until this browser's enrollment check settles
 * (`checking`), the panel says so and the button stays put: enabling mid-check would race the stale-key cleanup and
 * the status answer, which would then overwrite what the click just enrolled.
 */
export function reminderPanel({ supported, online, permission, config, checking, enabled }: { supported: boolean; online: boolean; permission: NotificationPermission; config: PushConfig | null; checking: boolean; enabled: boolean }): { description: string; disabled: boolean } {
  const description = !supported ? 'Browser reminders are unavailable here. On iPhone or iPad, add Quasar to your Home Screen and open it there.'
    : !online ? 'Connect to the internet to manage browser reminders.'
    : permission === 'denied' ? 'Notifications are blocked. Allow them in your browser’s site settings, then reopen this menu.'
    : !config || checking ? 'Checking browser reminders…'
    : !config.enabled ? 'Browser reminders need to be configured on the server.'
    : enabled ? 'Reminders are enabled on this browser. Choose a reminder when editing a task. Delivery depends on your browser and connection; on a Mac, also make sure this browser is allowed under System Settings › Notifications.'
    : 'Enable reminders on this browser, then choose a reminder when editing a task. Task details stay hidden in notifications.';
  return { description, disabled: !online || checking || (!enabled && (!config?.enabled || permission === 'denied')) };
}

// Registration normally happened at sign-in for offline use; registering again
// is a no-op. Waiting on `ready` alone can hang forever if activation fails.
async function readyRegistration(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.register('/sw.js');
  if (registration.active) return registration;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Reminder setup did not finish. Reload and try again.')), 15_000);
    navigator.serviceWorker.ready.then(value => { clearTimeout(timer); resolve(value); }, reject);
  });
}

export function NotificationSettings({ accountId, online, chatPush, onChatPush }: { accountId: string; online: boolean; chatPush: boolean; onChatPush: (enabled: boolean) => Promise<void> }) {
  const [config, setConfig] = useState<{ enabled: boolean; publicKey: string | null } | null>(null);
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [enabled, setEnabled] = useState(false);
  // True while this browser's enrollment check runs; the config (and chat switch) can arrive before it settles.
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The account-wide chat switch: the student's choice shows at once and stays until the workspace catches up.
  const [chatChoice, setChatChoice] = useState<boolean | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState('');
  useEffect(() => { if (chatChoice !== null && chatChoice === chatPush && !chatBusy) setChatChoice(null); }, [chatChoice, chatPush, chatBusy]);
  const storageKey = `quasar-push:${accountId}`;
  // The server's push setup is kept while offline (the chat switch then shows as disabled); another account starts over.
  useEffect(() => { setConfig(null); setChatChoice(null); setChatError(''); }, [accountId]);
  useEffect(() => {
    let alive = true;
    const supported = serviceWorkerEnabled && window.isSecureContext && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
    setSupported(supported); setEnabled(false); setError(''); setChecking(online && supported);
    if (supported) setPermission(Notification.permission);
    if (!online) return;
    // The server config is account-wide (it drives the chat switch), so it loads even where this browser cannot push.
    void loadPushSettings(accountId, pushServer, supported ? () => navigator.serviceWorker.register('/sw.js') : null, config => { if (alive) setConfig(config); })
      .then(endpoint => {
        if (!alive || endpoint === undefined) return;
        rememberEnrollment(storageKey, endpoint);
        setEnabled(endpoint !== null);
      })
      .catch(error => { if (alive) setError(errorMessage(error)); })
      .finally(() => { if (alive) setChecking(false); });
    return () => { alive = false; };
  }, [accountId, online, storageKey]);

  async function enable() {
    if (!config?.publicKey) return;
    setBusy(true); setError('');
    try {
      const registration = await readyRegistration();
      // Safari only allows subscribing while the click's user activation is
      // still live, and a separate Notification.requestPermission() call
      // consumes it. subscribe() shows the permission prompt itself in every
      // browser, so it is the first and only prompting step.
      let subscription = await registration.pushManager.getSubscription();
      try {
        subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationKey(config.publicKey) });
      } catch (error) {
        setPermission(Notification.permission);
        if (error instanceof DOMException && error.name === 'NotAllowedError') {
          if (Notification.permission !== 'denied') setError('Notifications were not allowed. Try again and choose Allow.');
          return;
        }
        throw error;
      }
      setPermission(Notification.permission);
      const data = subscription.toJSON();
      if (!data.keys?.p256dh || !data.keys?.auth) throw new Error('The browser did not provide push credentials');
      await api.notifications.subscribe.mutate({ accountId, endpoint: subscription.endpoint, keys: { p256dh: data.keys.p256dh, auth: data.keys.auth } });
      localStorage.setItem(storageKey, subscription.endpoint);
      setEnabled(true);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  async function changeChatPush(next: boolean) {
    setChatBusy(true); setChatError(''); setChatChoice(next);
    try { await onChatPush(next); }
    catch (error) { setChatChoice(null); setChatError(errorMessage(error)); }
    finally { setChatBusy(false); }
  }
  async function disable() {
    setBusy(true); setError('');
    try {
      const registration = await navigator.serviceWorker.getRegistration('/');
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await api.notifications.unsubscribe.mutate({ accountId, endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
      localStorage.removeItem(storageKey); setEnabled(false);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  const { description, disabled } = reminderPanel({ supported, online, permission, config, checking, enabled });
  return <div className="grid gap-2 rounded-2xl bg-muted/70 p-4 ring-1 ring-inset ring-foreground/[0.04]">
    <Label className="flex items-center gap-2 text-[13px] font-semibold text-foreground/80"><span className={`grid size-7 place-items-center rounded-lg ${enabled ? 'bg-success-soft text-success' : 'bg-secondary text-secondary-foreground'}`}><Icon name="bell" size={14} /></span>Task reminders{enabled && <span className="text-xs font-bold text-success">· On</span>}</Label>
    <Hint>{description}</Hint>
    <ErrorText>{error}</ErrorText>
    {supported && <div><Button size="sm" icon="bell" busy={busy} disabled={disabled} onClick={enabled ? disable : enable}>{enabled ? 'Disable on this browser' : 'Enable browser reminders'}</Button></div>}
    {/* Chat pushes reach browsers enrolled for reminders; the switch is account-wide, so it shows wherever the server has push set up. */}
    {config?.enabled && <div className="mt-2 grid gap-2 border-t border-foreground/[0.06] pt-3">
      <Toggle label="Message notifications" description="Uses this browser’s reminder alerts. Never shows names or messages."
        checked={chatChoice ?? chatPush} disabled={!online || chatBusy} onChange={(next) => void changeChatPush(next)} />
      <ErrorText>{chatError}</ErrorText>
    </div>}
  </div>;
}
