'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import { effectiveSchedule } from '@/domain/schedule';
import type { ImportSummary } from '@/domain/schedule-import';
import type { AppState } from './app-state';
import { Icon } from './icon';
import { Button, Callout, Chip, ErrorText, Field, Hint, Input, Modal, Panel, Spacer } from './primitives';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';

/** Where a student finds their Veracross class schedule link. Schools rename the menus a little, so each step names the alternatives. */
export const VERACROSS_STEPS: ReactNode[] = [
  <>Open your school’s <b>Veracross portal</b> in a web browser on a laptop, not the app. Sign in the way your school does.</>,
  <>Click <b>Calendar</b> in the top menu, then <b>Calendar Subscriptions</b>. Some schools call it <b>My Calendar Subscriptions</b> or put a <b>Subscribe</b> button on the calendar page.</>,
  <>If <b>Subscribe using Google Calendar</b> is ticked, untick it.</>,
  <>Find your <b>Class Schedule</b>, not Class Assignments. Right-click its <b>Subscribe</b> button and choose <b>Copy Link</b>. On a phone, press and hold it instead.</>,
  <>Paste the link below. It starts with <code>webcal://</code> or <code>https://</code>.</>,
];

/** One line about what a sync did, such as "6 classes in 7 blocks. Added Biology and US History." */
export function describeImport(summary: ImportSummary): string {
  const parts = [`${summary.classes} ${summary.classes === 1 ? 'class' : 'classes'} in ${summary.blocks} ${summary.blocks === 1 ? 'block' : 'blocks'}.`];
  if (summary.added.length) parts.push(`Added ${summary.added.length > 3 ? `${summary.added.slice(0, 3).join(', ')} and ${summary.added.length - 3} more` : summary.added.join(summary.added.length === 2 ? ' and ' : ', ')}.`);
  if (summary.cleared) parts.push(`Cleared ${summary.cleared} free ${summary.cleared === 1 ? 'block' : 'blocks'}.`);
  if (summary.kept) parts.push(`Kept your own choice in ${summary.kept} ${summary.kept === 1 ? 'block' : 'blocks'}.`);
  return parts.join(' ');
}

type Preview = RouterOutput['scheduleFeed']['preview'];

/**
 * Paste a Veracross class schedule link, review where each class would go, then confirm. Nothing is saved until the
 * student confirms; unticked classes stay out of later daily syncs too.
 */
