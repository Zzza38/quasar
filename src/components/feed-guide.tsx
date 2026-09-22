'use client';

import { useState, type ReactNode } from 'react';
import { api, errorMessage } from '@/client/api';
import { browserTimeZone } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Icon } from './icon';
import { Button, Callout, ErrorText, Field, Hint, Input } from './primitives';

/**
 * Where students actually get an iCal link from. Schoology comes first because that is what
 * the first real users have; the others are the next most common school portals.
 */
export const FEED_SOURCES: ReadonlyArray<{ id: string; name: string; steps: ReactNode[]; note?: ReactNode }> = [
  {
    id: 'schoology', name: 'Schoology',
    steps: [
      <>Open Schoology in a <b>web browser</b> on a laptop or phone, not the Schoology app. Sign in the way your school does.</>,
      <>Click <b>Calendar</b> in the top menu.</>,
      <>Scroll to the <b>bottom of the calendar</b>. In the middle, click <b>Export</b>.</>,
      <>In the <b>Export iCal Feed</b> box, choose <b>Share Calendar</b>, not Download Calendar. A link ending in <code>.ics</code> appears.</>,
      <>Copy that whole link and paste it below. It includes every course you are enrolled in.</>,
    ],
    note: 'Teachers have to put due dates on assignments for them to show up. If a class is missing, ask the teacher to add due dates in Schoology.',
  },
  {
    id: 'classroom', name: 'Google Classroom',
    steps: [
      <>Open <b>Google Calendar</b> in a browser while signed in to your school Google account.</>,
      <>Under <b>Other calendars</b> on the left, hover the Classroom calendar for a class and click the three dots, then <b>Settings and sharing</b>.</>,
      <>Scroll to <b>Integrate calendar</b> and copy the <b>Secret address in iCal format</b>.</>,
      <>Paste it below. Repeat for each class calendar, or subscribe to your main calendar once to get everything.</>,
    ],
  },
  {
    id: 'canvas', name: 'Canvas',
    steps: [
      <>Open Canvas in a browser and click <b>Calendar</b> in the left bar.</>,
      <>Click <b>Calendar Feed</b> at the bottom right of the page.</>,
      <>Copy the link shown and paste it below.</>,
    ],
  },
  {
    id: 'other', name: 'Something else',
    steps: [
      <>Look for <b>Export</b>, <b>Subscribe</b>, <b>Calendar feed</b> or <b>iCal</b> in your portal’s calendar settings.</>,
      <>The link should end in <code>.ics</code> or start with <code>webcal://</code>. Either works here.</>,
    ],
    note: 'A downloaded .ics file will not update itself. Quasar needs the subscription link so new homework keeps arriving.',
  },
];

/** Step-by-step instructions for getting an iCal link, one source at a time. */
export function FeedGuide({ initial = 'schoology', compact }: { initial?: string; compact?: boolean }) {
  const [sourceId, setSourceId] = useState(initial);
  const source = FEED_SOURCES.find((entry) => entry.id === sourceId) ?? FEED_SOURCES[0];
  return <div className="grid gap-3">
    <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Where is your homework?">
      {FEED_SOURCES.map((entry) => <button key={entry.id} type="button" role="tab" aria-selected={entry.id === source.id} onClick={() => setSourceId(entry.id)}
        className={cn('rounded-full px-3 py-1.5 text-sm font-semibold ring-1 ring-inset transition-colors', entry.id === source.id ? 'bg-primary text-primary-foreground ring-primary' : 'bg-card text-muted-foreground ring-foreground/[0.08] hover:bg-muted hover:text-foreground')}>{entry.name}</button>)}
    </div>
    <ol role="tabpanel" className={cn('grid list-decimal gap-1.5 pl-5 text-muted-foreground marker:font-bold marker:text-foreground/60', compact ? 'text-[13px]' : 'text-sm')}>
      {source.steps.map((step, index) => <li key={index} className="pl-1">{step}</li>)}
    </ol>
    {source.note && <Hint><Icon name="info" size={12} className="mr-1 inline" />{source.note}</Hint>}
  </div>;
}

/** Name, link and time zone. Used by the setup step and the Add calendar dialog. */
export function FeedSubscribeForm({ accountId, online, id = 'calendar-feed-form', onSubscribed, autoFocus, defaultName = 'School homework' }: {
  accountId: string; online: boolean; id?: string; onSubscribed: () => Promise<void>; autoFocus?: boolean; defaultName?: string;
}) {
  const [name, setName] = useState(defaultName);
  const [url, setUrl] = useState('');
  const [timeZone, setTimeZone] = useState(browserTimeZone);
  const [showZone, setShowZone] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    if (!online || pending) return;
    setPending(true); setError('');
    try {
      await api.calendar.subscribe.mutate({ accountId, name: name.trim(), url: url.trim(), timeZone: timeZone.trim() });
      setUrl('');
      await onSubscribed();
    } catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
  };
  return <form id={id} className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <Field label="iCal link" htmlFor={`${id}-url`} hint="Paste the whole link. It is private, is stored encrypted, and is never shown again after saving.">
      <Input id={`${id}-url`} type="text" inputMode="url" autoComplete="off" spellCheck={false} required autoFocus={autoFocus} maxLength={4000} value={url} disabled={pending} onChange={(event) => setUrl(event.target.value)} placeholder="https://…/feed.ics or webcal://…" className="h-11" />
    </Field>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Call it" htmlFor={`${id}-name`}><Input id={`${id}-name`} required maxLength={100} value={name} disabled={pending} onChange={(event) => setName(event.target.value)} placeholder="School homework" /></Field>
      {showZone
        ? <Field label="Calendar time zone" htmlFor={`${id}-zone`} hint="Used when the feed does not say."><Input id={`${id}-zone`} required maxLength={100} value={timeZone} disabled={pending} onChange={(event) => setTimeZone(event.target.value)} placeholder="America/New_York" /></Field>
        : <div className="grid content-end"><Hint>Time zone: {timeZone.replaceAll('_', ' ')} <button type="button" className="font-semibold text-primary hover:underline" onClick={() => setShowZone(true)}>Change</button></Hint></div>}
    </div>
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    {!online && <ErrorText>Connect to the internet to subscribe.</ErrorText>}
    <div><Button type="submit" variant="primary" icon="calendar" busy={pending} disabled={!online || !name.trim() || !url.trim()}>Connect calendar</Button></div>
  </form>;
}
