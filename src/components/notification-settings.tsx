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

export function NotificationSettings({ accountId, online, chatPush, onChatPush }: { accountId: string; online: boolean; chatPush: boolean; onChatPush: (enabled: boolean) => Promise<void> }) {
  const [config, setConfig] = useState<{ enabled: boolean; publicKey: string | null } | null>(null);
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [enabled, setEnabled] = useState(false);
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
    setSupported(supported); setEnabled(false); setError('');
    if (supported) setPermission(Notification.permission);
    if (!online) return;
    // The server config is account-wide (it drives the chat switch), so it loads even where this browser cannot push.
    void (async () => {
      const config = await api.notifications.config.query();
      let subscribed = false;
      if (supported) {
        const registration = await navigator.serviceWorker.getRegistration('/');
        const subscription = await registration?.pushManager.getSubscription();
        subscribed = subscription ? (await api.notifications.status.mutate({ accountId, endpoint: subscription.endpoint })).subscribed : false;
      }
      if (!alive) return;
      setConfig(config);
      setEnabled(subscribed);
    })().catch(error => { if (alive) setError(errorMessage(error)); });
    return () => { alive = false; };
  }, [accountId, online, storageKey]);

  async function enable() {
    if (!config?.publicKey) return;
    setBusy(true); setError('');
    try {
      // Permission is requested directly from the user's button gesture.
      const permission = await Notification.requestPermission();
      setPermission(permission);
      if (permission !== 'granted') return;
      await navigator.serviceWorker.register('/sw.js');
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      const key = applicationKey(config.publicKey);
      if (subscription?.options.applicationServerKey && new Uint8Array(subscription.options.applicationServerKey).some((byte, i) => byte !== key[i])) {
        await api.notifications.unsubscribe.mutate({ accountId, endpoint: subscription.endpoint });
        await subscription.unsubscribe(); subscription = null;
      }
      subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
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
  const description = !supported ? 'Browser reminders are unavailable here. On iPhone or iPad, add Quasar to your Home Screen and open it there.'
    : !online ? 'Connect to the internet to manage browser reminders.'
    : permission === 'denied' ? 'Notifications are blocked. Allow them in your browser’s site settings, then reopen this menu.'
    : !config ? 'Checking browser reminders…'
    : !config.enabled ? 'Browser reminders need to be configured on the server.'
    : enabled ? 'Reminders are enabled on this browser. Choose a reminder when editing a task. Delivery depends on your browser and connection.'
    : 'Enable reminders on this browser, then choose a reminder when editing a task. Task details stay hidden in notifications.';
  return <div className="grid gap-2 rounded-2xl bg-muted/70 p-4 ring-1 ring-inset ring-foreground/[0.04]">
    <Label className="flex items-center gap-2 text-[13px] font-semibold text-foreground/80"><span className={`grid size-7 place-items-center rounded-lg ${enabled ? 'bg-success-soft text-success' : 'bg-secondary text-secondary-foreground'}`}><Icon name="bell" size={14} /></span>Task reminders{enabled && <span className="text-xs font-bold text-success">· On</span>}</Label>
    <Hint>{description}</Hint>
    <ErrorText>{error}</ErrorText>
    {supported && <div><Button size="sm" icon="bell" busy={busy} disabled={!online || (!enabled && (!config?.enabled || permission === 'denied'))} onClick={enabled ? disable : enable}>{enabled ? 'Disable on this browser' : 'Enable browser reminders'}</Button></div>}
    {/* Chat pushes reach browsers enrolled for reminders; the switch is account-wide, so it shows wherever the server has push set up. */}
    {config?.enabled && <div className="mt-2 grid gap-2 border-t border-foreground/[0.06] pt-3">
      <Toggle label="Message notifications" description="Uses this browser’s reminder alerts. Never shows names or messages."
        checked={chatChoice ?? chatPush} disabled={!online || chatBusy} onChange={(next) => void changeChatPush(next)} />
      <ErrorText>{chatError}</ErrorText>
    </div>}
  </div>;
}
