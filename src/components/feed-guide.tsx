'use client';

import { Fragment, useState, type ReactNode } from 'react';
import { api, errorMessage } from '@/client/api';
import { formatTimeZone } from '@/lib/format';
import { DEFAULT_FEED_GUIDES_STATE, FEED_PLATFORMS, guideImageUrl, guideName, type FeedGuide, type FeedGuides, type FeedPlatform } from '@/domain/feed-guides';
import { parseInline, type Inline } from '@/domain/markdown';
import { cn } from '@/lib/utils';
import { Icon } from './icon';
import { Button, Callout, ErrorText, Field, Hint, Input } from './primitives';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

function renderInline(nodes: Inline[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.kind) {
      case 'text': return <Fragment key={key}>{node.text}</Fragment>;
      case 'link': return <a key={key} href={node.href} target="_blank" rel="noopener noreferrer" className="break-all text-primary underline underline-offset-2">{node.text}</a>;
      case 'code': return <code key={key} className="rounded bg-muted px-1 font-mono text-[0.9em] text-foreground">{node.text}</code>;
      case 'strong': return <b key={key} className="font-bold text-foreground">{renderInline(node.children, key)}</b>;
      case 'em': return <em key={key}>{renderInline(node.children, key)}</em>;
      case 'strike': return <s key={key}>{renderInline(node.children, key)}</s>;
    }
  });
}

/** One guide's numbered steps, each with its screenshot, and its note. Also the live preview in the support editor. */
export function GuideSteps({ guide, compact }: { guide: FeedGuide; compact?: boolean }) {
  return <div className="grid gap-3">
    <ol className={cn('grid list-decimal gap-2 pl-5 text-muted-foreground marker:font-bold marker:text-foreground/60', compact ? 'text-[13px]' : 'text-sm')}>
      {guide.steps.map((step, index) => <li key={index} className="pl-1">
        {renderInline(parseInline(step.text), `s${index}`)}
        {/* The full-size screenshot opens in a new tab, since a phone shows it small. */}
        {step.image && <a href={guideImageUrl(step.image)} target="_blank" rel="noopener noreferrer" className="mt-2 block w-fit max-w-full rounded-lg focus-visible:ring-2 focus-visible:ring-ring">
          <img src={guideImageUrl(step.image)} alt={`Screenshot for step ${index + 1}`} loading="lazy" className="max-h-72 max-w-full rounded-lg object-contain ring-1 ring-foreground/[0.08]" />
        </a>}
      </li>)}
    </ol>
    {guide.note && <Hint><Icon name="info" size={12} className="mr-1 inline" />{renderInline(parseInline(guide.note), 'note')}</Hint>}
  </div>;
}

/**
 * How to get an iCal link from the school's platform. When support has said which platforms the school uses, only
 * those are offered, and a link shows the rest for a student whose classes are elsewhere. Several platforms are Radix
 * Tabs: one Tab stop with arrow, Home and End keys, each step list named after its pill. One platform needs no tabs.
 */
export function FeedGuide({ guides = DEFAULT_FEED_GUIDES_STATE, initial, compact }: { guides?: FeedGuides; initial?: FeedPlatform; compact?: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const limited = guides.platforms.length > 0 && !showAll;
  const shown = limited ? guides.platforms : FEED_PLATFORMS;
  const [chosen, setChosen] = useState<FeedPlatform | undefined>(initial);
  const platform = chosen && shown.includes(chosen) ? chosen : shown[0];
  const more = limited && <button type="button" className="w-fit text-left text-[13px] font-semibold text-primary hover:underline" onClick={() => setShowAll(true)}>My school uses something else</button>;
  if (shown.length === 1) return <div className="grid gap-3">
    <strong className="text-sm font-bold">In {guideName(platform, guides.guides[platform])}</strong>
    <GuideSteps guide={guides.guides[platform]} compact={compact} />
    {more}
  </div>;
  return <Tabs value={platform} onValueChange={(value) => setChosen(value as FeedPlatform)} className="grid gap-3">
    <TabsList variant="line" aria-label="Where is your homework?" className="h-auto w-auto flex-wrap justify-start gap-1.5 rounded-none p-0 group-data-horizontal/tabs:h-auto">
      {shown.map((entry) => <TabsTrigger key={entry} value={entry}
        className="h-auto flex-none rounded-full border-0 bg-card px-3 py-1.5 font-semibold text-muted-foreground ring-1 ring-inset ring-foreground/[0.08] transition-colors after:hidden hover:bg-muted hover:text-foreground data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:ring-primary data-[state=active]:hover:bg-primary data-[state=active]:hover:text-primary-foreground">{guideName(entry, guides.guides[entry])}</TabsTrigger>)}
    </TabsList>
    {shown.map((entry) => <TabsContent key={entry} value={entry} className="rounded-md focus-visible:ring-2 focus-visible:ring-ring">
      <GuideSteps guide={guides.guides[entry]} compact={compact} />
    </TabsContent>)}
    {more}
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
    <Field label="iCal link" htmlFor={`${id}-url`} hint="Paste the whole link. It’s private. Quasar encrypts it and never shows it again after you save.">
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
