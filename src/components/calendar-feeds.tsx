'use client';

import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/client/api';
import type { AppState } from './app-state';
import { Icon } from './icon';
import { Button, Callout, Chip, ErrorText, Hint, Modal, Panel, Section } from './primitives';
import { FeedGuide, FeedSubscribeForm } from './feed-guide';

export function CalendarFeeds({ state }: { state: AppState }) {
  const [adding, setAdding] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const wantsAdd = state.params.get('feed') === 'add';
  useEffect(() => { if (wantsAdd) { setAdding(true); document.getElementById('calendar-feeds-title')?.scrollIntoView({ block: 'start' }); } }, [wantsAdd]);
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
  return <Section id="calendar-feeds-title" title="Connected calendars" icon="calendar" description="Subscribe to an iCal link and its events show up as tasks." action={<Button size="sm" icon="plus" disabled={!state.online || pending !== null} onClick={() => { setError(''); setAdding(true); }}>Add calendar</Button>}>
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
    {subscriptions.length === 0 && <Panel className="grid gap-2 text-sm text-muted-foreground">
      <span>No calendars yet. Schoology, Google Classroom, Canvas and most school portals offer an iCal link under their calendar settings.</span>
      <button type="button" className="w-fit text-left font-semibold text-primary hover:underline" aria-expanded={guideOpen} onClick={() => setGuideOpen((open) => !open)}>{guideOpen ? 'Hide instructions' : 'Show me where to find it'}</button>
      {guideOpen && <div className="rounded-xl bg-card p-3 ring-1 ring-foreground/[0.06]"><FeedGuide compact /></div>}
    </Panel>}
    {subscriptions.length > 0 && <ul className="grid gap-2">{subscriptions.map((feed) => <li key={feed.id} className="grid gap-2 rounded-2xl bg-muted/70 p-3.5 ring-1 ring-inset ring-foreground/[0.04]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
        <span aria-hidden="true" className={`mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl ${feed.lastError ? 'bg-warning-soft text-warning' : feed.enabled ? 'bg-primary-soft text-primary-soft-foreground' : 'bg-secondary text-secondary-foreground'}`}><Icon name="calendar" size={16} /></span>
        <div className="grid min-w-0 gap-1">
          <strong className="break-words text-sm font-bold">{feed.name}</strong>
          <div className="flex flex-wrap gap-1.5"><Chip icon="calendar">{feed.itemCount} items</Chip>{!feed.enabled && <Chip>Paused</Chip>}{feed.lastError && <Chip tone="warning" icon="alert">Refresh failed</Chip>}</div>
          <Hint>{feed.lastSuccessAt ? `Last updated ${stamp(feed.lastSuccessAt)}` : 'No successful refresh yet'} · {feed.timeZone.replaceAll('_', ' ')}</Hint>
          {feed.enabled && <Hint>Next refresh {stamp(feed.nextRefreshAt)}</Hint>}
        </div>
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
    <Modal open={adding} wide onClose={() => { if (pending === null) setAdding(false); }} title="Add calendar" description="Copy the iCal link from your school portal, then paste it here."
      footer={<><Button variant="ghost" disabled={pending !== null} onClick={() => setAdding(false)}>Cancel</Button></>}>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel className="grid gap-2"><strong className="text-sm font-bold">Where to find the link</strong><FeedGuide compact /></Panel>
        <FeedSubscribeForm accountId={state.context.user.id} online={state.online} autoFocus onSubscribed={async () => { await state.refresh(); setAdding(false); }} />
      </div>
    </Modal>
  </Section>;
}
