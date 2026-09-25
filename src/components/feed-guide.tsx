'use client';

import { useState, type ReactNode } from 'react';
import { api, errorMessage } from '@/client/api';
import { formatTimeZone } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Icon } from './icon';
import { Button, Callout, ErrorText, Field, Hint, Input } from './primitives';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

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

/**
 * Step-by-step instructions for getting an iCal link, one source at a time. Radix Tabs give the source pills one
 * Tab stop with arrow, Home and End keys, and name each step list after its pill.
 */
export function FeedGuide({ initial = 'schoology', compact }: { initial?: string; compact?: boolean }) {
  const [sourceId, setSourceId] = useState(initial);
  const source = FEED_SOURCES.find((entry) => entry.id === sourceId) ?? FEED_SOURCES[0];
  return <Tabs value={source.id} onValueChange={setSourceId} className="grid gap-3">
    <TabsList variant="line" aria-label="Where is your homework?" className="h-auto w-auto flex-wrap justify-start gap-1.5 rounded-none p-0">
      {FEED_SOURCES.map((entry) => <TabsTrigger key={entry.id} value={entry.id}
        className="h-auto flex-none rounded-full border-0 bg-card px-3 py-1.5 font-semibold text-muted-foreground ring-1 ring-inset ring-foreground/[0.08] transition-colors after:hidden hover:bg-muted hover:text-foreground data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:ring-primary data-[state=active]:hover:bg-primary data-[state=active]:hover:text-primary-foreground">{entry.name}</TabsTrigger>)}
    </TabsList>
    {FEED_SOURCES.map((entry) => <TabsContent key={entry.id} value={entry.id} className="grid gap-3 rounded-md focus-visible:ring-2 focus-visible:ring-ring">
      <ol className={cn('grid list-decimal gap-1.5 pl-5 text-muted-foreground marker:font-bold marker:text-foreground/60', compact ? 'text-[13px]' : 'text-sm')}>
        {entry.steps.map((step, index) => <li key={index} className="pl-1">{step}</li>)}
      </ol>
      {entry.note && <Hint><Icon name="info" size={12} className="mr-1 inline" />{entry.note}</Hint>}
    </TabsContent>)}
  </Tabs>;
}

/**
 * Name, link and time zone. Used by the setup step and the Add calendar dialog. Imported due dates and
 * times are stored as wall-clock times in the calendar's zone. The task list and overdue checks read them
 * in the school's zone, while a reminder added to an imported task counts from the calendar's zone
 * (TaskSheet in views/tasks.tsx). The calendar zone starts as `schoolTimeZone` rather than the device's
 * zone so the two agree; a calendar set to another zone reminds by that zone's clock but turns overdue
 * by the school's, which differ by the offset between the zones.
 */
export function FeedSubscribeForm({ accountId, online, schoolTimeZone, id = 'calendar-feed-form', onSubscribed, autoFocus, defaultName = 'School homework' }: {
  accountId: string; online: boolean; schoolTimeZone: string; id?: string; onSubscribed: () => Promise<unknown>; autoFocus?: boolean; defaultName?: string;
}) {
  const [name, setName] = useState(defaultName);
  const [url, setUrl] = useState('');
  const [timeZone, setTimeZone] = useState(schoolTimeZone);
  const [showZone, setShowZone] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    if (!online || pending) return;
    setPending(true); setError('');
    try {
      await api.calendar.subscribe.mutate({ accountId, name: name.trim(), url: url.trim(), timeZone: timeZone.trim() });
      // The next calendar needs its own link and name, so a second feed is not saved under the same name.
      setUrl(''); setName('');
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
        ? <Field label="Calendar time zone" htmlFor={`${id}-zone`} hint="Imported due dates and times are shown in this zone, and times the feed leaves unzoned are read in it. Keep your school’s zone unless you have a reason not to."><Input id={`${id}-zone`} required maxLength={100} value={timeZone} disabled={pending} onChange={(event) => setTimeZone(event.target.value)} placeholder="America/New_York" /></Field>
        : <div className="grid content-end"><Hint>Time zone: {formatTimeZone(timeZone)} <button type="button" className="font-semibold text-primary hover:underline" onClick={() => setShowZone(true)}>Change</button></Hint></div>}
    </div>
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    {!online && <ErrorText>Connect to the internet to subscribe.</ErrorText>}
    <div><Button type="submit" variant="primary" icon="calendar" busy={pending} disabled={!online || !name.trim() || !url.trim()}>Connect calendar</Button></div>
  </form>;
}
