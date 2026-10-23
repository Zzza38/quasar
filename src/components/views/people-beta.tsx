'use client';

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { GRADES, gradeLabel, resolveDay, type Grade, type PersonalSchedule, type ResolvedDay, type ResolvedPeriod, type Schedule, type StudentClass } from '@/domain/schedule';
import { sameClass } from '@/domain/class-match';
import { classColor, formatRoom, formatTime, pluralize } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AppState } from '../app-state';
import { Icon } from '../icon';
import { initialOf, MemberAvatar } from '../member-avatar';
import { Button, Callout, Chip, ColorDot, EmptyState, Eyebrow, Hint, IconButton, Input, PageHeader, Section, Segmented } from '../primitives';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { LoadingRows, MemberRow, usePeople, type Member } from './people';

/**
 * The people-redesign beta: five layouts of the People page, switched from a picker at the top so testers can
 * compare them. All five share usePeople (lists, search, actions, sheets) with the current page.
 */

const DESIGNS = [
  { value: 'live', label: 'Live' },
  { value: 'tabs', label: 'Tabs' },
  { value: 'directory', label: 'A–Z' },
  { value: 'yearbook', label: 'Yearbook' },
  { value: 'classes', label: 'Classes' },
] as const;
type Design = typeof DESIGNS[number]['value'];
const DESIGN_KEY = 'quasar-people-design';

type People = ReturnType<typeof usePeople>;
type Props = { state: AppState; people: People; days: Map<string, FriendDay> };

/* ---------- Friends' timetables ---------- */

/** Where a friend is in their school day today, and the classes they share with the viewer. */
type FriendDay = { kind: 'now' | 'next' | 'done' | 'off'; period: ResolvedPeriod | null; together: boolean; shared: StudentClass[] };

function dayOf(schedule: Schedule, date: string, personal: PersonalSchedule): ResolvedDay | null {
  try { return resolveDay(schedule, date, personal); } catch { return null; }
}

/** My classes that a friend takes in the same period (the profile sheet's "in common" rule). */
function sharedClasses(mine: PersonalSchedule, theirs: PersonalSchedule): StudentClass[] {
  const shared = new Map<string, StudentClass>();
  for (const [periodId, classId] of Object.entries(mine.assignments)) {
    const own = mine.classes.find(cls => cls.id === classId);
    const other = theirs.classes.find(cls => cls.id === theirs.assignments[periodId]);
    if (own && other && sameClass(own, other)) shared.set(own.id, own);
  }
  return [...shared.values()];
}

/**
 * Each friend at the viewer's school, from the timetables the workspace already holds (community.classmates).
 * Friends at another school have no entry.
 */
function useFriendDays(state: AppState): Map<string, FriendDay> {
  const { context, schedule, personal, today, now } = state;
  const classmates = context.community?.classmates;
  const schoolSchedule = context.school.schedule;
  return useMemo(() => {
    const nowMs = now.getTime();
    const mine = dayOf(schedule, today, personal);
    const days = new Map<string, FriendDay>();
    for (const friend of classmates ?? []) {
      const shared = sharedClasses(personal, friend.personal);
      const day = dayOf(schoolSchedule, today, friend.personal);
      if (!day || day.closed || !day.periods.length) { days.set(friend.id, { kind: 'off', period: null, together: false, shared }); continue; }
      const current = day.periods.find(period => new Date(period.startAt).getTime() <= nowMs && nowMs < new Date(period.endAt).getTime());
      const next = day.periods.find(period => new Date(period.startAt).getTime() > nowMs);
      const period = current ?? next ?? null;
      const together = !!period?.class && !!mine?.periods.some(own => own.periodId === period.periodId && own.startAt === period.startAt && own.endAt === period.endAt && !!own.class && sameClass(own.class, period.class!));
      days.set(friend.id, { kind: current ? 'now' : next ? 'next' : 'done', period, together, shared });
    }
    return days;
  }, [classmates, schoolSchedule, schedule, personal, today, now]);
}

const periodName = (period: ResolvedPeriod) => period.class?.name || period.label;

/** "Chemistry · until 10:45 AM", "Next: Lunch at 12:05 PM", "Done for today". */
function statusText(day: FriendDay | undefined): string {
  if (!day) return 'At another school';
  if (day.kind === 'off') return 'No school today';
  if (day.kind === 'done' || !day.period) return 'Done for today';
  return day.kind === 'now' ? `${periodName(day.period)} · until ${formatTime(day.period.end)}` : `Next: ${periodName(day.period)} at ${formatTime(day.period.start)}`;
}

function memberDetail(member: Member): string {
  return [member.fullName, member.grade ? gradeLabel(member.grade) : null].filter(Boolean).join(' · ') || 'Member';
}

/* ---------- Shared pieces ---------- */

