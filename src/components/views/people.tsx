'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import { gradeLabel, resolveDay, scheduleForGrade } from '@/domain/schedule';
import { classColor, formatDate, formatRange, pluralize } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AppState } from '../app-state';
import { Icon } from '../icon';
import { Button, Callout, Chip, EmptyState, Field, Hint, Input, Modal, Panel, Section, Spacer, Textarea } from '../primitives';
import { Timeline } from './today';

type Member = RouterOutput['community']['members']['members'][number];
type Friends = RouterOutput['community']['friends'];
type Profile = RouterOutput['community']['profile'];

function MemberAvatar({ name, size = 'md' }: { name: string; size?: 'md' | 'lg' }) {
  return <span aria-hidden="true" className={cn('grid shrink-0 place-items-center rounded-full font-extrabold text-primary-foreground', size === 'lg' ? 'size-14 text-xl' : 'size-10 text-sm')}
    style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--primary) 75%, white) 0%, var(--primary) 60%, color-mix(in srgb, var(--primary) 70%, black) 100%)' }}>{(name || '?').slice(0, 1).toUpperCase()}</span>;
}

function MemberRow({ member, onOpen, children }: { member: Member; onOpen: (id: string) => void; children?: React.ReactNode }) {
  return <li className="flex flex-wrap items-center gap-3 rounded-2xl bg-muted/60 p-3 ring-1 ring-inset ring-foreground/[0.04]">
    <button type="button" className="flex min-w-0 flex-1 basis-[200px] items-center gap-3 text-left" onClick={() => onOpen(member.id)} aria-label={`Open ${member.displayName}’s profile`}>
      <MemberAvatar name={member.displayName} />
      <span className="grid min-w-0">
        <strong className="flex items-center gap-1.5 truncate text-sm font-bold">{member.displayName}{member.verified && <Icon name="checkCircle" size={14} className="shrink-0 text-success" aria-label="Verified member" />}</strong>
        <Hint className="truncate">{[member.fullName, member.grade ? gradeLabel(member.grade) : null, member.friendState === 'friends' ? 'Friend' : member.friendState === 'requested' ? 'Request sent' : member.friendState === 'incoming' ? 'Wants to be friends' : null].filter(Boolean).join(' · ') || 'Member'}</Hint>
      </span>
    </button>
    {children}
  </li>;
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

  const refresh = useCallback(async () => {
    if (!online) return;
    try {
      const [friendList, memberList] = await Promise.all([api.community.friends.query(), api.community.members.query({ query })]);
      setFriends(friendList); setMembers(memberList.members);
    } catch (err) { setError(errorMessage(err)); }
  }, [online, query]);
  useEffect(() => { void refresh(); }, [refresh]);
  const run = async (action: () => Promise<void>, done?: string) => {
    setPending(true); setError(''); setNotice('');
    try { await action(); await refresh(); await state.refresh(); if (done) setNotice(done); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
  };
  const friendIds = useMemo(() => new Set((friends?.friends ?? []).map(member => member.id)), [friends]);
  const directory = (members ?? []).filter(member => !friendIds.has(member.id));

  return <div className="grid gap-5 animate-in fade-in-0 duration-300">
    <header className="grid gap-1">
      <h1>People</h1>
      <p className="text-sm text-muted-foreground">{context.school.name} · {pluralize(context.school.memberCount, 'member')} · {pluralize(context.community?.friendCount ?? 0, 'friend')}</p>
    </header>
    {!online && <Callout tone="neutral" icon="cloudOff">Connect to browse schoolmates and manage friends.</Callout>}
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
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
        {(friends?.incoming.length ?? 0) === 0 && (friends?.outgoing.length ?? 0) === 0 && <Hint>No requests waiting.</Hint>}
        {!!friends?.incoming.length && <ul className="grid gap-2" aria-label="Incoming friend requests">{friends.incoming.map(member => <MemberRow key={member.id} member={member} onOpen={setProfileId}>
          <div className="flex gap-1.5">
            <Button size="sm" variant="primary" icon="check" disabled={!online || pending} onClick={() => void run(() => api.community.respond.mutate({ accountId, userId: member.id, accept: true }).then(() => undefined), `You and ${member.displayName} are now friends.`)}>Accept</Button>
            <Button size="sm" variant="ghost" disabled={!online || pending} onClick={() => void run(() => api.community.respond.mutate({ accountId, userId: member.id, accept: false }).then(() => undefined))}>Decline</Button>
          </div>
        </MemberRow>)}</ul>}
        {!!friends?.outgoing.length && <ul className="grid gap-2" aria-label="Sent friend requests">{friends.outgoing.map(member => <MemberRow key={member.id} member={member} onOpen={setProfileId}>
          <Button size="sm" variant="ghost" disabled={!online || pending} onClick={() => void run(() => api.community.remove.mutate({ accountId, userId: member.id }).then(() => undefined))}>Cancel request</Button>
        </MemberRow>)}</ul>}
      </Section>
    </div>

    <Section id="friends-title" title="Friends" icon="star" description={friends ? pluralize(friends.friends.length, 'friend') : undefined}>
      {friends && friends.friends.length === 0 && <EmptyState icon="users" title="No friends yet">Find schoolmates below and send a request. Once they accept, you can compare classes and see each other’s day.</EmptyState>}
      {!!friends?.friends.length && <ul className="grid gap-2 sm:grid-cols-2" aria-label="Friends">{friends.friends.map(member => <MemberRow key={member.id} member={member} onOpen={setProfileId}>
        <Button size="sm" iconRight="arrowRight" onClick={() => setProfileId(member.id)}>See day</Button>
      </MemberRow>)}</ul>}
    </Section>

    <Section id="members-title" title="Schoolmates" icon="search" description="Everyone who joined this school on Quasar. Names shown in full only when you are both verified."
      action={<div className="relative"><Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" /><Input small className="max-w-[240px] pl-8" aria-label="Search schoolmates" placeholder="Search by name" value={query} onChange={event => setQuery(event.target.value)} /></div>}>
      {members && directory.length === 0 && <Hint>{query ? 'No schoolmates match that name.' : 'Nobody else has joined yet. Invite your schoolmates.'}</Hint>}
      {directory.length > 0 && <ul className="grid gap-2 sm:grid-cols-2" aria-label="Schoolmates">{directory.map(member => <MemberRow key={member.id} member={member} onOpen={setProfileId}>
        {member.friendState === 'none' && <Button size="sm" icon="plus" disabled={!online || pending} onClick={() => void run(() => api.community.request.mutate({ accountId, userId: member.id }).then(() => undefined), `Request sent to ${member.displayName}.`)}>Add friend</Button>}
        {member.friendState === 'incoming' && <Button size="sm" variant="primary" icon="check" disabled={!online || pending} onClick={() => void run(() => api.community.respond.mutate({ accountId, userId: member.id, accept: true }).then(() => undefined))}>Accept</Button>}
        {member.friendState === 'requested' && <Chip icon="clock">Requested</Chip>}
      </MemberRow>)}</ul>}
      {!!friends?.blocked.length && <details className="text-sm"><summary className="cursor-pointer font-semibold text-muted-foreground">Blocked ({friends.blocked.length})</summary>
        <ul className="mt-2 grid gap-2">{friends.blocked.map(member => <li key={member.id} className="flex items-center justify-between gap-3 rounded-xl bg-muted/60 px-3 py-2"><span>{member.displayName}</span><Button size="sm" variant="ghost" disabled={!online || pending} onClick={() => void run(() => api.community.block.mutate({ accountId, userId: member.id, blocked: false }).then(() => undefined), `${member.displayName} is unblocked.`)}>Unblock</Button></li>)}</ul>
      </details>}
    </Section>

    {profileId && <ProfileSheet key={profileId} userId={profileId} state={state} onClose={() => setProfileId(null)} onChanged={refresh} />}
    {proofOpen && <ProofSheet accountId={accountId} onClose={() => setProofOpen(false)} onSent={async () => { setProofOpen(false); await state.refresh(); setNotice('Sent to support.'); }} />}
  </div>;
}

function ProofSheet({ accountId, onClose, onSent }: { accountId: string; onClose: () => void; onSent: () => Promise<void> }) {
  const [proof, setProof] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  return <Modal open onClose={onClose} title="Verify your school" description="Support checks your proof by hand. Do not include passwords or full ID numbers."
    footer={<><Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button><Spacer /><Button variant="primary" busy={pending} disabled={proof.trim().length < 10} onClick={async () => {
      setPending(true); setError('');
      try { const result = await api.community.requestVerification.mutate({ accountId, proof: proof.trim() }); await onSent(); if (result.status === 'verified') return; }
      catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
    }}>Send to support</Button></>}>
    <Field label="Your proof" htmlFor="proof" hint="A link to a photo of your student ID (cover the number), a schedule printout with your name, or your school email address if support can reach you there."><Textarea id="proof" minLength={10} maxLength={2000} rows={5} value={proof} onChange={event => setProof(event.target.value)} /></Field>
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
  </Modal>;
}

function ProfileSheet({ userId, state, onClose, onChanged }: { userId: string; state: AppState; onClose: () => void; onChanged: () => Promise<void> }) {
  const accountId = state.context.user.id;
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => { try { setProfile(await api.community.profile.query({ userId })); } catch (err) { setError(errorMessage(err)); } }, [userId]);
  useEffect(() => { void load(); }, [load]);
  const run = async (action: () => Promise<unknown>, done?: string) => {
    setPending(true); setError(''); setNotice('');
    try { await action(); await load(); await onChanged(); await state.refresh(); if (done) setNotice(done); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
  };
  const day = useMemo(() => {
    if (!profile?.shared) return null;
    try { return resolveDay(scheduleForGrade(profile.school.schedule, profile.shared.personal.grade), state.today, profile.shared.personal); } catch { return null; }
  }, [profile, state.today]);
  const myClasses = state.personal.classes;
  const sharedClass = (name: string) => myClasses.some(cls => cls.name.trim().toLowerCase() === name.trim().toLowerCase());
  const name = profile?.displayName ?? 'Member';
  return <Modal open onClose={onClose} title={name} description={profile ? [profile.fullName, profile.grade ? gradeLabel(profile.grade) : null, profile.school.name, `Joined ${formatDate(profile.joinedAt.slice(0, 10), { year: true })}`].filter(Boolean).join(' · ') : undefined}
    footer={profile ? <>
      <Button variant="ghost" onClick={onClose} disabled={pending}>Close</Button>
      <Spacer />
      {!reporting && <Button size="sm" variant="ghost" disabled={!state.online || pending} onClick={() => setReporting(true)}>Report</Button>}
      <Button size="sm" variant="ghost" disabled={!state.online || pending} onClick={() => { if (profile.blocked || confirm(`Block ${name}? You will not see each other in the directory, and any friendship ends.`)) void run(() => api.community.block.mutate({ accountId, userId, blocked: !profile.blocked }), profile.blocked ? 'Unblocked.' : 'Blocked.'); }}>{profile.blocked ? 'Unblock' : 'Block'}</Button>
      {profile.friendState === 'none' && !profile.blocked && profile.sameSchool && <Button variant="primary" icon="plus" busy={pending} disabled={!state.online} onClick={() => void run(() => api.community.request.mutate({ accountId, userId }), 'Request sent.')}>Add friend</Button>}
      {profile.friendState === 'requested' && <Button busy={pending} disabled={!state.online} onClick={() => void run(() => api.community.remove.mutate({ accountId, userId }), 'Request cancelled.')}>Cancel request</Button>}
      {profile.friendState === 'incoming' && <Button variant="primary" icon="check" busy={pending} disabled={!state.online} onClick={() => void run(() => api.community.respond.mutate({ accountId, userId, accept: true }), `You and ${name} are now friends.`)}>Accept request</Button>}
      {profile.friendState === 'friends' && <Button variant="danger" busy={pending} disabled={!state.online} onClick={() => { if (confirm(`Remove ${name} as a friend? They will no longer see your classes, and you will not see theirs.`)) void run(() => api.community.remove.mutate({ accountId, userId }), 'Friend removed.'); }}>Remove friend</Button>}
    </> : undefined}>
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    {notice && <Callout tone="success" icon="check" role="status">{notice}</Callout>}
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
      {reporting && <Panel className="grid gap-3 bg-card ring-2 ring-destructive/30">
        <strong className="text-sm font-bold">Report {name} to support</strong>
        <Field label="What happened?" htmlFor="report-reason" hint="Support reads every report. Reports are private."><Textarea id="report-reason" minLength={10} maxLength={2000} rows={4} value={reason} onChange={event => setReason(event.target.value)} /></Field>
        <div className="flex gap-2"><Button size="sm" variant="danger" busy={pending} disabled={reason.trim().length < 10} onClick={() => void run(async () => { await api.community.report.mutate({ accountId, userId, reason: reason.trim() }); setReporting(false); setReason(''); }, 'Report sent to support.')}>Send report</Button><Button size="sm" variant="ghost" disabled={pending} onClick={() => setReporting(false)}>Cancel</Button></div>
      </Panel>}
      {!profile.shared && <Callout tone="neutral" icon="lock">Classes and timetable are shared between friends only.{profile.sameSchool && profile.friendState === 'none' ? ' Send a request to compare schedules.' : ''}</Callout>}
      {profile.shared && <>
        <Section id="profile-classes" title="Classes" icon="book" description={profile.shared.classes.length ? `${pluralize(profile.shared.classes.length, 'class', 'classes')} · ${profile.shared.classes.filter(cls => sharedClass(cls.name)).length} in common with you` : undefined}>
          {profile.shared.classes.length === 0 && <Hint>{name} has not added classes yet.</Hint>}
          {profile.shared.classes.length > 0 && <ul className="grid gap-2">{profile.shared.classes.map(cls => {
            const color = classColor(cls.id, 'class', cls.color);
            const together = sharedClass(cls.name);
            return <li key={cls.id} className="flex items-start gap-3 rounded-xl px-3 py-2.5 ring-1 ring-inset ring-foreground/[0.05]" style={{ background: color.soft }}>
              <span aria-hidden="true" className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: color.dot }} />
              <span className="min-w-0 flex-1"><strong className="line-clamp-2 text-sm font-bold leading-snug" title={cls.name}>{cls.name}</strong><Hint className="truncate">{[cls.teacher, cls.room && `Room ${cls.room}`].filter(Boolean).join(' · ')}</Hint></span>
              {together && <Chip tone="accent" icon="check" className="shrink-0">Together</Chip>}
            </li>;
          })}</ul>}
        </Section>
        <Section id="profile-day" title={`${name}’s day`} icon="calendar" description={day ? (day.closed ? `${formatDate(state.today, { weekday: 'long' })} · no school` : `${formatDate(state.today, { weekday: 'long' })} · ${day.cycleDayLabel}${day.periods.length ? ` · ${formatRange(day.periods[0]!.start, day.periods[day.periods.length - 1]!.end)}` : ''}`) : 'Their schedule could not be read.'}>
          {day && !day.closed && day.periods.length > 0 && <Timeline periods={day.periods} now={state.now} compact timeZone={profile.school.schedule.timeZone} />}
          {day && (day.closed || day.periods.length === 0) && <Hint>Nothing scheduled today.</Hint>}
        </Section>
      </>}
    </>}
  </Modal>;
}
