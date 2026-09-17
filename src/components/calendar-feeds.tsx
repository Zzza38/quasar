'use client';

import { useState } from 'react';
import { api, errorMessage } from '@/client/api';
import { browserTimeZone } from '@/lib/format';
import type { AppState } from './app-state';
import { Button, Callout, Chip, ErrorText, Field, Hint, Input, Modal, Section } from './primitives';

export function CalendarFeeds({ state }: { state: AppState }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [timeZone, setTimeZone] = useState(browserTimeZone);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const subscriptions = state.context.subscriptions ?? [];
  const run = async (id: string, action: () => Promise<unknown>) => {
    setPending(id); setError('');
    try { await action(); await state.refresh(); }
    catch (err) { setError(errorMessage(err)); }
    finally { setPending(null); }
  };
  const stamp = (value: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: state.timeZone }).format(new Date(value));
  return <Section id="calendar-feeds-title" title="Connected calendars" action={<Button size="sm" icon="plus" disabled={!state.online || pending !== null} onClick={() => { setError(''); setTimeZone(browserTimeZone()); setAdding(true); }}>Add calendar</Button>}>
    {!state.online && <Hint>Connect to the internet to manage calendars. Saved events are still available offline.</Hint>}
    {(state.context.importConflicts ?? []).map((conflict) => {
      const local = state.snapshot.entities.find((entry) => entry.id === conflict.entityId)?.data;
      const labels: Record<string, string> = { title: 'Title', notes: 'Notes', dueDate: 'Due date', dueTime: 'Due time' };
      const incoming = conflict.incoming as Record<string, unknown>;
      return <Callout key={conflict.entityId} tone="warning" icon="alert" title={`Calendar changes: ${String(local?.title ?? incoming.title ?? 'Imported item')}`} actions={<>
        <Button size="sm" disabled={!state.online || pending !== null} onClick={() => void run(`resolve:${conflict.entityId}`, () => api.calendar.resolve.mutate({ accountId: state.context.user.id, entityId: conflict.entityId, expectedVersion: conflict.version, choice: 'local' }))}>Keep my edits</Button>
        <Button size="sm" variant="primary" disabled={!state.online || pending !== null} onClick={() => void run(`resolve:${conflict.entityId}`, () => api.calendar.resolve.mutate({ accountId: state.context.user.id, entityId: conflict.entityId, expectedVersion: conflict.version, choice: 'source' }))}>Use source changes</Button>
      </>}>
        <p className="text-sm">The source changed details you also edited. Choose which values to keep. Your completion is preserved.</p>
        <dl className="mt-2 grid gap-2 text-sm">{conflict.fields.map((field) => <div key={field}>
          <dt className="font-semibold">{labels[field] ?? field}</dt>
          <dd className="break-words whitespace-pre-wrap">Your value: {String(local?.[field] ?? 'None')}</dd>
          <dd className="break-words whitespace-pre-wrap">Source: {String(incoming[field] ?? 'None')}</dd>
        </div>)}</dl>
      </Callout>;
    })}
    {subscriptions.length === 0 && <p className="text-sm text-muted-foreground">Subscribe with an iCal link from your school or learning platform.</p>}
    {subscriptions.length > 0 && <ul className="grid gap-2">{subscriptions.map((feed) => <li key={feed.id} className="grid gap-2 rounded-lg bg-muted p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <strong className="break-words text-sm">{feed.name}</strong>
          <div className="flex flex-wrap gap-1.5"><Chip icon="calendar">{feed.itemCount} items</Chip>{!feed.enabled && <Chip>Paused</Chip>}{feed.lastError && <Chip tone="warning" icon="alert">Refresh failed</Chip>}</div>
          <Hint>{feed.lastSuccessAt ? `Last updated ${stamp(feed.lastSuccessAt)}` : 'No successful refresh yet'} · {feed.timeZone.replaceAll('_', ' ')}</Hint>
          {feed.enabled && <Hint>Next refresh {stamp(feed.nextRefreshAt)}</Hint>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" icon="refresh" disabled={!state.online || !feed.enabled || pending !== null} busy={pending === `refresh:${feed.id}`} onClick={() => void run(`refresh:${feed.id}`, () => api.calendar.refresh.mutate({ accountId: state.context.user.id, id: feed.id }))}>Refresh</Button>
          <Button size="sm" disabled={!state.online || pending !== null} onClick={() => void run(`pause:${feed.id}`, () => api.calendar.setEnabled.mutate({ accountId: state.context.user.id, id: feed.id, enabled: !feed.enabled }))}>{feed.enabled ? 'Pause' : 'Resume'}</Button>
          <Button size="sm" variant="ghost" disabled={!state.online || pending !== null} onClick={() => { if (confirm(`Remove ${feed.name}? Its imported items and completion will be kept as regular tasks. Updates will stop.`)) void run(`remove:${feed.id}`, () => api.calendar.remove.mutate({ accountId: state.context.user.id, id: feed.id })); }}>Remove</Button>
        </div>
      </div>
      {feed.lastError && <p className="text-sm text-destructive">{feed.lastError} Your saved items are unchanged. Try refreshing again.</p>}
    </li>)}</ul>}
    {!adding && <ErrorText>{error}</ErrorText>}
    <Modal open={adding} onClose={() => { if (pending === null) { setAdding(false); setUrl(''); } }} title="Add calendar"
      footer={<><Button variant="ghost" disabled={pending !== null} onClick={() => { setAdding(false); setUrl(''); }}>Cancel</Button><Button variant="primary" type="submit" form="calendar-feed-form" busy={pending === 'add'} disabled={!state.online || pending !== null || !name.trim() || !url.trim()}>Subscribe</Button></>}>
      <form id="calendar-feed-form" className="grid gap-4" onSubmit={(event) => { event.preventDefault(); if (!state.online || pending !== null) return; void run('add', async () => { await api.calendar.subscribe.mutate({ accountId: state.context.user.id, name: name.trim(), url: url.trim(), timeZone: timeZone.trim() }); setUrl(''); setName(''); setAdding(false); }); }}>
        <Field label="Calendar name" htmlFor="feed-name"><Input id="feed-name" autoFocus required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="School homework" /></Field>
        <Field label="iCal URL" htmlFor="feed-url" hint="Your subscription link is private and is not displayed after saving."><Input id="feed-url" type="text" inputMode="url" autoComplete="off" spellCheck={false} required maxLength={4000} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…/calendar.ics" /></Field>
        <Field label="Calendar time zone" htmlFor="feed-zone" hint="Used for times when the feed does not specify a time zone."><Input id="feed-zone" required maxLength={100} value={timeZone} onChange={(event) => setTimeZone(event.target.value)} placeholder="America/New_York" /></Field>
        <ErrorText>{error}</ErrorText>
      </form>
    </Modal>
  </Section>;
}