function useDesign(): [Design, (design: Design) => void] {
  const [design, setDesign] = useState<Design>('live');
  useEffect(() => {
    try { const saved = localStorage.getItem(DESIGN_KEY); if (DESIGNS.some(entry => entry.value === saved)) setDesign(saved as Design); } catch { /* private mode: the default stays */ }
  }, []);
  const choose = (next: Design) => {
    setDesign(next);
    try { localStorage.setItem(DESIGN_KEY, next); } catch { /* private mode: the choice lasts until reload */ }
  };
  return [design, choose];
}

function Notices({ state, people }: { state: AppState; people: People }) {
  const failure = people.error || people.failed.friends || people.failed.members;
  return <>
    {!state.online && <Callout tone="neutral" icon="cloudOff">Connect to browse schoolmates and manage friends.</Callout>}
    {failure && <Callout tone="danger" icon="alert" role="alert">{failure}</Callout>}
    {people.notice && <Callout tone="success" icon="check" role="status">{people.notice}</Callout>}
  </>;
}

/** Verification only takes room on the page while there is something to do about it. */
function VerifyPrompt({ state, people }: { state: AppState; people: People }) {
  if (people.verification.status !== 'none') return null;
  const domains = state.context.school.emailDomains ?? [];
  return <Callout tone="neutral" icon="school" title={`Verify that you go to ${state.context.school.name}`}
    actions={<Button size="sm" variant="primary" icon="checkCircle" disabled={!state.online} onClick={people.openProof}>Verify my school</Button>}>
    Verified members see each other’s full names and can vote on schedule changes. {domains.length ? `Signing in with an address ending in ${domains.map(domain => `@${domain}`).join(' or ')} verifies you automatically.` : 'Send support a school portal screenshot or a photo of your student ID with the number covered.'}
  </Callout>;
}

function Header({ state, people }: { state: AppState; people: People }) {
  const { school } = state.context;
  const friendCount = people.friends?.friends.length ?? state.context.community?.friendCount ?? 0;
  const { status } = people.verification;
  return <PageHeader title="People" description={`${school.name} · ${pluralize(school.memberCount, 'member')} · ${pluralize(friendCount, 'friend')}`}
    aside={status === 'verified' ? <Chip tone="success" icon="checkCircle">Verified</Chip> : status === 'pending' ? <Chip tone="outline" icon="clock">Verification in review</Chip> : undefined} />;
}

function DesignPicker({ design, onChange }: { design: Design; onChange: (design: Design) => void }) {
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-muted/60 px-3 py-2 ring-1 ring-inset ring-foreground/[0.04]">
    <Eyebrow className="flex items-center gap-1.5"><Icon name="sparkle" size={12} />Beta layout</Eyebrow>
    <Segmented size="sm" label="People layout" value={design} onChange={onChange} options={DESIGNS.map(entry => ({ value: entry.value, label: entry.label }))} className="bg-card/60" />
  </div>;
}

function SearchField({ people, label = 'Search schoolmates', className }: { people: People; label?: string; className?: string }) {
  return <div className={cn('relative', className)}>
    <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
    <Input className="pl-9" type="search" aria-label={label} placeholder="Search by name" maxLength={80} value={people.query} onChange={event => people.setQuery(event.target.value)} />
  </div>;
}

function AcceptDecline({ state, people, member }: { state: AppState; people: People; member: Member }) {
  const busy = !state.online || people.pending;
  return <>
    <Button size="sm" variant="primary" icon="check" disabled={busy} onClick={() => void people.actions.accept(member)}>Accept</Button>
    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void people.actions.decline(member)}>Decline</Button>
  </>;
}

function AddButton({ state, people, member, compact }: { state: AppState; people: People; member: Member; compact?: boolean }) {
  const disabled = !state.online || people.pending;
  if (compact) return <IconButton size="sm" variant="secondary" icon="userPlus" label={`Add ${member.displayName} as a friend`} disabled={disabled} onClick={() => void people.actions.add(member)} />;
  return <Button size="sm" icon="plus" disabled={disabled} onClick={() => void people.actions.add(member)}>Add friend</Button>;
}

function MessageButton({ state, member, compact }: { state: AppState; member: Member; compact?: boolean }) {
  const open = () => state.navigate('messages', { with: member.id });
  if (compact) return <IconButton size="sm" variant="secondary" icon="message" label={`Message ${member.displayName}`} onClick={open} />;
  return <Button size="sm" icon="message" onClick={open}>Message</Button>;
}

