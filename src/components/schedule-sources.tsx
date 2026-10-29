'use client';

import type { GuideSet } from '@/domain/setup-guides';
import { Button, Hint } from './primitives';
import { PlatformGuide } from './setup-guide';

/**
 * Where students get a copy of their class schedule in their school portal (the schedule setup guides,
 * src/domain/setup-guides.ts). Every portal can show the schedule and most can hand over a PDF; where one cannot,
 * printing the page to PDF (or a screenshot) works. `onConnectFeed` adds the Veracross calendar-subscription option
 * for schools that offer it.
 */
export function ScheduleSourceGuide({ guides, onConnectFeed }: { guides?: GuideSet; onConnectFeed?: () => void }) {
  return <div className="grid gap-3">
    <PlatformGuide kind="schedule" guides={guides} label="Where is your schedule?" compact
      extra={(platform) => platform === 'veracross' && onConnectFeed && <div className="grid gap-2 rounded-xl bg-muted/60 p-3 text-[13px] ring-1 ring-inset ring-foreground/[0.04]">
        <span className="text-muted-foreground">Does your portal’s <b>Calendar</b> have <b>Calendar Subscriptions</b> with a <b>Class Schedule</b> link? Connect that instead and Quasar keeps your classes up to date every day.</span>
        <div><Button size="sm" icon="refresh" onClick={onConnectFeed}>Connect a calendar subscription</Button></div>
      </div>} />
    <Hint>On an iPhone or iPad, tap <b>Share</b>, then <b>Print</b>, then <b>Share</b> again and <b>Save to Files</b> to turn any page into a PDF.</Hint>
  </div>;
}
