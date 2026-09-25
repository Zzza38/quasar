'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import { gradeLabel, resolveDay, scheduleForGrade, type PersonalSchedule, type Schedule } from '@/domain/schedule';
import { sameClass, type ClassLike } from '@/domain/class-match';
import { CHAT } from '@/domain/chat';
import { addDays, classColor, formatDate, formatRange, formatRoom, instantParts, pluralize, relativeDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AppState } from '../app-state';
import { Icon } from '../icon';
import { Button, Callout, Chip, EmptyState, Eyebrow, Field, Hint, IconButton, Input, Modal, Panel, Section, Spacer, Textarea } from '../primitives';
import { Checkbox } from '../ui/checkbox';
import { Label } from '../ui/label';
import { Skeleton } from '../ui/skeleton';
import { Timeline } from './today';

type Member = RouterOutput['community']['members']['members'][number];
type Friends = RouterOutput['community']['friends'];
type Profile = RouterOutput['community']['profile'];

function MemberAvatar({ name, size = 'md' }: { name: string; size?: 'md' | 'lg' }) {
  return <span aria-hidden="true" className={cn('grid shrink-0 place-items-center rounded-full font-extrabold text-primary-foreground', size === 'lg' ? 'size-14 text-xl' : 'size-10 text-sm')}
    style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--primary) 75%, white) 0%, var(--primary) 60%, color-mix(in srgb, var(--primary) 70%, black) 100%)' }}>{(name || '?').slice(0, 1).toUpperCase()}</span>;
}

function MemberRow({ member, onOpen, children }: { member: Member; onOpen: (id: string) => void; children?: React.ReactNode }) {
  const detailId = useId();
  const detail = [member.fullName, member.grade ? gradeLabel(member.grade) : null, member.friendState === 'friends' ? 'Friend' : member.friendState === 'requested' ? 'Request sent' : member.friendState === 'incoming' ? 'Wants to be friends' : null].filter(Boolean).join(' · ') || 'Member';
  // The short label keeps the button name stable; the details (verified, full name, grade, friend state) are its description.
  return <li className="flex items-center gap-3 rounded-2xl bg-muted/60 p-3 ring-1 ring-inset ring-foreground/[0.04]">
    <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => onOpen(member.id)} aria-label={`Open ${member.displayName}’s profile`} aria-describedby={detailId}>
      <MemberAvatar name={member.displayName} />
      <span className="grid min-w-0">
        <strong className="flex min-w-0 items-center gap-1.5 text-sm font-bold"><span className="truncate">{member.displayName}</span>{member.verified && <Icon name="checkCircle" size={14} className="shrink-0 text-success" />}</strong>
        <Hint className="truncate"><span id={detailId}>{member.verified && <span className="sr-only">Verified · </span>}{detail}</span></Hint>
      </span>
    </button>
    {children && <div className="flex shrink-0 items-center gap-1.5">{children}</div>}
  </li>;
}

/** Placeholder rows while a list loads. */
function LoadingRows({ count = 2 }: { count?: number }) {
  return <div role="status" aria-label="Loading" className="grid gap-2">{Array.from({ length: count }, (_, index) => <Skeleton key={index} className="h-16 rounded-2xl" />)}</div>;
}