function BlockedList({ state, people }: { state: AppState; people: People }) {
  const blocked = people.friends?.blocked ?? [];
  if (!blocked.length) return null;
  return <details className="group text-sm"><summary className="inline-flex cursor-pointer list-none items-center gap-1 font-semibold text-muted-foreground marker:hidden [&::-webkit-details-marker]:hidden">Blocked ({blocked.length})<Icon name="chevronDown" size={14} className="transition-transform group-open:rotate-180" /></summary>
    <ul className="mt-2 grid gap-2">{blocked.map(member => <li key={member.id} className="flex items-center justify-between gap-3 rounded-xl bg-muted/60 px-3 py-2"><span>{member.displayName}</span><Button size="sm" variant="ghost" disabled={!state.online || people.pending} onClick={() => void people.actions.unblock(member)}>Unblock</Button></li>)}</ul>
  </details>;
}

function DirectoryHint({ people }: { people: People }) {
  if (!people.members || people.directory.length) return null;
  return <Hint>{people.query.trim() ? 'No other schoolmates match that name.' : people.members.length ? 'Everyone here is already a friend or has a pending request.' : 'Nobody else has joined yet. Invite your schoolmates.'}</Hint>;
}

/** Sent requests, schoolmates to add, and the blocked list: the "find" half of the page, shared by Live and Classes. */
function FindPeople({ state, people }: { state: AppState; people: People }) {
  const outgoing = people.friends?.outgoing ?? [];
  return <Section id="find-title" title="Find people" icon="search" description="Full names show only when you are both verified.">
    <SearchField people={people} className="sm:max-w-80" />
    {outgoing.length > 0 && <div className="grid gap-2">
      <Eyebrow>Waiting for a reply</Eyebrow>
      <ul className="grid gap-2 sm:grid-cols-2" aria-label="Sent friend requests">{outgoing.map(member => <MemberRow key={member.id} member={member} onOpen={people.openProfile}>
        <Button size="sm" variant="ghost" disabled={!state.online || people.pending} onClick={() => void people.actions.cancel(member)}>Cancel</Button>
      </MemberRow>)}</ul>
    </div>}
    {people.membersLoading && <LoadingRows count={3} />}
    <DirectoryHint people={people} />
    {people.directory.length > 0 && <ul className="grid gap-2 sm:grid-cols-2" aria-label="Schoolmates">{people.directory.map(member => <MemberRow key={member.id} member={member} onOpen={people.openProfile}>
      <AddButton state={state} people={people} member={member} />
    </MemberRow>)}</ul>}
    <BlockedList state={state} people={people} />
  </Section>;
}

function NoFriends() {
  return <EmptyState icon="users" title="No friends yet">Find schoolmates and send a request. Once they accept, you can compare classes and see each other’s day.</EmptyState>;
}

/* ---------- 1. Live: where friends are right now, one row per class ---------- */

/** Friends in the same class (or the same free block) at the same time, now or next. */
type ClassGroup = { kind: 'now' | 'next'; period: ResolvedPeriod; room: string | null; together: boolean; friends: Member[] };
type IdleGroup = { kind: 'done' | 'off' | 'away'; friends: Member[] };

/** The same class by directory entry or name (sameClass); a period with no class matches by its label. */
function sameActivity(a: ResolvedPeriod, b: ResolvedPeriod): boolean {
  if (a.class && b.class) return sameClass(a.class, b.class);
  return !a.class && !b.class && a.kind === b.kind && a.label === b.label;
}

/** Groups friends by their current or next period. Classes running now come first, the viewer's own class first among them. */
function groupByClass(friends: Member[], days: Map<string, FriendDay>): { classes: ClassGroup[]; idle: IdleGroup[] } {
  const classes: ClassGroup[] = [];
  const idle: Record<IdleGroup['kind'], Member[]> = { done: [], off: [], away: [] };
  for (const friend of [...friends].sort((a, b) => a.displayName.localeCompare(b.displayName))) {
    const day = days.get(friend.id);
    if (!day) { idle.away.push(friend); continue; }
    if ((day.kind === 'now' || day.kind === 'next') && day.period) {
      const period = day.period;
      const group = classes.find(entry => entry.kind === day.kind && entry.period.startAt === period.startAt && sameActivity(entry.period, period));
      // Friends type rooms by hand, so the first one who entered a room names it for the card.
      if (group) { group.friends.push(friend); group.together ||= day.together; group.room ||= period.class?.room || null; }
      else classes.push({ kind: day.kind, period, room: period.class?.room || null, together: day.together, friends: [friend] });
      continue;
    }
    idle[day.kind === 'done' ? 'done' : 'off'].push(friend);
  }
  classes.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'now' ? -1 : 1) || Number(b.together) - Number(a.together)
    || b.friends.length - a.friends.length || a.period.startAt.localeCompare(b.period.startAt) || periodName(a.period).localeCompare(periodName(b.period)));
  return { classes, idle: (['done', 'off', 'away'] as const).map(kind => ({ kind, friends: idle[kind] })).filter(group => group.friends.length) };
}

const IDLE_LABEL: Record<IdleGroup['kind'], string> = { done: 'Done for today', off: 'No school today', away: 'At another school' };

