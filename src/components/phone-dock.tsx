'use client';

import { useEffect, useState, type MouseEvent } from 'react';
import { cn } from '@/lib/utils';
import type { View } from './app-state';
import { Icon, type IconName } from './icon';
import { Segmented } from './primitives';

/** The beta that turns on this dock (see README "Running a beta"). */
export const PHONE_DOCK_BETA = 'phone-dock';

/** The two dock tabs that each cover two views. The first view in each pair is the default. */
export type DockGroup = 'classes' | 'people';
export const DOCK_GROUPS: Record<DockGroup, [View, View]> = { classes: ['classes', 'school'], people: ['messages', 'people'] };
const MEMORY_KEY = 'quasar.dock.last';

export function dockGroup(view: View): DockGroup | null {
  return DOCK_GROUPS.classes.includes(view) ? 'classes' : DOCK_GROUPS.people.includes(view) ? 'people' : null;
}

/**
 * Where a dock tab goes. Unread chats always win the People tab; otherwise each tab reopens
 * the half of its group the student used last, or the first half.
 */
export function dockTarget(group: DockGroup, last: Partial<Record<DockGroup, View>>, chatCount: number): View {
  if (group === 'people' && chatCount > 0) return 'messages';
  const remembered = last[group];
  return remembered && DOCK_GROUPS[group].includes(remembered) ? remembered : DOCK_GROUPS[group][0];
}

/** Remembers the last view used in each two-view group on this device. */
export function useDockMemory(view: View): Partial<Record<DockGroup, View>> {
  const [last, setLast] = useState<Partial<Record<DockGroup, View>>>({});
  useEffect(() => {
    try { setLast(JSON.parse(localStorage.getItem(MEMORY_KEY) ?? '{}') as Partial<Record<DockGroup, View>>); } catch { /* Storage may be unavailable. */ }
  }, []);
  useEffect(() => {
    const group = dockGroup(view);
    if (!group) return;
    setLast((current) => {
      if (current[group] === view) return current;
      const next = { ...current, [group]: view };
      try { localStorage.setItem(MEMORY_KEY, JSON.stringify(next)); } catch { /* Keep it for this session. */ }
      return next;
    });
  }, [view]);
  return last;
}

export interface DockCounts { taskCount: number; requestCount: number; chatCount: number }

/** The dot every nav count shows (as in Shell's BADGE_DOT); the number is the link's accessible description. */
const DOT = 'size-2 rounded-full bg-primary ring-2 ring-card';

/** The ids of the hidden count descriptions the dock tabs point at with aria-describedby. */
export const DOCK_COUNT_IDS = { tasks: 'dock-task-count', people: 'dock-people-count' } as const;

/** Hidden descriptions of the Tasks and People badges, read out with the tab names. */
export function DockCountDescriptions({ counts }: { counts: DockCounts }) {
  const { taskCount, requestCount, chatCount } = counts;
  const people = [chatCount > 0 && (chatCount === 1 ? '1 unread chat' : `${chatCount} unread chats`), requestCount > 0 && (requestCount === 1 ? '1 friend request' : `${requestCount} friend requests`)].filter(Boolean).join(', ');
  return <>
    {taskCount > 0 && <span id={DOCK_COUNT_IDS.tasks} hidden>{taskCount === 1 ? '1 open task' : `${taskCount} open tasks`}</span>}
    {people && <span id={DOCK_COUNT_IDS.people} hidden>{people}</span>}
  </>;
}

/**
 * The phone dock in the phone-dock beta: Schedule and Tasks, a raised Today button in the middle, then Classes
 * (with School) and People (with Messages). Every view is one tap away, and nothing hides in the top bar.
 */