export function ConnectScheduleFeedSheet({ open, onClose, state }: { open: boolean; onClose: () => void; state: AppState }) {
  const [url, setUrl] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [done, setDone] = useState<ImportSummary | null>(null);
  useEffect(() => { if (!open) { setUrl(''); setError(''); setPreview(null); setIncluded({}); setDone(null); } }, [open]);
  const schedule = effectiveSchedule(state.schedule, state.personal);
  const label = (periodId: string) => schedule.periods.find(period => period.id === periodId)?.label ?? periodId;
  const run = async (action: () => Promise<void>) => {
    if (!state.online || pending) return;
    setPending(true); setError('');
    try { await action(); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
  };
  const check = () => run(async () => {
    if (!url.trim()) return;
    const result = await api.scheduleFeed.preview.mutate({ accountId: state.context.user.id, source: 'veracross', url: url.trim() });
    setPreview(result);
    setIncluded(Object.fromEntries(result.rows.map(row => [row.key, row.included])));
  });
  const confirm = () => run(async () => {
    const status = await api.scheduleFeed.connect.mutate({ accountId: state.context.user.id, source: 'veracross', url: url.trim(), choices: included });
    await state.refresh();
    setDone(status.summary);
  });
  const chosen = preview?.rows.filter(row => included[row.key]) ?? [];

  if (done) return <Modal open={open} onClose={onClose} title="Timetable filled" footer={<><Spacer /><Button variant="primary" onClick={onClose}>Done</Button></>}>
    <Callout tone="success" icon="check" role="status">{describeImport(done)}</Callout>
    <Hint>Quasar checks Veracross once a day. If you move a class to another block yourself, your choice stays.</Hint>
  </Modal>;

  if (preview) return <Modal open={open} onClose={onClose} wide dirty busy={pending} title="Check your classes" description="Quasar matched each class to the block it meets in on most days. Untick anything that is not a real class."
    footer={<><Button variant="ghost" disabled={pending} onClick={() => { setPreview(null); setError(''); }}>Back</Button><Spacer />
      <Button variant="primary" icon="check" busy={pending} disabled={!state.online || chosen.length === 0} onClick={() => void confirm()}>Add {chosen.length} {chosen.length === 1 ? 'class' : 'classes'}</Button></>}>
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    <ul className="grid gap-2" aria-label="Classes from Veracross">
      {preview.rows.map(row => {
        const on = !!included[row.key];
        const id = `schedule-feed-include-${row.key.replace(/[^a-z0-9]+/g, '-')}`;
        return <li key={row.key} className={on ? 'grid gap-2 rounded-2xl bg-muted/60 p-3 ring-1 ring-inset ring-foreground/[0.04]' : 'grid gap-2 rounded-2xl p-3 opacity-60 ring-1 ring-inset ring-foreground/[0.06]'}>
          <div className="flex items-start gap-3">
            <Checkbox id={id} className="mt-0.5" checked={on} disabled={pending} onCheckedChange={checked => setIncluded(current => ({ ...current, [row.key]: checked === true }))} />
            <div className="grid min-w-0 flex-1 gap-1">
              <Label htmlFor={id} className="text-sm font-bold break-words">{row.name}</Label>
              <Hint>{[row.room, `${row.meetings} ${row.meetings === 1 ? 'meeting' : 'meetings'} checked`, row.existing ? 'uses your saved class' : 'new class'].filter(Boolean).join(' · ')}</Hint>
            </div>
            <div className="flex flex-wrap justify-end gap-1.5">{row.periodIds.map(periodId => <Chip key={periodId} tone="accent">{label(periodId)}</Chip>)}</div>
          </div>
          {on && row.replaces.length > 0 && <Hint tone="danger">Replaces {row.replaces.map(entry => `${entry.name} in ${label(entry.periodId)}`).join(', ')}.</Hint>}
          {on && row.kept.length > 0 && <Hint>You moved another class into {row.kept.map(label).join(', ')} before. That stays.</Hint>}
        </li>;
      })}
    </ul>
    {preview.unsettledPeriodIds.length > 0 && <Hint><Icon name="info" size={12} className="mr-1 inline" />Quasar could not tell which class meets in {preview.unsettledPeriodIds.map(label).join(', ')}, so {preview.unsettledPeriodIds.length === 1 ? 'it stays' : 'they stay'} as {preview.unsettledPeriodIds.length === 1 ? 'it is' : 'they are'}.</Hint>}
  </Modal>;

  return <Modal open={open} onClose={onClose} wide dirty={url.trim() !== ''} busy={pending} title="Connect Veracross" description="Quasar reads your class schedule from Veracross and puts each class in the block it meets in. You check the result before anything is saved. Assignments and school events are not imported."
    footer={<><Button variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button><Spacer /><Button type="submit" form="schedule-feed-form" variant="primary" icon="search" busy={pending} disabled={!state.online || !url.trim()}>Find my classes</Button></>}>
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Panel className="grid gap-2">
        <strong className="text-sm font-bold">Where to find the link</strong>
        <ol className="grid list-decimal gap-1.5 pl-5 text-[13px] text-muted-foreground marker:font-bold marker:text-foreground/60">
          {VERACROSS_STEPS.map((step, index) => <li key={index} className="pl-1">{step}</li>)}
        </ol>
        <Hint><Icon name="info" size={12} className="mr-1 inline" />If you don’t see Calendar Subscriptions, your school may have turned it off. Ask the tech office.</Hint>
      </Panel>
      <form id="schedule-feed-form" className="grid content-start gap-4" onSubmit={(event) => { event.preventDefault(); void check(); }}>
        <Field label="Class Schedule link" htmlFor="schedule-feed-url" hint="It is private, is stored encrypted, and is never shown again after saving.">
          <Input id="schedule-feed-url" type="text" inputMode="url" autoComplete="off" spellCheck={false} required autoFocus maxLength={4000} value={url} disabled={pending} onChange={(event) => setUrl(event.target.value)} placeholder="webcal://…" />
        </Field>
        <Hint>Quasar looks at when each class meets over several weeks and matches it to your school’s blocks and bell times. Classes you already have with the same name are reused, with their colors.</Hint>
        {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
        {!state.online && <ErrorText>Connect to the internet to connect Veracross.</ErrorText>}
      </form>
    </div>
  </Modal>;
}

/** The connected class schedule on the Classes page: when it last synced, what it did, Sync now and Disconnect. */
export function ScheduleFeedPanel({ state }: { state: AppState }) {
  const feed = state.context.scheduleFeed ?? null;
  const [pending, setPending] = useState<'sync' | 'disconnect' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  if (!feed) return null;
  const run = async (kind: 'sync' | 'disconnect', action: () => Promise<unknown>) => {
    setPending(kind); setError('');
    try { await action(); setConfirming(false); } catch (err) { setError(errorMessage(err)); }
    // A failed sync is stored with the feed, so refresh either way to show it.
    try { await state.refresh(); } catch { /* the error above, if any, is already shown */ }
    setPending(null);
  };
  const stamp = (value: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: state.timeZone }).format(new Date(value));
  const accountId = state.context.user.id;
  return <Panel className="grid gap-2">
    <div className="flex flex-wrap items-start gap-3">
      <span aria-hidden="true" className={`grid size-9 shrink-0 place-items-center rounded-xl ${feed.lastError ? 'bg-warning-soft text-warning' : 'bg-primary-soft text-primary-soft-foreground'}`}><Icon name="refresh" size={16} /></span>
      <div className="grid min-w-0 flex-1 basis-[220px] gap-1 text-sm">
        <div className="flex flex-wrap items-center gap-1.5"><strong>Synced from Veracross</strong>{feed.lastError && <Chip tone="warning" icon="alert">Sync failed</Chip>}</div>
        {feed.summary && <Hint>{describeImport(feed.summary)}</Hint>}
        <Hint>{feed.lastSuccessAt ? `Last synced ${stamp(feed.lastSuccessAt)}` : 'Not synced yet'} · Next check {stamp(feed.nextRefreshAt)}</Hint>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" icon="refresh" busy={pending === 'sync'} disabled={!state.online || pending !== null} onClick={() => void run('sync', () => api.scheduleFeed.sync.mutate({ accountId }))}>Sync now</Button>
        <Button size="sm" variant="ghost" disabled={!state.online || pending !== null || confirming} onClick={() => setConfirming(true)}>Disconnect</Button>
      </div>
    </div>
    {feed.lastError && !error && <p className="text-sm text-destructive">{feed.lastError}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {confirming && <Callout tone="warning" icon="alert" role="alert" title="Disconnect Veracross?" actions={<>
      <Button size="sm" variant="danger" busy={pending === 'disconnect'} disabled={!state.online || pending !== null} onClick={() => void run('disconnect', () => api.scheduleFeed.disconnect.mutate({ accountId }))}>Disconnect</Button>
      <Button size="sm" autoFocus disabled={pending !== null} onClick={() => setConfirming(false)}>Keep syncing</Button>
    </>}>Your classes and blocks stay as they are. Quasar stops checking Veracross for changes.</Callout>}
  </Panel>;
}