/** Class groups that start and end together, so the block's time is said once above its rows. */
type Block = { kind: 'now' | 'next'; period: ResolvedPeriod; groups: ClassGroup[] };

function byBlock(classes: ClassGroup[]): Block[] {
  const blocks: Block[] = [];
  for (const group of classes) {
    const block = blocks.find(entry => entry.kind === group.kind && entry.period.startAt === group.period.startAt && entry.period.endAt === group.period.endAt);
    if (block) block.groups.push(group); else blocks.push({ kind: group.kind, period: group.period, groups: [group] });
  }
  return blocks.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'now' ? -1 : 1) || a.period.startAt.localeCompare(b.period.startAt));
}

/** Friends as small name chips; a tap opens the profile, which has their day and Message. */
function FriendChips({ people, friends, label }: { people: People; friends: Member[]; label: string }) {
  // On phones the chips always sit under the title, lined up with its text, so short and long rows look alike.
  return <ul className="flex flex-wrap gap-1.5 max-sm:w-full max-sm:pl-[19px]" aria-label={label}>{friends.map(friend => <li key={friend.id}>
    <button type="button" onClick={() => people.openProfile(friend.id)} aria-label={`Open ${friend.displayName}’s profile`}
      className="flex items-center gap-1.5 rounded-full bg-muted/80 py-0.5 pl-0.5 pr-2.5 text-[13px] font-semibold ring-1 ring-inset ring-foreground/[0.05] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
      <MemberAvatar name={friend.displayName} src={friend.avatar} size="sm" />{friend.displayName}
    </button>
  </li>)}</ul>;
}

/** One line of the timetable: what it is on the left, who is there on the right (below it on narrow screens). */
function LiveRow({ marker, title, detail, muted, aside, children }: { marker: ReactNode; title: string; detail?: string | null; muted?: boolean; aside?: ReactNode; children: ReactNode }) {
  return <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
    <span className="flex min-w-0 flex-1 basis-56 items-center gap-2.5">
      {marker}
      <span className="grid min-w-0">
        <strong className={cn('truncate text-sm', muted ? 'font-semibold text-muted-foreground' : 'font-bold')}>{title}</strong>
        {detail && <span className="truncate text-xs text-muted-foreground">{detail}</span>}
      </span>
      {aside}
    </span>
    {children}
  </li>;
}

const LIVE_LIST = 'divide-y divide-border overflow-hidden rounded-2xl bg-card shadow-card ring-1 ring-foreground/[0.06] dark:ring-foreground/[0.09]';

function LiveDesign({ state, people, days }: Props) {
  const incoming = people.friends?.incoming ?? [];
  const friends = people.friends?.friends ?? [];
  const { classes, idle } = useMemo(() => groupByClass(friends, days), [friends, days]);
  const blocks = useMemo(() => byBlock(classes), [classes]);
  return <>
    {incoming.length > 0 && <section aria-labelledby="live-requests" className="grid gap-2.5">
      <h2 id="live-requests" className="text-[15.5px] font-bold">Wants to be friends</h2>
      <ul className="grid gap-2 sm:grid-cols-2" aria-label="Incoming friend requests">{incoming.map(member => <MemberRow key={member.id} member={member} onOpen={people.openProfile}><AcceptDecline state={state} people={people} member={member} /></MemberRow>)}</ul>
    </section>}
    <section aria-labelledby="live-friends" className="grid gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 id="live-friends" className="text-[15.5px] font-bold">Where your friends are</h2>
        {friends.length > 0 && <Hint>{`${pluralize(friends.length, 'friend')} · ${pluralize(classes.length, 'class', 'classes')}`}</Hint>}
      </div>
      {people.friendsLoading && <LoadingRows count={2} />}
      {people.friends && friends.length === 0 && <NoFriends />}
      {blocks.map(block => <div key={`${block.kind}-${block.period.startAt}`} className="grid gap-2">
        <h3 className="flex items-baseline gap-2 px-1 text-sm font-bold">{block.kind === 'now' ? 'Now' : 'Next'}
          <span className="text-xs font-medium text-muted-foreground">{block.kind === 'now' ? `until ${formatTime(block.period.end)}` : `${formatTime(block.period.start)} – ${formatTime(block.period.end)}`}</span>
        </h3>
        <ul className={LIVE_LIST} aria-label={block.kind === 'now' ? 'Classes now' : 'Classes next'}>{block.groups.map(group => {
          const { period } = group;
          const color = classColor(period.class?.id, period.kind === 'lunch' ? 'lunch' : period.class ? 'class' : 'other', period.class?.color);
          return <LiveRow key={periodName(period)} marker={<ColorDot color={color.dot} size={9} />} title={periodName(period)} detail={group.room && formatRoom(group.room)} muted={!period.class}
            aside={group.together && <Chip tone="accent" className="shrink-0">You too</Chip>}>
            <FriendChips people={people} friends={group.friends} label={`Friends in ${periodName(period)}`} />
          </LiveRow>;
        })}</ul>
      </div>)}
      {idle.length > 0 && <div className="grid gap-2">
        <h3 className="px-1 text-sm font-bold">Not in class</h3>
        <ul className={LIVE_LIST} aria-label="Not in class">{idle.map(group => <LiveRow key={group.kind} marker={<Icon name={group.kind === 'away' ? 'school' : 'moon'} size={14} className="shrink-0 text-muted-foreground" />} title={IDLE_LABEL[group.kind]} muted>
          <FriendChips people={people} friends={group.friends} label={IDLE_LABEL[group.kind]} />
        </LiveRow>)}</ul>
      </div>}
    </section>
    <FindPeople state={state} people={people} />
  </>;
}