export function PhoneDock({ view, counts, last, onTab }: { view: View; counts: DockCounts; last: Partial<Record<DockGroup, View>>; onTab: (active: boolean) => void }) {
  const peopleCount = counts.chatCount + counts.requestCount;
  const tab = (target: View, active: boolean, label: string, icon: IconName, count = 0, countId?: string) =>
    <a href={`#${target}`} aria-label={label} title={label} aria-current={active ? 'page' : undefined} aria-describedby={count > 0 ? countId : undefined}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => { if (event.button === 0) onTab(active && target === view); }}
      className={cn('relative flex flex-col items-center justify-center gap-0.5 rounded-2xl py-1.5 text-[10.5px] font-bold no-underline transition-colors hover:no-underline', active ? 'bg-primary-soft text-primary-soft-foreground' : 'text-muted-foreground')}>
      <Icon name={icon} size={21} strokeWidth={active ? 2.4 : 2} />
      <span>{label}</span>
      {count > 0 && <span aria-hidden="true" className={cn('absolute left-[calc(50%+9px)] top-1.5', DOT)} />}
    </a>;
  const onToday = view === 'today';
  const classesActive = dockGroup(view) === 'classes';
  const peopleActive = dockGroup(view) === 'people';
  return <nav className="tabbar fixed inset-x-0 bottom-0 z-30 lg:hidden" style={{ paddingBottom: 'max(10px, env(safe-area-inset-bottom))', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }} aria-label="Main">
    <div className="glass mx-3 grid grid-cols-[1fr_1fr_4.25rem_1fr_1fr] items-center rounded-[22px] p-1.5 shadow-float ring-1 ring-foreground/[0.08]">
      {tab('schedule', view === 'schedule', 'Schedule', 'calendar')}
      {tab('tasks', view === 'tasks', 'Tasks', 'tasks', counts.taskCount, DOCK_COUNT_IDS.tasks)}
      {/* The Today button: a circle that rises a little above the dock, labelled like the other tabs. Flat card fill
          and a border, the soft accent when active, never a glow. The negative margin keeps the row at tab height. */}
      <a href="#today" aria-label="Today" title="Today" aria-current={onToday ? 'page' : undefined}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => { if (event.button === 0) onTab(onToday); }}
        className={cn('group/today -mt-5 flex flex-col items-center gap-0.5 self-end pb-1.5 text-[10.5px] font-bold no-underline outline-none hover:no-underline', onToday ? 'text-primary-soft-foreground' : 'text-muted-foreground')}>
        <span className={cn('grid size-12 place-items-center rounded-full border shadow-float transition-colors group-focus-visible/today:ring-2 group-focus-visible/today:ring-ring group-focus-visible/today:ring-offset-2 group-focus-visible/today:ring-offset-background',
          onToday ? 'border-primary/40 bg-primary-soft text-primary-soft-foreground' : 'border-border bg-card text-foreground')}>
          <Icon name="home" size={22} strokeWidth={onToday ? 2.4 : 2} />
        </span>
        <span>Today</span>
      </a>
      {tab(classesActive ? view : dockTarget('classes', last, 0), classesActive, 'Classes', 'book')}
      {tab(peopleActive ? view : dockTarget('people', last, counts.chatCount), peopleActive, 'People', 'users', peopleCount, DOCK_COUNT_IDS.people)}
    </div>
  </nav>;
}

/** The phone switch at the top of a two-view dock tab: Chats / Friends under People, My classes / School under Classes. */
export function DockGroupSwitch({ view, counts, navigate }: { view: View; counts: DockCounts; navigate: (view: View) => void }) {
  const group = dockGroup(view);
  if (!group) return null;
  const count = (value: number) => value > 0 ? <span aria-hidden="true" className={cn(DOT, 'ring-0')} /> : null;
  const options = group === 'people'
    ? [{ value: 'messages' as View, label: <span className="inline-flex items-center gap-1.5"><Icon name="message" size={15} />Chats{count(counts.chatCount)}</span> },
      { value: 'people' as View, label: <span className="inline-flex items-center gap-1.5"><Icon name="users" size={15} />Friends{count(counts.requestCount)}</span> }]
    : [{ value: 'classes' as View, label: <span className="inline-flex items-center gap-1.5"><Icon name="book" size={15} />My classes</span> },
      { value: 'school' as View, label: <span className="inline-flex items-center gap-1.5"><Icon name="school" size={15} />School</span> }];
  return <Segmented value={view} options={options} onChange={navigate} label={group === 'people' ? 'Chats or friends' : 'Your classes or your school'}
    className="mb-4 grid w-full grid-cols-2 lg:hidden [&>*]:w-full" />;
}
