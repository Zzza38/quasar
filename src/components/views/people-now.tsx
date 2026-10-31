'use client';

import { useMemo } from 'react';
import { resolveDay, type PersonalSchedule, type ResolvedDay, type ResolvedPeriod, type Schedule } from '@/domain/schedule';
import { classMatcher, type ClassLike } from '@/domain/class-match';
import { FREE_PERIOD, NO_CLASS_SET } from '@/lib/classmates';
import { classColor, formatRoom, formatTime, pluralize } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AppState } from '../app-state';
import { Icon } from '../icon';
import { MemberAvatar } from '../member-avatar';
import { Button, Callout, Chip, EmptyState, Eyebrow, Hint, IconButton, Input, PageHeader, Section } from '../primitives';
import { LoadingRows, MemberRow, usePeople, type Member } from './people';

/**
 * The People page: friends grouped by the class they are in right now (or next), as cards coloured by class. The
 * lists, search, actions and sheets come from usePeople in people.tsx.
 */

type People = ReturnType<typeof usePeople>;
type Props = { state: AppState; people: People; days: Map<string, FriendDay> };

/* ---------- Friends' timetables ---------- */

/** Where a friend is in their school day today, and whether the viewer is in that class too. */
type FriendDay = { kind: 'now' | 'next' | 'done' | 'off'; period: ResolvedPeriod | null; together: boolean };

type ClassMatch = (left: ClassLike, right: ClassLike) => boolean;

function dayOf(schedule: Schedule, date: string, personal: PersonalSchedule): ResolvedDay | null {
  try { return resolveDay(schedule, date, personal); } catch { return null; }
}

/**
 * Each friend at the viewer's school, from the timetables the workspace already holds (community.classmates).
 * Friends at another school have no entry.
 */
function useFriendDays(state: AppState): Map<string, FriendDay> {
  const { context, schedule, personal, today, now } = state;
  const classmates = context.community?.classmates;
  const classDirectory = context.community?.classDirectory;
  const schoolSchedule = context.school.schedule;
  return useMemo(() => {
    const sameClass = classMatcher(classDirectory);
    const nowMs = now.getTime();
    const mine = dayOf(schedule, today, personal);
    const days = new Map<string, FriendDay>();
    for (const friend of classmates ?? []) {
      const day = dayOf(schoolSchedule, today, friend.personal);
      if (!day || day.closed || !day.periods.length) { days.set(friend.id, { kind: 'off', period: null, together: false }); continue; }
      const current = day.periods.find(period => new Date(period.startAt).getTime() <= nowMs && nowMs < new Date(period.endAt).getTime());
      const next = day.periods.find(period => new Date(period.startAt).getTime() > nowMs);
      const period = current ?? next ?? null;
      const together = !!period?.class && !!mine?.periods.some(own => own.periodId === period.periodId && own.startAt === period.startAt && own.endAt === period.endAt && !!own.class && sameClass(own.class, period.class!));
      days.set(friend.id, { kind: current ? 'now' : next ? 'next' : 'done', period, together });
    }
    return days;
  }, [classmates, classDirectory, schoolSchedule, schedule, personal, today, now]);
}

/** A period the friend marked free reads "Free", a class period they left empty "No class set", like the classmates popup. */
const periodName = (period: ResolvedPeriod) => period.free ? FREE_PERIOD : period.kind === 'class' && !period.class ? NO_CLASS_SET : period.class?.name || period.label;

/* ---------- Shared pieces ---------- */

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

/** Sent requests, schoolmates to add, and the blocked list: the "find" half of the page. */
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

/* ---------- Where friends are: one card per class running now or next ---------- */

/** Friends in the same class (or the same free block) at the same time, now or next. */
type ClassGroup = { kind: 'now' | 'next'; period: ResolvedPeriod; room: string | null; together: boolean; friends: Member[] };
type IdleGroup = { kind: 'done' | 'off' | 'away'; friends: Member[] };

/** The same class by directory entry or name (classMatcher); a period with no class matches by its label, free with free. */
function sameActivity(a: ResolvedPeriod, b: ResolvedPeriod, sameClass: ClassMatch): boolean {
  if (a.class && b.class) return sameClass(a.class, b.class);
  return !a.class && !b.class && a.kind === b.kind && a.label === b.label && !!a.free === !!b.free;
}