/* ---------- 2. Tabs: one list at a time, flat rows ---------- */

const TAB_CLASS = 'rounded-lg px-3.5 font-semibold data-active:bg-card data-active:shadow-[0_1px_2px_rgb(0_0_0/0.08)] dark:data-active:bg-secondary';

/** A flat row in a divided list: avatar, name, one line of detail, trailing actions. */
function ListRow({ member, detail, people, children }: { member: Member; detail: ReactNode; people: People; children?: ReactNode }) {
  const detailId = useId();
  return <li className="flex items-center gap-3 px-3.5 py-3 sm:px-4">
    <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => people.openProfile(member.id)} aria-label={`Open ${member.displayName}’s profile`} aria-describedby={detailId}>
      <MemberAvatar name={member.displayName} src={member.avatar} />
      <span className="grid min-w-0">
        <strong className="flex min-w-0 items-center gap-1.5 text-sm font-bold"><span className="truncate">{member.displayName}</span>{member.verified && <Icon name="checkCircle" size={14} className="shrink-0 text-success" />}</strong>
        <span id={detailId} className="truncate text-xs text-muted-foreground">{detail}</span>
      </span>
    </button>
    {children && <div className="flex shrink-0 items-center gap-1.5">{children}</div>}
  </li>;
}

function FlatList({ label, children }: { label: string; children: ReactNode }) {
  return <ul aria-label={label} className="divide-y divide-border overflow-hidden rounded-2xl bg-card shadow-card ring-1 ring-foreground/[0.06] dark:ring-foreground/[0.09]">{children}</ul>;
}

function TabsDesign({ state, people, days }: Props) {
  const incoming = people.friends?.incoming ?? [];
  const outgoing = people.friends?.outgoing ?? [];
  const friends = people.friends?.friends ?? [];
  const [tab, setTab] = useState('friends');
  return <Tabs value={tab} onValueChange={setTab} className="gap-4">
    <div className="overflow-x-auto"><TabsList aria-label="People lists" className="h-10 rounded-xl bg-muted p-1 ring-1 ring-inset ring-foreground/[0.04]">
      <TabsTrigger value="friends" className={TAB_CLASS}>Friends{friends.length ? ` · ${friends.length}` : ''}</TabsTrigger>
      <TabsTrigger value="requests" className={TAB_CLASS}>Requests{incoming.length ? <span className="ml-1 grid h-5 min-w-5 place-items-center rounded-full bg-primary-soft px-1.5 text-[11px] font-bold text-primary-soft-foreground">{incoming.length}</span> : null}</TabsTrigger>
      <TabsTrigger value="find" className={TAB_CLASS}>Find people</TabsTrigger>
    </TabsList></div>
    <TabsContent value="friends" className="grid gap-3">
      {people.friendsLoading && <LoadingRows count={3} />}
      {people.friends && friends.length === 0 && <NoFriends />}
      {friends.length > 0 && <FlatList label="Friends">{friends.map(friend => <ListRow key={friend.id} member={friend} people={people} detail={statusText(days.get(friend.id))}>
        <MessageButton state={state} member={friend} compact />
      </ListRow>)}</FlatList>}
    </TabsContent>
    <TabsContent value="requests" className="grid gap-4">
      {people.friendsLoading && <LoadingRows count={1} />}
      {people.friends && !incoming.length && !outgoing.length && <EmptyState icon="inbox" title="No requests waiting">When someone sends you a friend request it shows up here.</EmptyState>}
      {incoming.length > 0 && <div className="grid gap-2"><Eyebrow>Received</Eyebrow><FlatList label="Incoming friend requests">{incoming.map(member => <ListRow key={member.id} member={member} people={people} detail={memberDetail(member)}><AcceptDecline state={state} people={people} member={member} /></ListRow>)}</FlatList></div>}
      {outgoing.length > 0 && <div className="grid gap-2"><Eyebrow>Sent</Eyebrow><FlatList label="Sent friend requests">{outgoing.map(member => <ListRow key={member.id} member={member} people={people} detail={memberDetail(member)}>
        <Button size="sm" variant="ghost" disabled={!state.online || people.pending} onClick={() => void people.actions.cancel(member)}>Cancel</Button>
      </ListRow>)}</FlatList></div>}
    </TabsContent>
    <TabsContent value="find" className="grid gap-3">
      <SearchField people={people} />
      <Hint>Full names show only when you are both verified.</Hint>
      {people.membersLoading && <LoadingRows count={3} />}
      <DirectoryHint people={people} />
      {people.directory.length > 0 && <FlatList label="Schoolmates">{people.directory.map(member => <ListRow key={member.id} member={member} people={people} detail={memberDetail(member)}>
        <AddButton state={state} people={people} member={member} />
      </ListRow>)}</FlatList>}
      <BlockedList state={state} people={people} />
    </TabsContent>
  </Tabs>;
}

