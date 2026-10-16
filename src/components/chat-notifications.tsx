'use client';

/**
 * The Messages view's notifications nudge (docs/CHAT.md §7): whenever message notifications are effectively off on
 * this device, a warm banner offers to turn them on with the same flow as the account sheet. "Not now" rests it for
 * a day (a timestamp in localStorage, nothing personal, D5), and a bell-off chip in the thread header brings it back.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '@/client/api';
import { enablePush, loadPushSettings, pushSupported, rememberEnrollment, pushStorageKey, type PushServer } from './notification-settings';
import { Button, Callout, Chip, Hint, Modal, Spacer } from './primitives';

const SNOOZE_KEY = 'quasar-chat-nudge-snoozed-until';
const SNOOZE_MS = 24 * 60 * 60_000;

/** Why notifications are off here, or null when they are on (or the server cannot push at all, when a nudge is pointless). */
export type NudgeReason = 'unsupported' | 'denied' | 'permission' | 'unsubscribed' | 'switched-off';

export function nudgeReason({ supported, config, permission, enrolled, chatPush }: { supported: boolean; config: { enabled: boolean } | null; permission: NotificationPermission; enrolled: boolean | null; chatPush: boolean }): NudgeReason | null {
  if (!config?.enabled) return null;
  if (!supported) return 'unsupported';
  if (permission === 'denied') return 'denied';
  if (!chatPush) return 'switched-off';
  if (permission !== 'granted') return 'permission';
  if (enrolled === false) return 'unsubscribed';
  return null;
}

/** Whether "Not now" is still in force at `now`, given the stored timestamp (ms). */
export function snoozed(storedUntil: string | null, now: number): boolean {
  const until = Number(storedUntil);
  return Number.isFinite(until) && until > now;
}

const pushServer: PushServer = {
  config: () => api.notifications.config.query(),
  unsubscribe: (input) => api.notifications.unsubscribe.mutate(input),
  status: (input) => api.notifications.status.mutate(input),
};

/**
 * This device's push state for the account: support, permission, the server's config, and whether the browser is
 * enrolled. `reason` is null while it loads and when everything is on; `enable` runs the full flow from a click.
 */
