'use client';

import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/client/api';
import { Button, ErrorText, Hint } from './primitives';
import { Label } from './ui/label';

function applicationKey(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(decoded, char => char.charCodeAt(0));
}

export function NotificationSettings({ accountId, online }: { accountId: string; online: boolean }) {
  const [config, setConfig] = useState<{ enabled: boolean; publicKey: string | null } | null>(null);
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const storageKey = `quasar-push:${accountId}`;
  useEffect(() => {
    let alive = true;
    const supported = window.isSecureContext && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
    setSupported(supported); setEnabled(false); setConfig(null); setError('');
    if (!supported) return;
    setPermission(Notification.permission);
    if (!online) return;
    void Promise.all([api.notifications.config.query(), navigator.serviceWorker.getRegistration('/')]).then(async ([config, registration]) => {
      const subscription = await registration?.pushManager.getSubscription();
      const status = subscription ? await api.notifications.status.mutate({ accountId, endpoint: subscription.endpoint }) : null;
      if (!alive) return;
      setConfig(config);
      setEnabled(status?.subscribed ?? false);
    }).catch(error => { if (alive) setError(errorMessage(error)); });
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
  return <div className="grid gap-2">
    <Label className="text-muted-foreground">Task reminders</Label>
    <Hint>{description}</Hint>
    <ErrorText>{error}</ErrorText>
    {supported && <div><Button size="sm" icon="bell" busy={busy} disabled={!online || (!enabled && (!config?.enabled || permission === 'denied'))} onClick={enabled ? disable : enable}>{enabled ? 'Disable on this browser' : 'Enable browser reminders'}</Button></div>}
  </div>;
}