/* ---------- 3. A–Z: everyone in one alphabetical list ---------- */

type Filter = 'all' | 'friends' | Grade;
const FILTERS: Array<{ value: Filter; label: string }> = [{ value: 'all', label: 'Everyone' }, { value: 'friends', label: 'Friends' }, ...GRADES.map(grade => ({ value: grade, label: `${grade}th` }))];

function letterOf(name: string): string {
  const letter = initialOf(name);
  return /^[A-Z]$/.test(letter) ? letter : '#';
}

function DirectoryActions({ state, people, member }: { state: AppState; people: People; member: Member }) {
  if (member.friendState === 'friends') return <MessageButton state={state} member={member} compact />;
  if (member.friendState === 'incoming') return <AcceptDecline state={state} people={people} member={member} />;
  if (member.friendState === 'requested') return <><Chip tone="outline">Requested</Chip><IconButton size="sm" icon="x" label={`Cancel request to ${member.displayName}`} disabled={!state.online || people.pending} onClick={() => void people.actions.cancel(member)} /></>;
  return <AddButton state={state} people={people} member={member} compact />;
}

function DirectoryDesign({ state, people }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  // The member search covers everyone at the school, friends and requests included; offline, only friends are known.
  const everyone = people.members ?? people.friends?.friends ?? [];
  const shown = everyone.filter(member => filter === 'all' ? true : filter === 'friends' ? member.friendState === 'friends' : member.grade === filter);
  const waiting = shown.filter(member => member.friendState === 'incoming');
  const groups = new Map<string, Member[]>();
  for (const member of [...shown].filter(member => member.friendState !== 'incoming').sort((a, b) => a.displayName.localeCompare(b.displayName))) {
    const letter = letterOf(member.displayName);
    groups.set(letter, [...(groups.get(letter) ?? []), member]);
  }
  const row = (member: Member) => <ListRow key={member.id} member={member} people={people} detail={[memberDetail(member), member.friendState === 'friends' ? 'Friend' : null].filter(Boolean).join(' · ')}>
    <DirectoryActions state={state} people={people} member={member} />
  </ListRow>;
  return <section aria-label="Everyone at your school" className="grid gap-4">
    <div className="grid gap-2.5">
      <SearchField people={people} label="Search everyone" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented size="sm" label="Show" value={filter} onChange={setFilter} options={FILTERS} />
        {people.members && <Hint>{pluralize(shown.length, 'person', 'people')}</Hint>}
      </div>
    </div>
    {people.membersLoading && <LoadingRows count={4} />}
    {people.members && shown.length === 0 && <Hint>{people.query.trim() ? 'Nobody matches that name.' : filter === 'friends' ? 'No friends yet. Tap the add button next to a schoolmate.' : 'Nobody here yet.'}</Hint>}
    {waiting.length > 0 && <div className="grid gap-2"><Eyebrow>Waiting on you</Eyebrow><FlatList label="Incoming friend requests">{waiting.map(row)}</FlatList></div>}
    {[...groups].map(([letter, members]) => <div key={letter} className="grid gap-2">
      <h2 className="px-1 text-[13px] font-extrabold text-muted-foreground" aria-label={`Letter ${letter}`}>{letter}</h2>
      <FlatList label={`Names starting with ${letter}`}>{members.map(row)}</FlatList>
    </div>)}
    <BlockedList state={state} people={people} />
  </section>;
}

/* ---------- 4. Yearbook: big pictures, schoolmates by grade ---------- */