export function PeopleView({ state }: { state: AppState }) {
  const { context, online } = state;
  const accountId = context.user.id;
  const verification = context.community?.verification ?? { status: 'none' as const, method: null };
  const [friends, setFriends] = useState<Friends | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const [profileId, setProfileId] = useState<string | null>(state.params.get('member'));
  const [proofOpen, setProofOpen] = useState(false);

  // A link such as #people?member=<id> opens that profile, also when People is already on screen.
  useEffect(() => { const member = state.params.get('member'); if (member) setProfileId(member); }, [state.params]);
  const closeProfile = () => {
    setProfileId(null);
    if (state.params.has('member')) state.navigate('people', undefined, { replace: true });
  };

  // Each list's load error, kept apart so one list loading cannot hide the other's failure. A failed list
  // also stops showing placeholders. `error` holds action errors only.
  const [failed, setFailed] = useState({ friends: '', members: '' });
  const loadFriends = useCallback(async () => {
    try { setFriends(await api.community.friends.query()); setFailed(current => ({ ...current, friends: '' })); }
    catch (err) { setFailed(current => ({ ...current, friends: errorMessage(err) })); throw err; }
  }, []);
  // Each search takes a ticket; a response is dropped once a newer search has started or the text changed.
  const searchTicket = useRef(0);
  const loadMembers = useCallback(async (text: string) => {
    const ticket = ++searchTicket.current;
    try {
      const result = await api.community.members.query({ query: text.trim().slice(0, 80) });
      if (ticket === searchTicket.current) { setMembers(result.members); setFailed(current => ({ ...current, members: '' })); }
    } catch (err) {
      if (ticket !== searchTicket.current) return; // A newer search replaced this one.
      setFailed(current => ({ ...current, members: errorMessage(err) })); throw err;
    }
  }, []);
  const queryRef = useRef(query);
  useEffect(() => { queryRef.current = query; }, [query]);

  useEffect(() => {
    if (!online) return;
    loadFriends().catch(() => undefined); // Shown through `failed`.
  }, [online, loadFriends]);
  useEffect(() => {
    if (!online) return;
    const timer = setTimeout(() => { loadMembers(query).catch(() => undefined); }, query.trim() ? 250 : 0);
    return () => { clearTimeout(timer); searchTicket.current += 1; };
  }, [online, query, loadMembers]);

  /** Reloads both lists after an action changes a friendship. */
  const refresh = useCallback(async () => {
    if (!online) return;
    await Promise.allSettled([loadFriends(), loadMembers(queryRef.current)]); // Failures show through `failed`.
  }, [online, loadFriends, loadMembers]);
  const run = async (action: () => Promise<void>, done?: string) => {
    setPending(true); setError(''); setNotice('');
    let failure: unknown = null;
    try { await action(); } catch (err) { failure = err; }
    // Reload after a refusal too: some commit first (accepting a request from someone who has since changed schools
    // deletes it), so the lists and badges must drop what is gone.
    try { await refresh(); await state.refresh(); if (failure) setError(errorMessage(failure)); else if (done) setNotice(done); } catch (err) { setError(errorMessage(failure ?? err)); } finally { setPending(false); }
  };
  // Friends and both request lists have their own sections, so Schoolmates lists only everyone else.
  const directory = (members ?? []).filter(member => member.friendState === 'none');
  const friendsLoading = online && friends === null && !failed.friends;
  const membersLoading = online && members === null && !failed.members;

  return <div className="grid grid-cols-[minmax(0,1fr)] gap-5 animate-in fade-in-0 duration-300">
    <header className="grid gap-1">
      <h1>People</h1>
      <p className="text-sm text-muted-foreground">{context.school.name} · {pluralize(context.school.memberCount, 'member')} · {pluralize(context.community?.friendCount ?? 0, 'friend')}</p>
    </header>
    {!online && <Callout tone="neutral" icon="cloudOff">Connect to browse schoolmates and manage friends.</Callout>}
    {(error || failed.friends || failed.members) && <Callout tone="danger" icon="alert" role="alert">{error || failed.friends || failed.members}</Callout>}
    {notice && <Callout tone="success" icon="check" role="status">{notice}</Callout>}

    <div className="grid items-start gap-5 lg:grid-cols-2">
      <Section id="verification-title" title="School verification" icon={verification.status === 'verified' ? 'checkCircle' : 'school'}
        description="Verification proves you go to this school. It unlocks full names between verified members and voting on schedule changes.">
        {verification.status === 'verified' && <Callout tone="success" icon="checkCircle">You are verified at {context.school.name}{verification.method === 'domain' ? ' through your school email address.' : ' by support.'}</Callout>}
        {verification.status === 'pending' && <Callout tone="info" icon="clock">Support is reviewing your proof. You will be verified here once it is accepted.</Callout>}
        {verification.status === 'none' && <>
          <Panel className="grid gap-2 text-sm">
            <p><strong>Have a school email?</strong> {(context.school.emailDomains ?? []).length ? `Sign in with an address ending in ${context.school.emailDomains.map(domain => `@${domain}`).join(' or ')} to verify automatically.` : 'Support has not attached a school email domain yet. Ask support to add one, or send proof below.'}</p>
            <p><strong>No school email?</strong> Send support another proof, such as a link to a photo of your student ID with the number covered, or a school portal screenshot.</p>
          </Panel>
          <div><Button variant="primary" icon="checkCircle" disabled={!online} onClick={() => setProofOpen(true)}>Verify my school</Button></div>
        </>}
      </Section>

      <Section id="requests-title" title="Friend requests" icon="users" description="Friends can see your classes and timetable. You can remove a friend at any time, which ends their access immediately.">
        {friendsLoading && <LoadingRows count={1} />}
        {friends && friends.incoming.length === 0 && friends.outgoing.length === 0 && <Hint>No requests waiting.</Hint>}
        {!!friends?.incoming.length && <ul className="grid gap-2" aria-label="Incoming friend requests">{friends.incoming.map(member => <MemberRow key={member.id} member={member} onOpen={setProfileId}>
          <Button size="sm" variant="primary" icon="check" disabled={!online || pending} onClick={() => void run(() => api.community.respond.mutate({ accountId, userId: member.id, accept: true }).then(() => undefined), `You and ${member.displayName} are now friends.`)}>Accept</Button>
          <Button size="sm" variant="ghost" disabled={!online || pending} onClick={() => void run(() => api.community.respond.mutate({ accountId, userId: member.id, accept: false }).then(() => undefined))}>Decline</Button>
        </MemberRow>)}</ul>}
        {!!friends?.outgoing.length && <ul className="grid gap-2" aria-label="Sent friend requests">{friends.outgoing.map(member => <MemberRow key={member.id} member={member} onOpen={setProfileId}>
          <Button size="sm" variant="ghost" disabled={!online || pending} onClick={() => void run(() => api.community.remove.mutate({ accountId, userId: member.id }).then(() => undefined))}>Cancel request</Button>
        </MemberRow>)}</ul>}
      </Section>
    </div>

    <Section id="friends-title" title="Friends" icon="star" description={friends ? pluralize(friends.friends.length, 'friend') : undefined}>
      {friendsLoading && <LoadingRows />}
      {friends && friends.friends.length === 0 && <EmptyState icon="users" title="No friends yet">Find schoolmates below and send a request. Once they accept, you can compare classes and see each other’s day.</EmptyState>}
      {!!friends?.friends.length && <ul className="grid gap-2 md:grid-cols-2" aria-label="Friends">{friends.friends.map(member => <MemberRow key={member.id} member={member} onOpen={setProfileId}>
        {/* Icon-only below sm so the friend's name keeps its room; the hidden text keeps the name "Message". */}
        <Button size="sm" icon="message" className="max-sm:size-8 max-sm:px-0 pointer-coarse:max-sm:size-11" onClick={() => state.navigate('messages', { with: member.id })}><span className="max-sm:sr-only">Message</span></Button>
        <Button size="sm" iconRight="arrowRight" onClick={() => setProfileId(member.id)}>See day</Button>
      </MemberRow>)}</ul>}
    </Section>

    <Section id="members-title" title="Schoolmates" icon="search" description="Everyone at this school on Quasar. Full names show only when you are both verified."
      action={<div className="relative min-w-[180px]"><Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" /><Input small className="max-w-[240px] pl-8" aria-label="Search schoolmates" placeholder="Search by name" maxLength={80} value={query} onChange={event => setQuery(event.target.value)} /></div>}>
      {membersLoading && <LoadingRows count={3} />}
      {members && directory.length === 0 && <Hint>{query.trim() ? 'No other schoolmates match that name.' : members.length ? 'Everyone here is already a friend or has a pending request.' : 'Nobody else has joined yet. Invite your schoolmates.'}</Hint>}
      {directory.length > 0 && <ul className="grid gap-2 sm:grid-cols-2" aria-label="Schoolmates">{directory.map(member => <MemberRow key={member.id} member={member} onOpen={setProfileId}>
        <Button size="sm" icon="plus" disabled={!online || pending} onClick={() => void run(() => api.community.request.mutate({ accountId, userId: member.id }).then(() => undefined), `Request sent to ${member.displayName}.`)}>Add friend</Button>
      </MemberRow>)}</ul>}
      {!!friends?.blocked.length && <details className="group text-sm"><summary className="inline-flex cursor-pointer list-none items-center gap-1 font-semibold text-muted-foreground marker:hidden [&::-webkit-details-marker]:hidden">Blocked ({friends.blocked.length})<Icon name="chevronDown" size={14} className="transition-transform group-open:rotate-180" /></summary>
        <ul className="mt-2 grid gap-2">{friends.blocked.map(member => <li key={member.id} className="flex items-center justify-between gap-3 rounded-xl bg-muted/60 px-3 py-2"><span>{member.displayName}</span><Button size="sm" variant="ghost" disabled={!online || pending} onClick={() => void run(() => api.community.block.mutate({ accountId, userId: member.id, blocked: false }).then(() => undefined), `${member.displayName} is unblocked.`)}>Unblock</Button></li>)}</ul>
      </details>}
    </Section>

    {profileId && <ProfileSheet key={profileId} userId={profileId} state={state} onClose={closeProfile} onChanged={refresh} />}
    {proofOpen && <ProofSheet accountId={accountId} onClose={() => setProofOpen(false)} onSent={async result => { setProofOpen(false); await state.refresh(); setNotice(verificationNotice(result)); }} />}
  </div>;
}

type Verification = RouterOutput['community']['requestVerification'];

/**
 * What sending proof did. An already verified student (support approved an earlier request, or a school email now
 * matches) is verified at once, and the notice names how, the same way the verification section does.
 */
export function verificationNotice(result: Verification): string {
  if (result.status !== 'verified') return 'Sent to support.';
  return result.method === 'domain' ? 'You are verified through your school email address.' : 'You are already verified by support.';
}

function ProofSheet({ accountId, onClose, onSent }: { accountId: string; onClose: () => void; onSent: (result: Verification) => Promise<void> }) {
  const [proof, setProof] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  return <Modal open onClose={onClose} busy={pending} dirty={proof.trim().length > 0} title="Verify your school" description="Support checks your proof by hand. Do not include passwords or full ID numbers."
    footer={<><Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button><Spacer /><Button variant="primary" busy={pending} disabled={proof.trim().length < 10} onClick={async () => {
      setPending(true); setError('');
      try { const result = await api.community.requestVerification.mutate({ accountId, proof: proof.trim() }); await onSent(result); }
      catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
    }}>Send to support</Button></>}>
    <Field label="Your proof" htmlFor="proof" hint="A link to a photo of your student ID (cover the number), a schedule printout with your name, or your school email address if support can reach you there."><Textarea id="proof" minLength={10} maxLength={2000} rows={5} value={proof} onChange={event => setProof(event.target.value)} /></Field>
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
  </Modal>;
}

/** How many days ahead to look for a friend's next school day. */
const LOOKAHEAD_DAYS = 14;

function periodsOn(schedule: Schedule, date: string, personal: PersonalSchedule) {
  try { const day = resolveDay(schedule, date, personal); return day.closed ? [] : day.periods; } catch { return []; }
}

/** Today while it still has periods ahead, else the next day with classes (up to two weeks out), else today. */
function nextSchoolDay(schedule: Schedule, personal: PersonalSchedule, today: string, now: Date): string {
  const todays = periodsOn(schedule, today, personal);
  if (todays.length && now.getTime() < new Date(todays[todays.length - 1]!.endAt).getTime()) return today;
  for (let offset = 1; offset <= LOOKAHEAD_DAYS; offset += 1) {
    const date = addDays(today, offset);
    if (periodsOn(schedule, date, personal).length) return date;
  }
  return today;
}

/** "today", "tomorrow" or "on Monday, Sep 21", for use mid-sentence. */
function dayPhrase(date: string, today: string): string {
  const label = relativeDate(date, today, { weekday: 'long' });
  return label === 'Today' || label === 'Tomorrow' ? label.toLowerCase() : `on ${label}`;
}

function ProfileSheet({ userId, state, onClose, onChanged }: { userId: string; state: AppState; onClose: () => void; onChanged: () => Promise<void> }) {
  const accountId = state.context.user.id;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState('');
  /** Attach the chat's last CHAT.evidence messages to the report (only offered when the two of you have chatted). */
  const [includeChat, setIncludeChat] = useState(true);
  const [notice, setNotice] = useState('');
  /** Where the last action's result shows: at the top, or next to the Manage buttons that started it. */
  const [resultAt, setResultAt] = useState<'top' | 'manage'>('top');
  const [pickedDate, setPickedDate] = useState<string | null>(null);
  /** The in-place confirmation for Block or Remove friend (docs/CHAT.md §Dialogs: no native confirm()). */
  const [confirming, setConfirming] = useState<'block' | 'remove' | null>(null);
  const load = useCallback(async () => { try { setProfile(await api.community.profile.query({ userId })); } catch (err) { setError(errorMessage(err)); } }, [userId]);
  useEffect(() => { void load(); }, [load]);
  const run = async (action: () => Promise<unknown>, done?: string, at: 'top' | 'manage' = 'top') => {
    setPending(true); setError(''); setNotice(''); setResultAt(at);
    let failure: unknown = null;
    try { await action(); } catch (err) { failure = err; }
    // Reload after a refusal too, since some commit first (see the list's run); the action's error shows last.
    try { await load(); await onChanged(); await state.refresh(); if (failure) setError(errorMessage(failure)); else if (done) setNotice(done); } catch (err) { setError(errorMessage(failure ?? err)); } finally { setPending(false); }
  };
  const theirSchedule = useMemo(() => profile?.shared ? scheduleForGrade(profile.school.schedule, profile.shared.personal.grade) : null, [profile]);
  const defaultDate = useMemo(() => theirSchedule && profile?.shared ? nextSchoolDay(theirSchedule, profile.shared.personal, state.today, state.now) : state.today,
    [theirSchedule, profile?.shared, state.today, state.now]);
  const date = pickedDate ?? defaultDate;
  const day = useMemo(() => {
    if (!theirSchedule || !profile?.shared) return null;
    try { return resolveDay(theirSchedule, date, profile.shared.personal); } catch { return null; }
  }, [theirSchedule, profile, date]);
  const mine = state.personal;
  /**
   * True when I have the same class in this period (same directory entry, or the same words in any order). Only at
   * the same school: a friend who moved keeps the friendship, but their period ids belong to another timetable.
   */
  const togetherIn = (periodId: string, theirs: ClassLike) => {
    if (!profile?.sameSchool) return false;
    const own = mine.classes.find(cls => cls.id === mine.assignments[periodId]);
    return !!own && sameClass(own, theirs);
  };
  /** True when we sit in this class of theirs in at least one shared period. */
  const sharedClass = (cls: ClassLike & { id: string }) => Object.entries(profile?.shared?.personal.assignments ?? {}).some(([periodId, classId]) => classId === cls.id && togetherIn(periodId, cls));
  const name = profile?.displayName ?? 'Member';
  const dayLabel = relativeDate(date, state.today, { weekday: 'long' });
  const result = <>
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    {notice && <Callout tone="success" icon="check" role="status">{notice}</Callout>}
  </>;
  // The footer holds only the next step in the friendship; nothing destructive sits in the thumb spot.
  const nextStep = !profile ? null
    : profile.friendState === 'none' && !profile.blocked && profile.sameSchool ? <Button variant="primary" icon="plus" busy={pending} disabled={!state.online} onClick={() => void run(() => api.community.request.mutate({ accountId, userId }), 'Request sent.')}>Add friend</Button>
    : profile.friendState === 'requested' ? <Button busy={pending} disabled={!state.online} onClick={() => void run(() => api.community.remove.mutate({ accountId, userId }), 'Request cancelled.')}>Cancel request</Button>
    : profile.friendState === 'incoming' ? <Button variant="primary" icon="check" busy={pending} disabled={!state.online} onClick={() => void run(() => api.community.respond.mutate({ accountId, userId, accept: true }), `You and ${name} are now friends.`)}>Accept request</Button>
    : profile.friendState === 'friends' ? <Button variant="primary" icon="message" disabled={pending} onClick={() => state.navigate('messages', { with: userId })}>Message</Button>
    : null;
  const attachChat = !!profile?.hasChat && includeChat;
  const sendReport = async () => {
    // With the chat attached this is a chat report (category "Something else", the typed reason as its note);
    // otherwise the phase-3 profile report, unchanged.
    if (attachChat) await api.chat.report.mutate({ accountId, userId, category: 'other', note: reason.trim(), block: false });
    else await api.community.report.mutate({ accountId, userId, reason: reason.trim() });
    setReporting(false); setReason(''); setIncludeChat(true);
  };
  const cancelReport = () => { setReporting(false); setReason(''); setIncludeChat(true); };
  return <Modal open onClose={onClose} busy={pending} dirty={reporting && reason.trim().length > 0} title={name} description={profile ? [profile.fullName, profile.grade ? gradeLabel(profile.grade) : null, profile.school.name, `Joined ${formatDate(instantParts(profile.joinedAt, state.timeZone).date, { year: true })}`].filter(Boolean).join(' · ') : undefined}
    footer={nextStep ? <><Spacer />{nextStep}</> : undefined}>
    {(!profile || resultAt === 'top') && result}
    {!profile && !error && <Hint role="status">Loading profile…</Hint>}
    {profile && <>
      <div className="flex flex-wrap items-center gap-3">
        <MemberAvatar name={profile.displayName} size="lg" />
        <div className="flex flex-wrap gap-1.5">
          {profile.verified ? <Chip tone="success" icon="checkCircle">Verified at {profile.school.name}</Chip> : <Chip tone="outline">Not verified</Chip>}
          {profile.friendState === 'friends' && <Chip tone="accent" icon="star">Friend</Chip>}
          <Chip icon="users">{pluralize(profile.friendCount, 'friend')}</Chip>
        </div>
      </div>
      {!profile.shared && <Callout tone="neutral" icon="lock">Classes and timetable are shared between friends only.{profile.sameSchool && profile.friendState === 'none' ? ' Send a request to compare schedules.' : ''}</Callout>}
      {profile.shared && <>
        <Section id="profile-classes" title="Classes" icon="book" description={profile.shared.classes.length ? [pluralize(profile.shared.classes.length, 'class', 'classes'), profile.sameSchool ? `${profile.shared.classes.filter(sharedClass).length} in common with you` : null].filter(Boolean).join(' · ') : undefined}>
          {profile.shared.classes.length === 0 && <Hint>{name} has not added classes yet.</Hint>}
          {profile.shared.classes.length > 0 && <ul className="grid gap-2">{profile.shared.classes.map(cls => {
            const color = classColor(cls.id, 'class', cls.color);
            const together = sharedClass(cls);
            return <li key={cls.id} className="flex items-start gap-3 rounded-xl px-3 py-2.5 ring-1 ring-inset ring-foreground/[0.05]" style={{ background: color.soft }}>
              <span aria-hidden="true" className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: color.dot }} />
              <span className="min-w-0 flex-1"><strong className="line-clamp-2 text-sm font-bold leading-snug" title={cls.name}>{cls.name}</strong><Hint className="truncate">{[cls.room && formatRoom(cls.room), cls.teacher].filter(Boolean).join(' · ')}</Hint></span>
              {together && <Chip tone="accent" icon="check" className="shrink-0">Together</Chip>}
            </li>;
          })}</ul>}
        </Section>
        <Section id="profile-day" title={`${name}’s day`} icon="calendar"
          description={day ? (day.closed ? `${dayLabel} · no school` : `${dayLabel} · ${day.cycleDayLabel}${day.periods.length ? ` · ${formatRange(day.periods[0]!.start, day.periods[day.periods.length - 1]!.end)}` : ''}`) : 'Their schedule could not be read.'}
          action={day ? <div className="flex items-center gap-1">
            <IconButton label="Previous day" icon="chevronLeft" size="sm" disabled={date <= state.today} onClick={() => setPickedDate(addDays(date, -1))} />
            <IconButton label="Next day" icon="chevronRight" size="sm" onClick={() => setPickedDate(addDays(date, 1))} />
          </div> : undefined}>
          {day && !day.closed && day.periods.length > 0 && <Timeline periods={day.periods} now={state.now} compact timeZone={profile.school.schedule.timeZone} tag={(period) => period.class && togetherIn(period.periodId, period.class) ? 'Together' : null} />}
          {day && (day.closed || day.periods.length === 0) && <Hint>{day.closed ? `No school ${dayPhrase(date, state.today)}.` : `Nothing scheduled ${dayPhrase(date, state.today)}.`}</Hint>}
        </Section>
      </>}
      <div role="group" aria-label="Manage" className="grid gap-3 border-t pt-4">
        <Eyebrow>Manage</Eyebrow>
        <div className="flex flex-wrap items-center gap-2">
          {!reporting && <Button size="sm" variant="ghost" disabled={!state.online || pending} onClick={() => { setReporting(true); setNotice(''); }}>Report</Button>}
          <Button size="sm" variant="ghost" disabled={!state.online || pending} aria-expanded={profile.blocked ? undefined : confirming === 'block'} onClick={() => {
            if (profile.blocked) void run(() => api.community.block.mutate({ accountId, userId, blocked: false }), 'Unblocked.', 'manage');
            else { setConfirming('block'); setNotice(''); }
          }}>{profile.blocked ? 'Unblock' : 'Block'}</Button>
          {profile.friendState === 'friends' && <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={!state.online || pending} aria-expanded={confirming === 'remove'} onClick={() => { setConfirming('remove'); setNotice(''); }}>Remove friend</Button>}
        </div>
        {confirming === 'block' && !profile.blocked && <Callout tone="warning" icon="alert" role="alert" title={`Block ${name}?`} actions={<>
          <Button size="sm" variant="danger" busy={pending} disabled={!state.online} onClick={() => void run(async () => { await api.community.block.mutate({ accountId, userId, blocked: true }); setConfirming(null); }, 'Blocked.', 'manage')}>Block {name}</Button>
          <Button size="sm" autoFocus disabled={pending} onClick={() => setConfirming(null)}>Cancel</Button>
        </>}>You will not see each other in the directory, their Global chat messages are hidden from you, and any friendship ends.</Callout>}
        {confirming === 'remove' && profile.friendState === 'friends' && <Callout tone="warning" icon="alert" role="alert" title={`Remove ${name} as a friend?`} actions={<>
          <Button size="sm" variant="danger" busy={pending} disabled={!state.online} onClick={() => void run(async () => { await api.community.remove.mutate({ accountId, userId }); setConfirming(null); }, 'Friend removed.', 'manage')}>Remove {name}</Button>
          <Button size="sm" autoFocus disabled={pending} onClick={() => setConfirming(null)}>Cancel</Button>
        </>}>They will no longer see your classes, and you will not see theirs.</Callout>}
        {reporting && <Panel className="grid gap-3 bg-card ring-2 ring-destructive/30">
          <strong className="text-sm font-bold">Report {name} to support</strong>
          <Field label="What happened?" htmlFor="report-reason" hint="Support reads every report. Reports are private."><Textarea id="report-reason" autoFocus minLength={10} maxLength={2000} rows={4} value={reason} onChange={event => setReason(event.target.value)} /></Field>
          {profile.hasChat && <div className="flex items-center gap-2"><Checkbox id="report-include-chat" checked={includeChat} disabled={pending} onCheckedChange={checked => setIncludeChat(checked === true)} /><Label htmlFor="report-include-chat" className="text-sm font-semibold">Include our last {CHAT.evidence} messages</Label></div>}
          <div className="flex gap-2"><Button size="sm" variant="danger" busy={pending} disabled={reason.trim().length < 10} onClick={() => void run(sendReport, 'Report sent to support.', 'manage')}>Send report</Button><Button size="sm" variant="ghost" disabled={pending} onClick={cancelReport}>Cancel</Button></div>
        </Panel>}
        {resultAt === 'manage' && result}
      </div>
    </>}
  </Modal>;
}
