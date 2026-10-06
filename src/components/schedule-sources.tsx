'use client';

import { useState, type ReactNode } from 'react';
import { Icon } from './icon';
import { Button, Hint } from './primitives';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

/**
 * Where students get a copy of their class schedule in the common school portals. Every portal can show the schedule
 * and most can hand over a PDF; where one cannot, printing the page to PDF (or a screenshot) works. Schools rename
 * menus, so steps name the usual alternatives.
 */
export const SCHEDULE_SOURCES: ReadonlyArray<{ id: string; name: string; steps: ReactNode[]; note?: ReactNode }> = [
  {
    id: 'veracross', name: 'Veracross',
    steps: [
      <>Sign in to your school’s <b>Veracross portal</b> in a web browser.</>,
      <>Open your schedule document. On the Student Portal home it is often a tile such as <b>10-Day Schedule</b> or <b>Semester 2 Schedule</b>; otherwise open <b>Classes &amp; Reports</b> and choose <b>Current Class Schedule</b>.</>,
      <>It opens as a PDF. Download it (on an iPad or iPhone, tap <b>Share</b>, then <b>Save to Files</b>) and upload it here.</>,
    ],
  },
  {
    id: 'blackbaud', name: 'Blackbaud',
    steps: [
      <>Sign in to your school’s Blackbaud portal (the <b>myschoolapp.com</b> site) in a web browser.</>,
      <>Open <b>My Day</b>, then <b>Schedule</b>. Parents pick the student first, then the <b>Schedule</b> tab.</>,
      <>Show a full rotation (a week, or more for a longer cycle) and print the page. Choose <b>Save as PDF</b> and upload it here.</>,
    ],
  },
  {
    id: 'powerschool', name: 'PowerSchool',
    steps: [
      <>Sign in to PowerSchool in a web browser, not the app.</>,
      <>Click <b>My Schedule</b>, then the <b>Matrix</b> tab.</>,
      <>Click the <b>printer icon</b> at the top right, choose <b>Save as PDF</b> and upload it here.</>,
    ],
  },
  {
    id: 'infinite-campus', name: 'Infinite Campus',
    steps: [
      <>Sign in to <b>Campus Student</b> or <b>Campus Parent</b>.</>,
      <>Open <b>Documents</b> in the menu (in some districts it is under <b>More</b>) and choose <b>Student Schedule</b>.</>,
      <>Download the PDF and upload it here. The Schedule page itself has no print button.</>,
    ],
  },
  {
    id: 'skyward', name: 'Skyward',
    steps: [
      <>Sign in to Skyward <b>Family Access</b> or <b>Student Access</b>.</>,
      <>Open <b>Schedule</b>.</>,
      <>Click <b>Print Schedule</b> (or <b>Print Schedule List</b>), choose <b>Save as PDF</b> and upload it here.</>,
    ],
  },
  {
    id: 'aspen', name: 'Aspen',
    steps: [
      <>Sign in to Aspen in a web browser.</>,
      <>Open <b>My Info</b>, then <b>Schedule</b>, and switch to <b>Matrix</b>.</>,
      <>Print the page, choose <b>Save as PDF</b> and upload it here.</>,
    ],
  },
  {
    id: 'other', name: 'Something else',
    steps: [
      <>Find your schedule or timetable in your school portal.</>,
      <>Download it as a PDF if there is a button for that. If not, print the page and choose <b>Save as PDF</b>.</>,
      <>A screenshot, or a straight-on photo of a printed copy, works too.</>,
    ],
  },
];

/**
 * The source pills and steps, one portal at a time (Radix Tabs: one Tab stop, arrow keys between portals).
 * `onConnectFeed` adds the Veracross calendar-subscription option for schools that offer it.
 */
export function ScheduleSourceGuide({ onConnectFeed }: { onConnectFeed?: () => void }) {
  const [sourceId, setSourceId] = useState(SCHEDULE_SOURCES[0].id);
  return <Tabs value={sourceId} onValueChange={setSourceId} className="grid gap-3">
    <TabsList variant="line" aria-label="Where is your schedule?" className="h-auto w-auto flex-wrap justify-start gap-1.5 rounded-none p-0 group-data-horizontal/tabs:h-auto">
      {SCHEDULE_SOURCES.map(entry => <TabsTrigger key={entry.id} value={entry.id}
        className="h-auto flex-none rounded-full border-0 bg-card px-3 py-1.5 font-semibold text-muted-foreground ring-1 ring-inset ring-foreground/[0.08] transition-colors after:hidden hover:bg-muted hover:text-foreground data-[state=active]:bg-primary-soft data-[state=active]:text-primary-soft-foreground data-[state=active]:ring-primary/30">{entry.name}</TabsTrigger>)}
    </TabsList>
    {SCHEDULE_SOURCES.map(entry => <TabsContent key={entry.id} value={entry.id} className="grid gap-3 rounded-md focus-visible:ring-2 focus-visible:ring-ring">
      <ol className="grid list-decimal gap-1.5 pl-5 text-[13px] text-muted-foreground marker:font-bold marker:text-foreground/60">
        {entry.steps.map((step, index) => <li key={index} className="pl-1">{step}</li>)}
      </ol>
      {entry.note && <Hint><Icon name="info" size={12} className="mr-1 inline" />{entry.note}</Hint>}
      {entry.id === 'veracross' && onConnectFeed && <div className="grid gap-2 rounded-xl bg-muted/60 p-3 text-[13px] ring-1 ring-inset ring-foreground/[0.04]">
        <span className="text-muted-foreground">Does your portal’s <b>Calendar</b> have <b>Calendar Subscriptions</b> with a <b>Class Schedule</b> link? Connect that instead and Quasar keeps your classes up to date every day.</span>
        <div><Button size="sm" icon="refresh" onClick={onConnectFeed}>Connect a calendar subscription</Button></div>
      </div>}
    </TabsContent>)}
    <Hint>On an iPhone or iPad, tap <b>Share</b>, then <b>Print</b>, then <b>Share</b> again and <b>Save to Files</b> to get a PDF of any page.</Hint>
  </Tabs>;
}