function Tile({ member, people, caption, size = 'xl', children }: { member: Member; people: People; caption: ReactNode; size?: 'lg' | 'xl'; children?: ReactNode }) {
  return <li className="grid content-start justify-items-center gap-2 rounded-2xl bg-card p-3 pb-3.5 text-center shadow-card ring-1 ring-foreground/[0.06] dark:ring-foreground/[0.09]">
    <button type="button" className="grid min-w-0 justify-items-center gap-2" onClick={() => people.openProfile(member.id)} aria-label={`Open ${member.displayName}’s profile`}>
      <MemberAvatar name={member.displayName} src={member.avatar} size={size} />
      <span className="grid min-w-0 max-w-full">
        <strong className="flex min-w-0 items-center justify-center gap-1 text-sm font-bold"><span className="truncate">{member.displayName}</span>{member.verified && <Icon name="checkCircle" size={13} className="shrink-0 text-success" />}</strong>
        <span className="truncate text-xs text-muted-foreground">{caption}</span>
      </span>
    </button>
    {children && <div className="flex flex-wrap justify-center gap-1.5">{children}</div>}
  </li>;
}

const TILE_GRID = 'grid grid-cols-2 gap-3 min-[480px]:grid-cols-3 md:grid-cols-4 xl:grid-cols-5';

function YearbookDesign({ state, people, days }: Props) {
  const incoming = people.friends?.incoming ?? [];
  const outgoing = people.friends?.outgoing ?? [];
  const friends = people.friends?.friends ?? [];
  const byGrade = [...GRADES].reverse().map(grade => ({ grade: grade as Grade | null, members: people.directory.filter(member => member.grade === grade) }));
  byGrade.push({ grade: null, members: people.directory.filter(member => !member.grade) });
  const together = (member: Member) => { const shared = days.get(member.id)?.shared.length ?? 0; return shared ? `${pluralize(shared, 'class', 'classes')} together` : member.grade ? gradeLabel(member.grade) : 'Friend'; };
  return <>
    {incoming.length > 0 && <section aria-labelledby="yearbook-requests" className="grid gap-2.5">
      <h2 id="yearbook-requests" className="text-[15.5px] font-bold">Wants to be friends</h2>
      <ul className={TILE_GRID} aria-label="Incoming friend requests">{incoming.map(member => <Tile key={member.id} member={member} people={people} size="lg" caption={memberDetail(member)}><AcceptDecline state={state} people={people} member={member} /></Tile>)}</ul>
    </section>}
    <section aria-labelledby="yearbook-friends" className="grid gap-2.5">
      <h2 id="yearbook-friends" className="text-[15.5px] font-bold">Friends{friends.length ? <span className="ml-1.5 font-semibold text-muted-foreground">{friends.length}</span> : null}</h2>
      {people.friendsLoading && <LoadingRows count={2} />}
      {people.friends && friends.length === 0 && <NoFriends />}
      {friends.length > 0 && <ul className={TILE_GRID} aria-label="Friends">{friends.map(friend => <Tile key={friend.id} member={friend} people={people} caption={together(friend)} />)}</ul>}
    </section>
    <section aria-labelledby="yearbook-school" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="yearbook-school" className="text-[15.5px] font-bold">Your school</h2>
        <SearchField people={people} className="w-full sm:w-60" />
      </div>
      {outgoing.length > 0 && <Hint>Waiting for {outgoing.map(member => member.displayName).join(', ')} to reply. Open a profile to cancel.</Hint>}
      {people.membersLoading && <LoadingRows count={2} />}
      <DirectoryHint people={people} />
      {byGrade.filter(group => group.members.length).map(group => <div key={group.grade ?? 'none'} className="grid gap-2">
        <Eyebrow>{group.grade ? gradeLabel(group.grade) : 'Grade not set'} · {group.members.length}</Eyebrow>
        <ul className={TILE_GRID} aria-label={group.grade ? gradeLabel(group.grade) : 'Grade not set'}>{group.members.map(member => <Tile key={member.id} member={member} people={people} size="lg" caption={member.fullName ?? 'Schoolmate'}>
          <AddButton state={state} people={people} member={member} />
        </Tile>)}</ul>
      </div>)}
      <BlockedList state={state} people={people} />
    </section>
  </>;
}

/* ---------- 5. Classes: your timetable's classes, with the friends in each ---------- */