/** Groups friends by their current or next period. Classes running now come first, the viewer's own class first among them. */
function groupByClass(friends: Member[], days: Map<string, FriendDay>, sameClass: ClassMatch): { classes: ClassGroup[]; idle: IdleGroup[] } {
  const classes: ClassGroup[] = [];
  const idle: Record<IdleGroup['kind'], Member[]> = { done: [], off: [], away: [] };
  for (const friend of [...friends].sort((a, b) => a.displayName.localeCompare(b.displayName))) {
    const day = days.get(friend.id);
    if (!day) { idle.away.push(friend); continue; }
    if ((day.kind === 'now' || day.kind === 'next') && day.period) {
      const period = day.period;
      const group = classes.find(entry => entry.kind === day.kind && entry.period.startAt === period.startAt && sameActivity(entry.period, period, sameClass));
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

/** Class groups that start and end together, so the block's time is said once above its cards. */
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
  return <ul className="flex flex-wrap gap-1.5" aria-label={label}>{friends.map(friend => <li key={friend.id}>
    <button type="button" onClick={() => people.openProfile(friend.id)} aria-label={`Open ${friend.displayName}’s profile`}
      className="flex items-center gap-1.5 rounded-full bg-card/80 py-0.5 pl-0.5 pr-2.5 text-xs font-semibold ring-1 ring-inset ring-foreground/[0.06] outline-none hover:bg-card focus-visible:ring-2 focus-visible:ring-ring">
      <MemberAvatar name={friend.displayName} src={friend.avatar} size="xs" />{friend.displayName}
    </button>
  </li>)}</ul>;
}

function ClassCard({ people, group }: { people: People; group: ClassGroup }) {
  const { period } = group;
  const name = periodName(period);
  const color = classColor(period.class?.id, period.kind === 'lunch' ? 'lunch' : period.class ? 'class' : 'other', period.class?.color);
  return <li className="grid content-start gap-3 rounded-2xl p-3.5 ring-1 ring-inset ring-foreground/[0.05]" style={{ background: color.soft }}>
    <div className="flex items-start gap-2.5">
      <span aria-hidden="true" className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: color.dot }} />
      <span className="grid min-w-0 flex-1">
        <strong className="line-clamp-2 text-sm font-bold leading-snug">{name}</strong>
        <span className="truncate text-xs text-muted-foreground">{[group.room && formatRoom(group.room), period.class?.teacher].filter(Boolean).join(' · ') || ' '}</span>
      </span>
      {group.together ? <Chip tone="accent" className="shrink-0">You too</Chip> : <span className="shrink-0 text-xs font-bold text-muted-foreground">{group.friends.length}</span>}
    </div>
    <FriendChips people={people} friends={group.friends} label={`Friends in ${name}`} />
  </li>;
}

function NowDesign({ state, people, days }: Props) {
  const incoming = people.friends?.incoming ?? [];
  const friends = people.friends?.friends ?? [];
  const classDirectory = state.context.community?.classDirectory;
  const { classes, idle } = useMemo(() => groupByClass(friends, days, classMatcher(classDirectory)), [friends, days, classDirectory]);
  const blocks = useMemo(() => byBlock(classes), [classes]);
  return <>
    {incoming.length > 0 && <Section id="classes-requests" title="Wants to be friends" icon="userPlus">
      <ul className="grid gap-2 sm:grid-cols-2" aria-label="Incoming friend requests">{incoming.map(member => <MemberRow key={member.id} member={member} onOpen={people.openProfile}><AcceptDecline state={state} people={people} member={member} /></MemberRow>)}</ul>
    </Section>}
    <section aria-labelledby="classes-title" className="grid gap-4">
      <div className="grid gap-0.5">
        <h2 id="classes-title" className="text-[15.5px] font-bold">Where your friends are</h2>
        <Hint>The class each friend is in right now, or their next one.</Hint>
      </div>
      {people.friendsLoading && <LoadingRows count={2} />}
      {people.friends && friends.length === 0 && <NoFriends />}
      {blocks.map(block => <div key={`${block.kind}-${block.period.startAt}`} className="grid gap-2">
        <h3 className="flex items-baseline gap-2 px-1 text-sm font-bold">{block.kind === 'now' ? 'Now' : 'Next'}
          <span className="text-xs font-medium text-muted-foreground">{block.kind === 'now' ? `until ${formatTime(block.period.end)}` : `${formatTime(block.period.start)} – ${formatTime(block.period.end)}`}</span>
        </h3>
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label={block.kind === 'now' ? 'Classes now' : 'Classes next'}>{block.groups.map(group => <ClassCard key={`${periodName(group.period)}-${group.period.periodId}`} people={people} group={group} />)}</ul>
      </div>)}
      {idle.length > 0 && <div className="grid gap-3 rounded-2xl bg-muted/60 p-3.5 ring-1 ring-inset ring-foreground/[0.04]">
        {idle.map(group => <div key={group.kind} className="grid gap-2">
          <Eyebrow className="flex items-center gap-1.5"><Icon name={group.kind === 'away' ? 'school' : 'moon'} size={12} />{IDLE_LABEL[group.kind]}</Eyebrow>
          <FriendChips people={people} friends={group.friends} label={IDLE_LABEL[group.kind]} />
        </div>)}
      </div>}
    </section>
    <Section id="classes-friends" title="Friends" icon="star" description={people.friends ? pluralize(friends.length, 'friend') : undefined}>
      {people.friendsLoading && <LoadingRows />}
      {people.friends && friends.length === 0 && <NoFriends />}
      {friends.length > 0 && <ul className="grid gap-2 md:grid-cols-2" aria-label="Friends">{[...friends].sort((a, b) => a.displayName.localeCompare(b.displayName)).map(friend => <MemberRow key={friend.id} member={friend} onOpen={people.openProfile}>
        <MessageButton state={state} member={friend} compact />
      </MemberRow>)}</ul>}
    </Section>
    <FindPeople state={state} people={people} />
  </>;
}

/* ---------- The page ---------- */

export function PeopleView({ state }: { state: AppState }) {
  const people = usePeople(state);
  const days = useFriendDays(state);
  return <div className="grid grid-cols-[minmax(0,1fr)] gap-5 animate-in fade-in-0 duration-300">
    <Header state={state} people={people} />
    <Notices state={state} people={people} />
    <VerifyPrompt state={state} people={people} />
    <NowDesign state={state} people={people} days={days} />
    {people.sheets}
  </div>;
}