export function useChatNotifications(accountId: string, online: boolean, chatPush: boolean, onChatPush: (enabled: boolean) => Promise<void>) {
  const [config, setConfig] = useState<{ enabled: boolean; publicKey: string | null } | null>(null);
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [snoozedUntil, setSnoozedUntil] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const supported = pushSupported();

  useEffect(() => {
    try { setSnoozedUntil(localStorage.getItem(SNOOZE_KEY)); } catch { setSnoozedUntil(null); }
  }, []);
  useEffect(() => {
    let alive = true;
    setConfig(null); setEnrolled(null); setError('');
    if (supported) setPermission(Notification.permission);
    if (!online) return;
    void loadPushSettings(accountId, pushServer, supported ? () => navigator.serviceWorker.register('/sw.js') : null, (next) => { if (alive) setConfig(next); })
      .then((endpoint) => { if (alive && endpoint !== undefined) { rememberEnrollment(pushStorageKey(accountId), endpoint); setEnrolled(endpoint !== null); } })
      .catch(() => { if (alive) setEnrolled(false); });
    return () => { alive = false; };
  }, [accountId, online, supported, tick]);

  const reason = online ? nudgeReason({ supported, config, permission, enrolled, chatPush }) : null;
  const hidden = snoozed(snoozedUntil, Date.now());

  const enable = useCallback(async () => {
    if (!config?.publicKey) return;
    setBusy(true); setError('');
    try {
      if (supported && (Notification.permission !== 'granted' || enrolled === false)) {
        const outcome = await enablePush(accountId, config.publicKey);
        setPermission(Notification.permission);
        if (outcome === 'denied') { if (Notification.permission !== 'denied') setError('Notifications were not allowed. Try again and choose Allow.'); return; }
        setEnrolled(true);
      }
      if (!chatPush) await onChatPush(true);
      setTick((count) => count + 1); // Re-check so the banner goes away on the server's say-so, not ours.
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }, [accountId, config, supported, enrolled, chatPush, onChatPush]);

  const snooze = useCallback(() => {
    const until = String(Date.now() + SNOOZE_MS);
    try { localStorage.setItem(SNOOZE_KEY, until); } catch { /* private mode: the banner simply returns next time */ }
    setSnoozedUntil(until);
  }, []);
  const unsnooze = useCallback(() => {
    try { localStorage.removeItem(SNOOZE_KEY); } catch { /* ignore */ }
    setSnoozedUntil(null);
  }, []);

  return { reason, hidden, busy, error, enable, snooze, unsnooze };
}

export type ChatNotifications = ReturnType<typeof useChatNotifications>;

const TITLE = 'You’ll miss replies';
const BODY = 'Message notifications are off on this device.';
const INSTALL = 'On iPhone, open Quasar in Safari, tap Share, then Add to Home Screen, and turn notifications on from the installed app.';

/**
 * The banner. `compact` is the one-line version above a thread's composer. The action is "Turn on", or "How to allow"
 * when the browser has blocked notifications, or the install hint where push is unsupported.
 */
export function NotificationNudge({ nudge, compact = false }: { nudge: ChatNotifications; compact?: boolean }) {
  const [howTo, setHowTo] = useState(false);
  const { reason, hidden } = nudge;
  if (!reason || hidden) return null;
  const action = reason === 'denied'
    ? <Button size="sm" variant="primary" icon="bell" onClick={() => setHowTo(true)}>How to allow</Button>
    : reason === 'unsupported' ? null
      : <Button size="sm" variant="primary" icon="bell" busy={nudge.busy} onClick={() => void nudge.enable()}>Turn on</Button>;
  const notNow = <Button size="sm" variant="ghost" onClick={nudge.snooze}>Not now</Button>;
  return <>
    {compact
      ? <div role="status" className="flex items-center gap-2 rounded-xl bg-muted/70 py-1.5 pr-1.5 pl-3 text-[13px] ring-1 ring-inset ring-foreground/[0.05]">
        <span className="min-w-0 flex-1 truncate"><strong className="font-semibold">{TITLE}.</strong> <span className="text-muted-foreground max-sm:hidden">{reason === 'unsupported' ? 'Install Quasar from Share › Add to Home Screen to get them.' : BODY}</span></span>
        <span className="flex shrink-0 gap-1.5">{action}{notNow}</span>
        {nudge.error && <Hint tone="danger" role="alert" className="basis-full">{nudge.error}</Hint>}
      </div>
      : <Callout tone="neutral" icon="bellOff" role="status" title={TITLE} actions={<>{action}{notNow}</>}>
        {reason === 'unsupported' ? INSTALL : BODY}
        {nudge.error && <Hint tone="danger" role="alert" className="mt-1">{nudge.error}</Hint>}
      </Callout>}
    {howTo && <Modal open onClose={() => setHowTo(false)} title="Allow notifications again" description="This browser has notifications for Quasar blocked. Allowing them is a browser setting, not something Quasar can change."
      footer={<><Spacer /><Button variant="primary" onClick={() => setHowTo(false)}>Done</Button></>}>
      <div className="grid gap-3 text-sm">
        <p><strong className="font-semibold">iPhone or iPad (installed app).</strong> Open Settings, scroll to Quasar, tap Notifications and turn on Allow Notifications.</p>
        <p><strong className="font-semibold">Safari on a Mac.</strong> Safari menu › Settings › Websites › Notifications, find this site and choose Allow.</p>
        <p><strong className="font-semibold">Chrome or Edge.</strong> Tap the lock or tune icon next to the address, open Site settings or Permissions, and set Notifications to Allow. On Android, also check Settings › Apps › Chrome › Notifications.</p>
        <p className="text-muted-foreground">Then come back here and tap Turn on.</p>
      </div>
    </Modal>}
  </>;
}

/** The bell-off chip in a thread header while the banner rests; tapping it brings the banner back. */
export function NotificationNudgeChip({ nudge }: { nudge: ChatNotifications }) {
  if (!nudge.reason || !nudge.hidden) return null;
  return <button type="button" aria-label="Notifications off for this device" title="Notifications off for this device" onClick={nudge.unsnooze} className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <Chip tone="outline" icon="bellOff" className="min-h-6 px-1.5 text-muted-foreground">Off</Chip>
  </button>;
}