function ClassesDesign({ state, people, days }: Props) {
  const incoming = people.friends?.incoming ?? [];
  const friends = people.friends?.friends ?? [];
  const mine = state.personal;
  const assigned = new Set(Object.values(mine.assignments));
  const classes = mine.classes.filter(cls => assigned.has(cls.id));
  const inClass = (cls: StudentClass) => friends.filter(friend => days.get(friend.id)?.shared.some(shared => shared.id === cls.id));
  const all = classes.map(cls => ({ cls, friends: inClass(cls) }));
  const rows = all.filter(row => row.friends.length).sort((a, b) => b.friends.length - a.friends.length || a.cls.name.localeCompare(b.cls.name));
  const alone = all.filter(row => !row.friends.length).map(row => row.cls);
  const sharedCount = (friend: Member) => days.get(friend.id)?.shared.length ?? 0;
  return <>
    {incoming.length > 0 && <Section id="classes-requests" title="Wants to be friends" icon="userPlus">
      <ul className="grid gap-2 sm:grid-cols-2" aria-label="Incoming friend requests">{incoming.map(member => <MemberRow key={member.id} member={member} onOpen={people.openProfile}><AcceptDecline state={state} people={people} member={member} /></MemberRow>)}</ul>
    </Section>}
    <section aria-labelledby="classes-title" className="grid gap-3">
      <div className="grid gap-0.5">
        <h2 id="classes-title" className="text-[15.5px] font-bold">Who’s in your classes</h2>
        <Hint>Friends who take the same class in the same period as you.</Hint>
      </div>
      {classes.length === 0 && <Hint>Add your classes to see which friends share them.</Hint>}
      {rows.length > 0 && <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Your classes">{rows.map(({ cls, friends: mates }) => {
        const color = classColor(cls.id, 'class', cls.color);
        return <li key={cls.id} className="grid content-start gap-3 rounded-2xl p-3.5 ring-1 ring-inset ring-foreground/[0.05]" style={{ background: color.soft }}>
          <div className="flex items-start gap-2.5">
            <span aria-hidden="true" className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: color.dot }} />
            <span className="grid min-w-0 flex-1">
              <strong className="line-clamp-2 text-sm font-bold leading-snug">{cls.name}</strong>
              <span className="truncate text-xs text-muted-foreground">{[cls.room && formatRoom(cls.room), cls.teacher].filter(Boolean).join(' · ') || ' '}</span>
            </span>
            <span className="shrink-0 text-xs font-bold text-muted-foreground">{mates.length || ''}</span>
          </div>
          {mates.length ? <ul className="flex flex-wrap gap-1.5" aria-label={`Friends in ${cls.name}`}>{mates.map(friend => <li key={friend.id}>
            <button type="button" onClick={() => people.openProfile(friend.id)} className="flex items-center gap-1.5 rounded-full bg-card/80 py-0.5 pl-0.5 pr-2.5 text-xs font-semibold ring-1 ring-inset ring-foreground/[0.06] hover:bg-card">
              <MemberAvatar name={friend.displayName} src={friend.avatar} size="xs" />{friend.displayName}
            </button>
          </li>)}</ul> : null}
        </li>;
      })}</ul>}
      {classes.length > 0 && !rows.length && <Hint>None of your friends share a class with you yet.</Hint>}
      {alone.length > 0 && <div className="grid gap-2 rounded-2xl bg-muted/60 p-3.5 ring-1 ring-inset ring-foreground/[0.04]">
        <Eyebrow>No friends yet</Eyebrow>
        <ul className="flex flex-wrap gap-1.5" aria-label="Classes without friends">{alone.map(cls => <li key={cls.id}><Chip tone="outline" className="gap-1.5"><ColorDot color={classColor(cls.id, 'class', cls.color).dot} size={7} />{cls.name}</Chip></li>)}</ul>
      </div>}
    </section>
    <Section id="classes-friends" title="Friends" icon="star" description={people.friends ? pluralize(friends.length, 'friend') : undefined}>
      {people.friendsLoading && <LoadingRows />}
      {people.friends && friends.length === 0 && <NoFriends />}
      {friends.length > 0 && <ul className="grid gap-2 md:grid-cols-2" aria-label="Friends">{[...friends].sort((a, b) => sharedCount(b) - sharedCount(a) || a.displayName.localeCompare(b.displayName)).map(friend => <MemberRow key={friend.id} member={friend} onOpen={people.openProfile}>
        {sharedCount(friend) > 0 && <Chip tone="accent" className="max-sm:hidden">{pluralize(sharedCount(friend), 'class', 'classes')}</Chip>}
        <MessageButton state={state} member={friend} compact />
      </MemberRow>)}</ul>}
    </Section>
    <FindPeople state={state} people={people} />
  </>;
}

/* ---------- The page ---------- */

export function PeopleBeta({ state }: { state: AppState }) {
  const people = usePeople(state);
  const days = useFriendDays(state);
  const [design, setDesign] = useDesign();
  const props = { state, people, days };
  return <div className="grid grid-cols-[minmax(0,1fr)] gap-5 animate-in fade-in-0 duration-300">
    <Header state={state} people={people} />
    <DesignPicker design={design} onChange={setDesign} />
    <Notices state={state} people={people} />
    <VerifyPrompt state={state} people={people} />
    {design === 'live' && <LiveDesign {...props} />}
    {design === 'tabs' && <TabsDesign {...props} />}
    {design === 'directory' && <DirectoryDesign {...props} />}
    {design === 'yearbook' && <YearbookDesign {...props} />}
    {design === 'classes' && <ClassesDesign {...props} />}
    {people.sheets}
  </div>;
}
