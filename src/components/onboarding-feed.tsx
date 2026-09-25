'use client';

import type { FeedSubscription } from '@/server/calendar';
import { FeedGuide, FeedSubscribeForm } from './feed-guide';
import { Frame, STEP_FEED } from './onboarding';
import { Icon } from './icon';
import { Button, Chip, Hint, Panel, Spacer } from './primitives';

/**
 * The optional last setup step: connect the school portal's iCal link so homework arrives
 * as tasks by itself. Schoology instructions are shown first because that is what the first
 * real users have.
 */
export function FeedStep({ userId, online, timeZone, subscriptions, onSubscribed, onDone, footer, notice }: {
  userId: string; online: boolean; timeZone: string; subscriptions: FeedSubscription[]; onSubscribed: () => Promise<unknown>; onDone: () => void; footer: React.ReactNode; notice?: React.ReactNode;
}) {
  const connected = subscriptions.length > 0;
  return <Frame step={STEP_FEED} wide title="Get homework in automatically" description="If your school uses Schoology, Google Classroom or Canvas, it can send every assignment straight into your task list. Two minutes now, then it stays up to date on its own." notice={notice} footer={footer}>
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Panel className="grid gap-3">
        <strong className="text-sm font-bold">1. Copy your calendar link</strong>
        <FeedGuide />
      </Panel>
      <Panel className="grid gap-3 bg-card ring-1 ring-foreground/[0.06]">
        <strong className="text-sm font-bold">2. Paste it here</strong>
        {connected && <ul className="grid gap-2" aria-label="Connected calendars">
          {subscriptions.map((feed) => <li key={feed.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-success-soft/60 px-3 py-2 text-sm">
            <Icon name="checkCircle" size={16} className="text-success" /><strong className="font-bold">{feed.name}</strong>
            {feed.lastError ? <Chip tone="warning" icon="alert">Could not read it yet</Chip> : <Chip tone="success">{feed.itemCount === 1 ? '1 item imported' : `${feed.itemCount} items imported`}</Chip>}
          </li>)}
        </ul>}
        {connected && <Hint>Add another link, or finish. Manage calendars later from the Schedule page.</Hint>}
        {/* defaultName is only the starting value: a step reopened with a calendar already connected starts blank, and the form clears the name itself after each connect. */}
        <FeedSubscribeForm accountId={userId} online={online} schoolTimeZone={timeZone} id="setup-feed" onSubscribed={onSubscribed} autoFocus={false} defaultName={connected ? '' : 'School homework'} />
      </Panel>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <Spacer />
      {connected
        ? <Button variant="primary" size="lg" iconRight="arrowRight" onClick={onDone}>Finish setup</Button>
        : <Button variant="secondary" size="lg" iconRight="arrowRight" onClick={onDone}>Skip for now</Button>}
    </div>
  </Frame>;
}
