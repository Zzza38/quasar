'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, errorMessage, type RouterOutput, type School } from '@/client/api';
import { GRADES, effectiveSchedule, gradeLabel, personalScheduleSchema, type Grade, type PersonalSchedule, type StudentClass } from '@/domain/schedule';
import { REPORT_CATEGORIES, type ReportCategory } from '@/domain/chat';
import { browserTimeZone, classColor, formatDate, formatTime, instantParts, pluralize, slugId } from '@/lib/format';
import { Icon } from './icon';
import { removeClass as removeClassEverywhere } from './personal-timetable';
import { Button, Callout, Chip, ColorDot, Field, Hint, IconButton, Input, Modal, Panel, Section, Select, Spacer, Textarea, Toggle } from './primitives';
import { ColorPicker } from './ui/color-picker';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

/**
 * The owner's user console (/admin → People): find any member, open their whole record, and change it. The server
 * side is src/server/support.ts. One-to-one chats appear as metadata only; their text reaches support only through
 * a report (docs/CHAT.md). Every open and every change is written to the audit log with the owner's reason.
 */

type SearchRow = RouterOutput['admin']['users']['search'][number];
type SupportRecord = RouterOutput['admin']['users']['view'];
type SupportTask = SupportRecord['tasks'][number];
type GlobalPost = SupportRecord['globalMessages'][number];
export type AuditEntry = RouterOutput['admin']['auditLog'][number];
/** Who the console is about to open, and why (kept in memory for the page's lifetime, per member). */
export type MemberTarget = { userId: string; name: string };
export type PauseRequest = { userId: string; name: string };

/** Admin has no AppState, so instants are shown in the browser's time zone. */
export function formatInstant(iso: string): string {
  const { date, time } = instantParts(iso, browserTimeZone());
  return `${formatDate(date, { weekday: 'short', year: true })}, ${formatTime(time)}`;
}
const shortDate = (iso: string) => formatDate(instantParts(iso, browserTimeZone()).date, { year: true });
const TAB_CLASS = 'rounded-lg px-3 font-semibold data-active:bg-card data-active:shadow-[0_1px_2px_rgb(0_0_0/0.08)] dark:data-active:bg-secondary';
const ROW_CLASS = 'grid gap-2 rounded-2xl bg-muted/70 p-4 ring-1 ring-inset ring-foreground/[0.04]';

/* ---------- Reasons ---------- */

/** Quick answers for the reason an owner opens a member's record; any other reason can be typed. */
const VIEW_REASONS = ['Answering their support request', 'Reviewing a report', 'Fixing their account', 'Fixing their classes or tasks'] as const;

/**
 * Asks for the reason the audit log keeps with a change (or with opening a record). Confirming runs `onConfirm`;
 * the dialog stays open with the error if it throws, and the parent closes it when it succeeds.
 */
export function ReasonModal({ title, description, confirm, tone = 'primary', presets, onConfirm, onClose }: {
  title: string; description: ReactNode; confirm: string; tone?: 'primary' | 'danger'; presets?: readonly string[];
  onConfirm: (reason: string) => Promise<void>; onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const trimmed = reason.trim();
  const submit = async (value = trimmed) => {
    setPending(true); setError('');
    try { await onConfirm(value); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
  };
  return <Modal open onClose={onClose} busy={pending} dirty={reason.length > 0} title={title} description={description}
    footer={<><Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button><Spacer /><Button variant={tone} busy={pending} disabled={trimmed.length < 3} onClick={() => void submit()}>{confirm}</Button></>}>
    {presets && <div className="flex flex-wrap gap-2">{presets.map((preset) => <Button key={preset} size="sm" variant="soft" disabled={pending} onClick={() => { setReason(preset); void submit(preset); }}>{preset}</Button>)}</div>}
    <Field label="Reason for the audit log" htmlFor="support-reason" hint="At least 3 characters.">
      <Textarea id="support-reason" autoFocus={!presets} maxLength={500} value={reason} disabled={pending} onChange={(event) => setReason(event.target.value)} />
    </Field>
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
  </Modal>;
}

/** The reason step before a record opens. */
export function OpenMemberModal({ target, onOpen, onClose }: { target: MemberTarget; onOpen: (reason: string) => void; onClose: () => void }) {
  return <ReasonModal title={`Open ${target.name || 'this member'}’s record?`} confirm="Open record" presets={VIEW_REASONS}
    description="Their record shows their account, school, classes, tasks, friends and Global chat posts. Opening it is written to the audit log with your reason. Private chat text is never shown."
    onConfirm={async (reason) => onOpen(reason)} onClose={onClose} />;
}

/* ---------- Search ---------- */

export function PeopleSection({ schools, onOpen }: { schools: School[]; onOpen: (target: MemberTarget) => void }) {
  const [query, setQuery] = useState('');
  const [schoolId, setSchoolId] = useState('');
  const [rows, setRows] = useState<SearchRow[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let live = true;
    // Typing waits a moment so each keystroke is not a request.
    const timer = setTimeout(async () => {
      setLoading(true); setError('');
      try { const result = await api.admin.users.search.query({ query, ...(schoolId ? { schoolId } : {}) }); if (live) setRows(result); }
      catch (err) { if (live) setError(errorMessage(err)); }
      finally { if (live) setLoading(false); }
    }, query ? 300 : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [query, schoolId]);
  return <Section id="people-title" title="People" icon="users" description="Find any member by email, name or account ID. The newest 100 matches are shown.">
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_240px]">
      <div className="relative"><Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" /><Input className="pl-8" aria-label="Search members" placeholder="Email, name or account ID" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <Select aria-label="School" value={schoolId} onChange={(event) => setSchoolId(event.target.value)}>
        <option value="">Every school</option>
        {schools.map((school) => <option key={school.id} value={school.id}>{school.name}</option>)}
      </Select>
    </div>
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    {rows && rows.length === 0 && !loading && <Hint>No members match.</Hint>}
    {rows && rows.length > 0 && <div className="overflow-hidden rounded-2xl ring-1 ring-foreground/[0.06]"><Table aria-busy={loading}>
      <TableHeader className="bg-muted/70"><TableRow><TableHead>Member</TableHead><TableHead>School</TableHead><TableHead>Status</TableHead><TableHead>Joined</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
      <TableBody>{rows.map((row) => <TableRow key={row.id}>
        <TableCell className="whitespace-normal"><strong className="text-sm font-bold">{row.displayName || 'No name yet'}</strong>{row.fullName && <span className="text-sm text-muted-foreground"> · {row.fullName}</span>}<Hint className="break-all">{row.email}</Hint></TableCell>
        <TableCell className="whitespace-normal text-sm">{row.schoolName ?? <span className="text-muted-foreground">None</span>}</TableCell>
        <TableCell><div className="flex flex-wrap gap-1">{row.verified && <Chip tone="success" icon="check">Verified</Chip>}{row.suspended && <Chip tone="danger" icon="lock">Suspended</Chip>}{row.paused && <Chip tone="warning" icon="lock">Paused</Chip>}{row.openReports > 0 && <Chip tone="danger" icon="alert">{pluralize(row.openReports, 'report')}</Chip>}</div></TableCell>
        <TableCell className="text-sm tabular-nums">{shortDate(row.createdAt)}</TableCell>
        <TableCell className="text-right"><Button size="sm" variant="soft" onClick={() => onOpen({ userId: row.id, name: row.displayName || row.email })} aria-label={`Open ${row.displayName || row.email}`}>Open</Button></TableCell>
      </TableRow>)}</TableBody>
    </Table></div>}
  </Section>;
}

/* ---------- Audit log ---------- */

const ACTION_LABELS: Record<string, string> = {
  'support.viewUser': 'Opened a member’s record', 'support.editAccount': 'Edited account', 'support.suspend': 'Suspended account', 'support.unsuspend': 'Lifted suspension',
  'support.signOut': 'Signed out everywhere', 'support.removeBrowsers': 'Forgot reminder browsers', 'support.moveSchool': 'Moved school', 'support.verify': 'Verified', 'support.unverify': 'Removed verification',
  'support.unban': 'Lifted a removal', 'support.editClasses': 'Edited classes', 'support.editTask': 'Edited a task', 'support.deleteTask': 'Deleted a task', 'support.removeFriendship': 'Ended a friendship',
  'support.feed.enable': 'Resumed a calendar feed', 'support.feed.disable': 'Paused a calendar feed', 'support.feed.remove': 'Removed a calendar feed', 'support.renameSchool': 'Renamed a school',
  'support.resolveRequest': 'Resolved a support request', 'report.resolve': 'Closed a report', 'reports.view': 'Opened report messages', 'verification.approve': 'Approved verification', 'verification.decline': 'Declined verification',
  'proposal.decline': 'Declined a proposal', 'member.remove': 'Removed from school', 'chat.pause': 'Paused messaging', 'chat.resume': 'Lifted a messaging pause', 'chat.redact': 'Hid a chat message',
  'global.delete': 'Removed a Global chat message', 'global.edit': 'Edited a Global chat message', 'admin.denied': 'Tried an owner tool (refused)', 'school.create': 'Created a school', 'school.join': 'Joined a school',
  'school.update': 'Edited the school schedule', 'school.adminUpdate': 'Published a school revision', 'school.proposalApplied': 'Applied a proposal', 'school.menu': 'Changed the lunch menu', 'menu.lookup': 'Looked up a lunch menu',
  'directory.create': 'Added a directory class', 'directory.update': 'Edited a directory class', 'directory.remove': 'Removed a directory class', 'calendar.add': 'Added a calendar feed', 'schedule.scan': 'Scanned a timetable',
};
/**
 * The detail's reason, if any, then its other fields as plain text. Never rendered as markup. The member ids the
 * row is about are left out when the table shows that member by name instead.
 */
function describeDetail(detail: unknown, resolved: boolean): string {
  if (!detail || typeof detail !== 'object') return typeof detail === 'string' ? detail : '';
  const { reason, ...rest } = detail as Record<string, unknown>;
  const fields = Object.entries(rest).filter(([key]) => !(resolved && (key === 'userId' || key === 'senderId'))).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' · ');
  return [typeof reason === 'string' && reason ? `“${reason}”` : '', fields].filter(Boolean).join(' · ');
}

/**
 * Owner rows also name the member they are about, as a link to their record when `onOpenMember` is given. Inside
 * one member's own Activity tab (`subjectId`) that would be every row, so the name is left out there.
 */
export function AuditTable({ entries, subjectId, onOpenMember }: { entries: AuditEntry[]; subjectId?: string; onOpenMember?: (target: MemberTarget) => void }) {
  if (entries.length === 0) return <Hint>Nothing recorded yet.</Hint>;
  return <div className="overflow-hidden rounded-2xl ring-1 ring-foreground/[0.06]"><Table>
    <TableHeader className="bg-muted/70"><TableRow><TableHead>When</TableHead><TableHead>Who</TableHead><TableHead>What</TableHead><TableHead>From</TableHead></TableRow></TableHeader>
    <TableBody>{entries.map((entry) => {
      const target = entry.target && entry.target.userId !== subjectId ? entry.target : null;
      const targetName = target ? target.displayName || target.email : '';
      return <TableRow key={entry.id}>
      <TableCell className="whitespace-nowrap text-sm tabular-nums">{formatInstant(entry.createdAt)}</TableCell>
      <TableCell className="whitespace-normal text-sm">{entry.actorName || entry.actorEmail}<Hint className="break-all">{entry.actorEmail}</Hint>
        {target && <Hint className="break-all">about {onOpenMember
          ? <button type="button" className="font-semibold text-foreground underline-offset-2 hover:underline" onClick={() => onOpenMember({ userId: target.userId, name: targetName })}>{targetName}</button>
          : <span className="font-semibold text-foreground">{targetName}</span>}</Hint>}</TableCell>
      <TableCell className="min-w-[240px] whitespace-normal text-sm"><strong className="font-semibold">{ACTION_LABELS[entry.action] ?? entry.action}</strong>{entry.schoolName && <span className="text-muted-foreground"> · {entry.schoolName}</span>}<Hint className="break-words">{describeDetail(entry.detail, entry.target !== null)}</Hint></TableCell>
      <TableCell className="whitespace-normal text-sm">{entry.ip ?? '—'}{entry.userAgent && <Hint className="max-w-[220px] truncate" >{entry.userAgent}</Hint>}</TableCell>
    </TableRow>; })}</TableBody>
  </Table></div>;
}

export function AuditLogSection({ onOpenMember }: { onOpenMember: (target: MemberTarget) => void }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async (before?: number) => {
    setLoading(true); setError('');
    try {
      const page = await api.admin.auditLog.query(before ? { before } : {});
      setEntries((current) => before ? [...current, ...page] : page); setDone(page.length < 100);
    } catch (err) { setError(errorMessage(err)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return <Section id="audit-title" title="Audit log" icon="book" description="Every owner action and every member change the server records, newest first. Owner actions include the address and browser they came from; an entry you don’t recognize means your session may be in someone else’s hands (sign out everywhere from your own record)." action={<Button size="sm" variant="ghost" icon="refresh" busy={loading && entries.length === 0} onClick={() => void load()}>Refresh</Button>}>
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    <AuditTable entries={entries} onOpenMember={onOpenMember} />
    {!done && entries.length > 0 && <div><Button size="sm" busy={loading} onClick={() => void load(entries[entries.length - 1]!.id)}>Show older</Button></div>}
  </Section>;
}

/* ---------- Member record ---------- */

type Ask = { title: string; description: ReactNode; confirm: string; tone?: 'primary' | 'danger'; run: (reason: string) => Promise<unknown> };

export function MemberRecord({ accountId, target, reason, schools, refreshKey, onClose, onOpenMember, onPause, onChanged }: {
  accountId: string; target: MemberTarget; reason: string; schools: School[]; refreshKey: number; onClose: () => void;
  onOpenMember: (target: MemberTarget) => void; onPause: (target: PauseRequest) => void; onChanged: () => Promise<void>;
}) {
  const [record, setRecord] = useState<SupportRecord | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [tab, setTab] = useState('overview');
  const reload = useCallback(async () => {
    try { setRecord(await api.admin.users.view.mutate({ accountId, userId: target.userId, reason })); }
    catch (err) { setError(errorMessage(err)); }
  }, [accountId, target.userId, reason]);
  useEffect(() => { void reload(); }, [reload, refreshKey]);
  /** Runs a change, then reloads the record and the console's lists. Errors stay on screen. */
  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true); setError('');
    try { await action(); return true; }
    catch (err) { setError(errorMessage(err)); return false; }
    finally { await reload(); await onChanged(); setBusy(false); }
  };
  /** The same for a change confirmed in the reason dialog: a failure is shown there, where the owner can retry or cancel. */
  const confirmChange = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await action(); setAsk(null); }
    finally { await reload(); await onChanged(); setBusy(false); }
  };
  const confirmWithReason = (next: Ask) => setAsk(next);
  const userId = target.userId;
  const account = record?.account;
  const name = account?.displayName || account?.email || target.name;
  return <>
    <Modal open onClose={onClose} fullWidth title={name} description={account ? `${account.email} · joined ${shortDate(account.createdAt)}` : 'Loading…'}
      footer={<><Button variant="ghost" onClick={onClose}>Done</Button><Spacer /><Hint>Every change here is written to the audit log.</Hint></>}>
      {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
      {!record && !error && <Hint>Loading…</Hint>}
      {record && <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <div className="overflow-x-auto">
          <TabsList aria-label="Member record section" className="h-10 rounded-xl bg-muted p-1 ring-1 ring-inset ring-foreground/[0.04]">
            <TabsTrigger value="overview" className={TAB_CLASS}>Account</TabsTrigger>
            <TabsTrigger value="school" className={TAB_CLASS}>School</TabsTrigger>
            <TabsTrigger value="classes" className={TAB_CLASS}>Classes · {record.personal.data.classes.length}</TabsTrigger>
            <TabsTrigger value="tasks" className={TAB_CLASS}>Tasks · {record.tasks.length}</TabsTrigger>
            <TabsTrigger value="social" className={TAB_CLASS}>Friends & chats</TabsTrigger>
            <TabsTrigger value="posts" className={TAB_CLASS}>Global posts · {record.globalMessages.length}</TabsTrigger>
            <TabsTrigger value="history" className={TAB_CLASS}>Reports & requests</TabsTrigger>
            <TabsTrigger value="activity" className={TAB_CLASS}>Activity</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="overview"><AccountTab key={`${record.account.displayName}\u0000${record.account.fullName}\u0000${record.account.chatPush}`} record={record} busy={busy} onPause={() => onPause({ userId, name })}
          onSave={(input) => run(() => api.admin.users.updateAccount.mutate({ accountId, userId, ...input }))}
          onLiftPause={() => void run(() => api.admin.liftChatPause.mutate({ accountId, userId }))}
          ask={confirmWithReason} actions={{
            suspend: (suspended, why) => api.admin.users.suspend.mutate({ accountId, userId, suspended, reason: why }),
            signOut: (why) => api.admin.users.signOut.mutate({ accountId, userId, reason: why }),
            removeBrowsers: (why) => api.admin.users.removeBrowsers.mutate({ accountId, userId, reason: why }),
          }} /></TabsContent>
        <TabsContent value="school"><SchoolTab record={record} schools={schools} busy={busy} ask={confirmWithReason}
          onVerify={(verified) => void run(() => api.admin.users.setVerified.mutate({ accountId, userId, verified }))}
          actions={{
            move: (schoolId, keepPrivateTimetable, why) => api.admin.users.moveSchool.mutate({ accountId, userId, schoolId, keepPrivateTimetable, reason: why }),
            remove: (schoolId, why) => api.admin.removeMember.mutate({ userId, schoolId, reason: why }),
            unban: (schoolId, why) => api.admin.users.unban.mutate({ accountId, userId, schoolId, reason: why }),
          }} /></TabsContent>
        <TabsContent value="classes"><ClassesTab key={record.personal.version} record={record} busy={busy}
          onSave={(data) => run(() => api.admin.users.savePersonal.mutate({ accountId, userId, expectedVersion: record.personal.version, data }))} /></TabsContent>
        <TabsContent value="tasks"><TasksTab record={record} busy={busy} run={run} accountId={accountId} /></TabsContent>
        <TabsContent value="social"><SocialTab record={record} busy={busy} onOpenMember={onOpenMember}
          onRemove={(other) => confirmWithReason({ title: `End ${name}’s friendship with ${other.displayName}?`, tone: 'danger', confirm: 'End friendship',
            description: 'The pair stop sharing classes and their chat closes for both. Either of them can send a new request later.',
            run: (why) => api.admin.users.removeFriendship.mutate({ accountId, userId, otherId: other.userId, reason: why }) })} /></TabsContent>
        <TabsContent value="posts"><PostsTab posts={record.globalMessages} busy={busy} accountId={accountId} run={run} /></TabsContent>
        <TabsContent value="history"><HistoryTab record={record} busy={busy} onOpenMember={onOpenMember}
          onResolve={(requestId) => void run(() => api.admin.resolveRequest.mutate({ accountId, id: requestId }))} /></TabsContent>
        <TabsContent value="activity"><div className="grid gap-3"><Hint>Rows this member wrote, and owner actions about them (newest 100).</Hint><AuditTable entries={record.activity} subjectId={userId} onOpenMember={onOpenMember} /></div></TabsContent>
      </Tabs>}
    </Modal>
    {ask && <ReasonModal title={ask.title} description={ask.description} confirm={ask.confirm} tone={ask.tone}
      onClose={() => setAsk(null)} onConfirm={(why) => confirmChange(() => ask.run(why))} />}
  </>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid gap-0.5"><span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span><span className="break-all text-sm">{children}</span></div>;
}

function AccountTab({ record, busy, onSave, onPause, onLiftPause, ask, actions }: {
  record: SupportRecord; busy: boolean; onSave: (input: { displayName: string; fullName: string; chatPush: boolean }) => Promise<boolean>;
  onPause: () => void; onLiftPause: () => void; ask: (next: Ask) => void;
  actions: { suspend: (suspended: boolean, reason: string) => Promise<unknown>; signOut: (reason: string) => Promise<unknown>; removeBrowsers: (reason: string) => Promise<unknown> };
}) {
  const { account, pause } = record;
  const [displayName, setDisplayName] = useState(account.displayName);
  const [fullName, setFullName] = useState(account.fullName);
  const [chatPush, setChatPush] = useState(account.chatPush);
  const dirty = displayName !== account.displayName || fullName !== account.fullName || chatPush !== account.chatPush;
  return <div className="grid gap-4">
    <div className="flex flex-wrap gap-1.5">
      {account.isOwner && <Chip tone="accent" icon="star">Owner</Chip>}
      {account.suspended && <Chip tone="danger" icon="lock">Suspended {shortDate(account.suspended.at)}</Chip>}
      {pause && <Chip tone="warning" icon="lock">{pause.until ? `Messaging paused until ${formatInstant(pause.until)}` : 'Messaging paused until lifted'}</Chip>}
    </div>
    {account.suspended && <Callout tone="danger" icon="lock" title="Suspended">Reason: {account.suspended.reason}</Callout>}
    <Panel className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Fact label="Email">{account.email}</Fact>
      <Fact label="Google name">{account.googleName || '—'}</Fact>
      <Fact label="Account ID">{account.id}</Fact>
      <Fact label="Joined">{formatInstant(account.createdAt)}</Fact>
      <Fact label="Reminder browsers">{account.browsers}</Fact>
      <Fact label="Calendar feeds">{record.feeds.length}</Fact>
      <Fact label="Friends">{record.friendships.filter((entry) => entry.status === 'accepted').length}</Fact>
      <Fact label="Chats">{record.chats.length}</Fact>
    </Panel>
    <Panel className="grid gap-3">
      <strong className="text-sm font-bold">Profile</strong>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Display name" htmlFor="member-display"><Input id="member-display" maxLength={80} value={displayName} disabled={busy} onChange={(event) => setDisplayName(event.target.value)} /></Field>
        <Field label="Full name" htmlFor="member-full"><Input id="member-full" maxLength={160} value={fullName} disabled={busy} onChange={(event) => setFullName(event.target.value)} /></Field>
      </div>
      <Toggle label="Chat notifications" checked={chatPush} disabled={busy} onChange={setChatPush} description="Push notifications for new chat messages on their enrolled browsers." />
      <Hint>Their email comes from Google and is refreshed each time they sign in, so it can’t be edited here.</Hint>
      <div><Button variant="primary" busy={busy} disabled={!dirty || !displayName.trim() || !fullName.trim()} onClick={() => void onSave({ displayName, fullName, chatPush })}>Save profile</Button></div>
    </Panel>
    <Panel className="grid gap-3">
      <strong className="text-sm font-bold">Access</strong>
      <div className="flex flex-wrap gap-2">
        {pause ? <Button size="sm" icon="unlock" disabled={busy} onClick={onLiftPause}>Lift messaging pause</Button> : <Button size="sm" icon="lock" disabled={busy} onClick={onPause}>Pause messaging</Button>}
        <Button size="sm" icon="logout" disabled={busy} onClick={() => ask({ title: 'Sign out everywhere?', confirm: 'Sign out everywhere', run: actions.signOut,
          description: account.isOwner ? 'Every session of your owner account ends, this one included, and you sign in again with Google. Use it if the audit log shows activity you don’t recognize.'
            : 'Every device signed in to this account is signed out at its next request. Changes waiting on a device stay there and upload after they sign in again.' })}>Sign out everywhere</Button>
        {!account.isOwner && <>
          <Button size="sm" icon="bellOff" disabled={busy || account.browsers === 0} onClick={() => ask({ title: 'Forget reminder browsers?', confirm: 'Forget browsers', run: actions.removeBrowsers,
            description: `${pluralize(account.browsers, 'browser')} stop getting reminders and chat notifications until they are enabled again on each device.` })}>Forget browsers</Button>
          {account.suspended
            ? <Button size="sm" icon="unlock" disabled={busy} onClick={() => ask({ title: 'Lift the suspension?', confirm: 'Lift suspension', run: (why) => actions.suspend(false, why), description: 'They can sign in and use Quasar again.' })}>Lift suspension</Button>
            : <Button size="sm" variant="danger" icon="lock" disabled={busy} onClick={() => ask({ title: 'Suspend this account?', tone: 'danger', confirm: 'Suspend', run: (why) => actions.suspend(true, why),
              description: 'They are signed out everywhere and cannot sign in or use Quasar until you lift it. Their data stays as it is.' })}>Suspend account</Button>}
        </>}
      </div>
    </Panel>
  </div>;
}

function SchoolTab({ record, schools, busy, ask, onVerify, actions }: {
  record: SupportRecord; schools: School[]; busy: boolean; ask: (next: Ask) => void; onVerify: (verified: boolean) => void;
  actions: { move: (schoolId: string | null, keepPrivateTimetable: boolean, reason: string) => Promise<unknown>; remove: (schoolId: string, reason: string) => Promise<unknown>; unban: (schoolId: string, reason: string) => Promise<unknown> };
}) {
  const { school } = record;
  const [destination, setDestination] = useState(school?.id ?? '');
  const [keepPrivate, setKeepPrivate] = useState(false);
  const target = schools.find((entry) => entry.id === destination);
  const privateTimetable = !!(record.personal.data as PersonalSchedule).customSchedule;
  const moveDescription = !target ? 'They keep their classes, tasks and timetable, and can join a school again themselves.'
    : !privateTimetable ? `They follow ${target.name}’s timetable from their next sync. Their classes stay.`
    : keepPrivate ? `They keep their private timetable, so ${target.name}’s bell times and corrections do not reach them until they switch to the school timetable themselves (School → Manage) or you turn it off under Classes.`
    : `Their private timetable is dropped and they follow ${target.name}’s from their next sync. Their classes and period assignments stay.`;
  return <div className="grid gap-4">
    <Panel className="grid gap-3">
      {school ? <>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div><strong className="text-sm font-bold">{school.name}</strong><Hint>{school.location} · school revision {school.version}{school.reviewedVersion !== null && school.reviewedVersion !== school.version ? ` · they last reviewed ${school.reviewedVersion}` : ''}</Hint></div>
          <div className="flex flex-wrap gap-1.5">{school.verification ? <Chip tone="success" icon="check">Verified by {school.verification.method === 'domain' ? 'email domain' : 'support'} · {shortDate(school.verification.verifiedAt)}</Chip> : <Chip tone="warning">{school.verificationPending ? 'Verification pending' : 'Not verified'}</Chip>}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          {school.verification ? <Button size="sm" disabled={busy} onClick={() => onVerify(false)}>Remove verification</Button> : <Button size="sm" variant="primary" icon="check" disabled={busy} onClick={() => onVerify(true)}>Verify at {school.name}</Button>}
          <Button size="sm" variant="danger" disabled={busy} onClick={() => ask({ title: `Remove from ${school.name}?`, tone: 'danger', confirm: 'Remove from school', run: (why) => actions.remove(school.id, why),
            description: 'They leave the school and cannot rejoin until you lift the removal. Their verification there ends, every friendship they have ends (at any school), which closes all of their chats, and their open reports close.' })}>Remove from school</Button>
        </div>
      </> : <Hint>Not in a school.</Hint>}
    </Panel>
    <Panel className="grid gap-3">
      <strong className="text-sm font-bold">Move to another school</strong>
      <Hint>No ban and no lost friendships: like joining, their classes stay, open proposals at the old school are withdrawn, and a matching email domain verifies them at the new one.</Hint>
      {privateTimetable && target && target.id !== school?.id && <Toggle label="Keep their private timetable" checked={keepPrivate} disabled={busy} onChange={setKeepPrivate}
        description={`It is a copy of ${school ? `${school.name}’s` : 'a'} timetable. Off, they follow ${target.name}’s timetable instead, as they would by joining it.`} />}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[240px] flex-1"><Select aria-label="Destination school" value={destination} disabled={busy} onChange={(event) => setDestination(event.target.value)}>
          <option value="">No school</option>
          {schools.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {entry.location}</option>)}
        </Select></div>
        <Button disabled={busy || destination === (school?.id ?? '')} onClick={() => ask({ title: target ? `Move to ${target.name}?` : 'Take them out of their school?', confirm: 'Move', run: (why) => actions.move(destination || null, keepPrivate, why),
          description: moveDescription })}>Move</Button>
      </div>
    </Panel>
    {record.bans.length > 0 && <Panel className="grid gap-2"><strong className="text-sm font-bold">Removed from</strong>
      {record.bans.map((ban) => <div key={ban.schoolId} className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><p className="text-sm font-semibold">{ban.schoolName} · {shortDate(ban.createdAt)}</p><Hint className="whitespace-pre-wrap break-words">Reason: {ban.reason}</Hint></div>
        <Button size="sm" disabled={busy} onClick={() => ask({ title: `Lift the removal from ${ban.schoolName}?`, confirm: 'Lift removal', run: (why) => actions.unban(ban.schoolId, why), description: 'They may join that school again. This does not rejoin them.' })}>Lift removal</Button></div>)}
    </Panel>}
    {record.verificationRequests.length > 0 && <Panel className="grid gap-2"><strong className="text-sm font-bold">Verification requests</strong>
      {record.verificationRequests.map((request) => <div key={request.id} className="grid gap-1 border-t border-foreground/[0.06] pt-2 first:border-0 first:pt-0"><p className="text-sm font-semibold">{request.schoolName} · {shortDate(request.createdAt)} · {request.resolvedAt ? request.decision ?? 'closed' : 'open'}</p><p className="whitespace-pre-wrap break-words text-sm">{request.proof}</p></div>)}
    </Panel>}
    {record.proposals.length > 0 && <Panel className="grid gap-2"><strong className="text-sm font-bold">Schedule proposals</strong>
      {record.proposals.map((proposal) => <p key={proposal.id} className="text-sm">{proposal.summary} <span className="text-muted-foreground">· {proposal.schoolName} · {proposal.status} · {shortDate(proposal.createdAt)}</span></p>)}
    </Panel>}
  </div>;
}

/* ---------- Classes ---------- */

const NO_COLOR = '#6b7280';

function ClassesTab({ record, busy, onSave }: { record: SupportRecord; busy: boolean; onSave: (data: PersonalSchedule) => Promise<boolean> }) {
  const saved = record.personal.data as PersonalSchedule;
  const [draft, setDraft] = useState<PersonalSchedule>(() => structuredClone(saved));
  const [coloring, setColoring] = useState<StudentClass | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const parsed = personalScheduleSchema.safeParse(draft);
  const issues = parsed.success ? [] : [...new Set(parsed.error.issues.map((issue) => issue.message))];
  const schedule = record.school ? effectiveSchedule(record.school.schedule, draft) : draft.customSchedule ?? null;
  const periods = schedule?.periods.filter((period) => period.kind === 'class') ?? [];
  const known = new Set(periods.map((period) => period.id));
  const otherAssignments = Object.entries(draft.assignments).filter(([periodId]) => !known.has(periodId));
  const updateClass = (id: string, change: Partial<StudentClass>) => setDraft((current) => ({ ...current, classes: current.classes.map((entry) => entry.id === id ? stripEmpty({ ...entry, ...change }) : entry) }));
  // The same cleanup as the student's own Classes page: assignments and the private blocks made for the class go too.
  const removeClass = (id: string) => setDraft((current) => removeClassEverywhere(record.school?.schedule ?? null, current, id));
  const addClass = () => setDraft((current) => ({ ...current, classes: [...current.classes, { id: slugId('class', current.classes.map((entry) => entry.id)), name: 'New class' }] }));
  const assign = (periodId: string, classId: string) => setDraft((current) => {
    const assignments = { ...current.assignments };
    if (classId) assignments[periodId] = classId; else delete assignments[periodId];
    return { ...current, assignments };
  });
  return <div className="grid gap-4">
    {!record.personal.valid && <Callout tone="warning" icon="alert">Their saved classes don’t pass validation, so an empty set is shown. Saving replaces what is stored.</Callout>}
    <Panel className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm font-bold">Classes</strong><Button size="sm" icon="plus" disabled={busy} onClick={addClass}>Add class</Button></div>
      {draft.classes.length === 0 && <Hint>No classes.</Hint>}
      {draft.classes.map((cls) => <div key={cls.id} className="grid items-end gap-2 sm:grid-cols-[auto_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
        <IconButton label={`Color of ${cls.name}`} icon="palette" disabled={busy} onClick={() => setColoring(cls)} style={{ color: classColor(cls.id, 'class', cls.color).dot }} />
        <Field label="Name" htmlFor={`class-name-${cls.id}`}><Input id={`class-name-${cls.id}`} small maxLength={120} value={cls.name} disabled={busy} onChange={(event) => updateClass(cls.id, { name: event.target.value })} /></Field>
        <Field label="Room" htmlFor={`class-room-${cls.id}`}><Input id={`class-room-${cls.id}`} small maxLength={120} value={cls.room ?? ''} disabled={busy} onChange={(event) => updateClass(cls.id, { room: event.target.value })} /></Field>
        <Field label="Teacher" htmlFor={`class-teacher-${cls.id}`}><Input id={`class-teacher-${cls.id}`} small maxLength={120} value={cls.teacher ?? ''} disabled={busy} onChange={(event) => updateClass(cls.id, { teacher: event.target.value })} /></Field>
        <IconButton label={`Remove ${cls.name}`} icon="trash" disabled={busy} onClick={() => removeClass(cls.id)} />
      </div>)}
    </Panel>
    <Panel className="grid gap-3">
      <strong className="text-sm font-bold">Periods</strong>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Grade" htmlFor="member-grade"><Select id="member-grade" value={draft.grade ?? ''} disabled={busy} onChange={(event) => setDraft((current) => { const { grade: _grade, ...rest } = current; return event.target.value ? { ...rest, grade: event.target.value as Grade } : rest; })}>
          <option value="">No grade</option>
          {GRADES.map((grade) => <option key={grade} value={grade}>{gradeLabel(grade)}</option>)}
        </Select></Field>
      </div>
      {!schedule && <Hint>They have no school and no private timetable, so there are no periods to assign.</Hint>}
      {periods.length > 0 && <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{periods.map((period) => <Field key={period.id} label={period.label} htmlFor={`assign-${period.id}`}>
        <Select id={`assign-${period.id}`} small value={draft.assignments[period.id] ?? ''} disabled={busy} onChange={(event) => assign(period.id, event.target.value)}>
          <option value="">No class</option>
          {draft.classes.map((cls) => <option key={cls.id} value={cls.id}>{cls.name || cls.id}</option>)}
        </Select>
      </Field>)}</div>}
      {otherAssignments.length > 0 && <Hint>Also assigned in periods this timetable doesn’t list: {otherAssignments.map(([periodId, classId]) => `${periodId} → ${draft.classes.find((entry) => entry.id === classId)?.name ?? classId}`).join(', ')}.</Hint>}
    </Panel>
    <Panel className="grid gap-3">
      <strong className="text-sm font-bold">Timetable</strong>
      {draft.customSchedule
        ? <Toggle label="Follows a private copy of the timetable" checked disabled={busy} onChange={() => setDraft((current) => ({ ...current, customSchedule: null }))} description="Turn off to put them back on the school’s timetable, so school corrections reach them again. Their classes stay." />
        : <Hint>{saved.customSchedule ? 'Will follow the school timetable after saving.' : 'Follows the school timetable.'}</Hint>}
      <div className="flex flex-wrap items-center gap-2">
        <Hint>{pluralize(draft.cycleDayOverrides.length, 'rotation-day change')} · {pluralize(draft.dateOverrides.length, 'date change')}</Hint>
        {(draft.cycleDayOverrides.length > 0 || draft.dateOverrides.length > 0) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft((current) => ({ ...current, cycleDayOverrides: [], dateOverrides: [] }))}>Clear their changes</Button>}
      </div>
    </Panel>
    {issues.length > 0 && <Callout tone="danger" icon="alert" role="alert">{issues.join(' ')}</Callout>}
    <div className="flex flex-wrap gap-2">
      <Button variant="primary" busy={busy} disabled={!dirty || issues.length > 0} onClick={() => void onSave(parsed.data!)}>Save classes</Button>
      <Button variant="ghost" disabled={!dirty || busy} onClick={() => setDraft(structuredClone(saved))}>Undo changes</Button>
      <Hint className="self-center">Their devices pick this up on their next sync, merged with any offline edits.</Hint>
    </div>
    {coloring && <ColorModal cls={coloring} onClose={() => setColoring(null)} onPick={(color) => { updateClass(coloring.id, { color }); setColoring(null); }} />}
  </div>;
}
/** Empty room and teacher fields are left out rather than saved as ''. */
function stripEmpty(cls: StudentClass): StudentClass {
  const next = { ...cls };
  if (!next.room?.trim()) delete next.room;
  if (!next.teacher?.trim()) delete next.teacher;
  if (!next.color) delete next.color;
  return next;
}
function ColorModal({ cls, onClose, onPick }: { cls: StudentClass; onClose: () => void; onPick: (color: string | undefined) => void }) {
  const [color, setColor] = useState(cls.color ?? classColor(cls.id, 'class', cls.color).dot ?? NO_COLOR);
  return <Modal open onClose={onClose} title={`Color of ${cls.name}`} footer={<><Button variant="ghost" onClick={() => onPick(undefined)}>Use automatic color</Button><Spacer /><Button variant="primary" onClick={() => onPick(color.toLowerCase())}>Use color</Button></>}>
    <div className="flex items-center gap-2"><ColorDot color={color} size={14} /><Hint>{color}</Hint></div>
    <ColorPicker value={color} onValueChange={setColor} label="Class color" />
  </Modal>;
}

/* ---------- Tasks and feeds ---------- */

function TasksTab({ record, busy, run, accountId }: { record: SupportRecord; busy: boolean; run: (action: () => Promise<unknown>) => Promise<boolean>; accountId: string }) {
  const [editing, setEditing] = useState<SupportTask | null>(null);
  const [deleting, setDeleting] = useState<SupportTask | null>(null);
  const userId = record.account.id;
  const tasks = [...record.tasks].sort((a, b) => Number(a.completed) - Number(b.completed) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'));
  return <div className="grid gap-4">
    <Hint>{pluralize(record.tasks.length, 'task')}{record.deletedTasks ? ` · ${record.deletedTasks} deleted` : ''}{record.unreadableTasks ? ` · ${record.unreadableTasks} that don’t pass validation (not shown)` : ''}</Hint>
    {tasks.length > 0 && <div className="overflow-hidden rounded-2xl ring-1 ring-foreground/[0.06]"><Table>
      <TableHeader className="bg-muted/70"><TableRow><TableHead>Task</TableHead><TableHead>Due</TableHead><TableHead>Status</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
      <TableBody>{tasks.map((task) => <TableRow key={task.id}>
        <TableCell className="min-w-[220px] whitespace-normal"><strong className="text-sm font-semibold">{task.title}</strong>{task.notes && <Hint className="line-clamp-2 whitespace-pre-wrap break-words">{task.notes}</Hint>}</TableCell>
        <TableCell className="whitespace-nowrap text-sm">{task.dueDate ? `${formatDate(task.dueDate, { weekday: 'short', year: true })}${task.dueTime ? ` · ${formatTime(task.dueTime)}` : ''}` : '—'}</TableCell>
        <TableCell><div className="flex flex-wrap gap-1">{task.completed ? <Chip tone="success" icon="check">Done</Chip> : <Chip tone="outline">Open</Chip>}{task.priority !== 'normal' && <Chip tone={task.priority === 'high' ? 'danger' : 'neutral'}>{task.priority}</Chip>}{task.imported && <Chip tone="accent" icon="calendar">Calendar</Chip>}{task.recurring && <Chip icon="refresh">Repeats</Chip>}{task.subtasks > 0 && <Chip>{pluralize(task.subtasks, 'step')}</Chip>}</div></TableCell>
        <TableCell className="text-right"><div className="inline-flex gap-1"><IconButton label={`Edit ${task.title}`} icon="edit" disabled={busy} onClick={() => setEditing(task)} /><IconButton label={`Delete ${task.title}`} icon="trash" disabled={busy} onClick={() => setDeleting(task)} /></div></TableCell>
      </TableRow>)}</TableBody>
    </Table></div>}
    <Panel className="grid gap-2">
      <strong className="text-sm font-bold">Calendar feeds</strong>
      {record.feeds.length === 0 && <Hint>No calendar feeds. Feed addresses are private and never shown.</Hint>}
      {record.feeds.map((feed) => <div key={feed.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-foreground/[0.06] pt-2 first:border-0 first:pt-0">
        <div className="min-w-0"><p className="text-sm font-semibold">{feed.name} {!feed.enabled && <Chip tone="warning">Paused</Chip>}</p><Hint>{pluralize(feed.itemCount, 'item')} · {feed.lastSuccessAt ? `updated ${formatInstant(feed.lastSuccessAt)}` : 'never updated'}{feed.lastError ? ` · ${feed.lastError}` : ''}</Hint></div>
        <div className="flex gap-1.5"><Button size="sm" disabled={busy} onClick={() => void run(() => api.admin.users.feed.mutate({ accountId, userId, subscriptionId: feed.id, action: feed.enabled ? 'disable' : 'enable' }))}>{feed.enabled ? 'Pause' : 'Resume'}</Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => { if (window.confirm(`Remove the feed “${feed.name}”? Its tasks stay as ordinary tasks.`)) void run(() => api.admin.users.feed.mutate({ accountId, userId, subscriptionId: feed.id, action: 'remove' })); }}>Remove</Button></div>
      </div>)}
    </Panel>
    {editing && <TaskModal task={editing} onClose={() => setEditing(null)} onSave={async (data) => { if (await run(() => api.admin.users.saveTask.mutate({ accountId, userId, taskId: editing.id, expectedVersion: editing.version, data }))) setEditing(null); }} />}
    {deleting && <Modal open onClose={() => setDeleting(null)} title={`Delete “${deleting.title}”?`} description="It is removed from their devices on their next sync."
      footer={<><Button variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button><Spacer /><Button variant="danger" busy={busy} onClick={async () => { if (await run(() => api.admin.users.deleteTask.mutate({ accountId, userId, taskId: deleting.id, expectedVersion: deleting.version }))) setDeleting(null); }}>Delete task</Button></>}>
      <Hint>This can’t be undone from the console.</Hint>
    </Modal>}
  </div>;
}

type TaskFields = { title: string; notes: string; completed: boolean; dueDate: string | null; dueTime: string | null; priority: 'low' | 'normal' | 'high' };
function TaskModal({ task, onClose, onSave }: { task: SupportTask; onClose: () => void; onSave: (data: TaskFields) => Promise<void> }) {
  const initial: TaskFields = { title: task.title, notes: task.notes, completed: task.completed, dueDate: task.dueDate, dueTime: task.dueTime, priority: task.priority };
  const [fields, setFields] = useState(initial);
  const [pending, setPending] = useState(false);
  const set = (change: Partial<TaskFields>) => setFields((current) => ({ ...current, ...change }));
  const dirty = JSON.stringify(fields) !== JSON.stringify(initial);
  return <Modal open onClose={onClose} dirty={dirty} busy={pending} title="Edit task" description={task.imported ? 'From a calendar feed: the next refresh may offer the feed’s version back to them.' : undefined}
    footer={<><Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button><Spacer /><Button variant="primary" busy={pending} disabled={!dirty || !fields.title.trim()} onClick={async () => { setPending(true); try { await onSave(fields); } finally { setPending(false); } }}>Save task</Button></>}>
    <Field label="Title" htmlFor="task-title"><Input id="task-title" maxLength={300} value={fields.title} onChange={(event) => set({ title: event.target.value })} /></Field>
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="Due date" htmlFor="task-date"><Input id="task-date" type="date" min="1900-01-01" max="2199-12-31" value={fields.dueDate ?? ''} onChange={(event) => set({ dueDate: event.target.value || null, ...(event.target.value ? {} : { dueTime: null }) })} /></Field>
      <Field label="Due time" htmlFor="task-time"><Input id="task-time" type="time" disabled={!fields.dueDate} value={fields.dueTime ?? ''} onChange={(event) => set({ dueTime: event.target.value || null })} /></Field>
      <Field label="Priority" htmlFor="task-priority"><Select id="task-priority" value={fields.priority} onChange={(event) => set({ priority: event.target.value as TaskFields['priority'] })}>
        <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option>
      </Select></Field>
    </div>
    <Field label="Notes" htmlFor="task-notes"><Textarea id="task-notes" maxLength={10000} value={fields.notes} onChange={(event) => set({ notes: event.target.value })} /></Field>
    <Toggle label="Done" checked={fields.completed} onChange={(completed) => set({ completed })} />
  </Modal>;
}

/* ---------- Friends, chats, posts, history ---------- */

const FRIEND_STATES = { accepted: 'Friends', outgoing: 'Request sent', incoming: 'Request received' } as const;

function SocialTab({ record, busy, onOpenMember, onRemove }: { record: SupportRecord; busy: boolean; onOpenMember: (target: MemberTarget) => void; onRemove: (other: { userId: string; displayName: string }) => void }) {
  const open = (peer: { userId: string; displayName: string; email: string }) => onOpenMember({ userId: peer.userId, name: peer.displayName || peer.email });
  const person = (peer: { userId: string; displayName: string; email: string }) => <button type="button" className="text-left text-sm font-semibold underline-offset-2 hover:underline" onClick={() => open(peer)}>{peer.displayName || 'No name'}<Hint className="break-all font-normal">{peer.email}</Hint></button>;
  return <div className="grid gap-4">
    <Section title="Friends and requests" icon="users">
      {record.friendships.length === 0 ? <Hint>No friends or requests.</Hint> : <div className="overflow-hidden rounded-2xl ring-1 ring-foreground/[0.06]"><Table>
        <TableHeader className="bg-muted/70"><TableRow><TableHead>Member</TableHead><TableHead>State</TableHead><TableHead>Since</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
        <TableBody>{record.friendships.map((row) => <TableRow key={row.userId}>
          <TableCell className="whitespace-normal">{person(row)}</TableCell>
          <TableCell className="text-sm">{FRIEND_STATES[row.status === 'accepted' ? 'accepted' : row.outgoing ? 'outgoing' : 'incoming']}</TableCell>
          <TableCell className="text-sm">{shortDate(row.respondedAt ?? row.createdAt)}</TableCell>
          <TableCell className="text-right"><Button size="sm" variant="ghost" disabled={busy} onClick={() => onRemove(row)}>{row.status === 'accepted' ? 'End friendship' : 'Drop request'}</Button></TableCell>
        </TableRow>)}</TableBody>
      </Table></div>}
    </Section>
    <Section title="Chats" icon="message" description="Who they message and how much. Message text stays private: support sees a chat only through a report’s snapshot, from Member reports.">
      {record.chats.length === 0 ? <Hint>No chats.</Hint> : <div className="overflow-hidden rounded-2xl ring-1 ring-foreground/[0.06]"><Table>
        <TableHeader className="bg-muted/70"><TableRow><TableHead>With</TableHead><TableHead>Sent</TableHead><TableHead>Received</TableHead><TableHead>Last message</TableHead></TableRow></TableHeader>
        <TableBody>{record.chats.map((row) => <TableRow key={row.userId}>
          <TableCell className="whitespace-normal">{person(row)}</TableCell>
          <TableCell className="tabular-nums">{row.sent}</TableCell><TableCell className="tabular-nums">{row.received}</TableCell>
          <TableCell className="text-sm">{row.lastMessageAt ? formatInstant(row.lastMessageAt) : '—'}</TableCell>
        </TableRow>)}</TableBody>
      </Table></div>}
    </Section>
    <Section title="Blocks" icon="lock" description="A block is the member’s own safety choice, so support can see blocks but not lift them.">
      {record.blocks.length === 0 ? <Hint>No blocks.</Hint> : <ul className="grid gap-1.5">{record.blocks.map((row) => <li key={`${row.userId}:${row.byThem}`} className="flex flex-wrap items-center gap-2 text-sm">{row.byThem ? 'Blocked' : 'Blocked by'} {person(row)} <Hint className="inline">· {shortDate(row.createdAt)}</Hint></li>)}</ul>}
    </Section>
  </div>;
}

function PostsTab({ posts, busy, accountId, run }: { posts: GlobalPost[]; busy: boolean; accountId: string; run: (action: () => Promise<unknown>) => Promise<boolean> }) {
  const [editing, setEditing] = useState<GlobalPost | null>(null);
  const [removing, setRemoving] = useState<GlobalPost | null>(null);
  const [body, setBody] = useState('');
  const [reason, setReason] = useState('');
  return <div className="grid gap-3">
    <Hint>Their Global chat messages, newest first. The room is public, so what you change here everyone sees, with your reason under the message.</Hint>
    {posts.length === 0 && <Hint>No Global chat posts.</Hint>}
    <ul className="grid gap-2">{posts.map((post) => <li key={post.seq} className={ROW_CLASS}>
      <div className="flex flex-wrap items-center gap-1.5 text-[13px]"><span className="text-muted-foreground">{formatInstant(post.createdAt)}</span>
        {post.deletedBy === 'owner' && <Chip tone="warning">Removed by you</Chip>}{post.deletedBy === 'sender' && <Chip tone="outline">Deleted by them</Chip>}{post.editedAt && !post.deletedAt && <Chip>Edited</Chip>}</div>
      {/* Plain text only: no links, no markup. */}
      {post.deletedAt ? (post.body ? <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground line-through">{post.body}</p> : <Hint>Text removed after 30 days.</Hint>) : <p className="whitespace-pre-wrap break-words text-sm">{post.body}</p>}
      {post.reason && <Hint>Reason: {post.reason}</Hint>}
      {!post.deletedAt && <div className="flex gap-2"><Button size="sm" variant="ghost" icon="edit" disabled={busy} onClick={() => { setEditing(post); setBody(post.body); setReason(''); }}>Edit</Button><Button size="sm" variant="ghost" icon="trash" disabled={busy} onClick={() => { setRemoving(post); setReason(''); }}>Remove</Button></div>}
    </li>)}</ul>
    {editing && <Modal open onClose={() => setEditing(null)} busy={busy} dirty={body !== editing.body} title="Edit message" description="Everyone in Global chat sees the new text marked as edited, with your reason."
      footer={<><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Spacer /><Button variant="primary" busy={busy} disabled={!body.trim() || body === editing.body} onClick={async () => { if (await run(() => api.admin.users.editGlobal.mutate({ accountId, messageId: editing.id, body, reason: reason.trim() }))) setEditing(null); }}>Save</Button></>}>
      <Field label="Message" htmlFor="post-body"><Textarea id="post-body" maxLength={1100} value={body} onChange={(event) => setBody(event.target.value)} /></Field>
      <Field label="Reason shown under it" htmlFor="post-reason" hint="Optional, up to 200 characters."><Input id="post-reason" maxLength={200} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
    </Modal>}
    {removing && <Modal open onClose={() => setRemoving(null)} busy={busy} title="Remove this message?" description="Everyone in Global chat sees that you removed it, with your reason."
      footer={<><Button variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button><Spacer /><Button variant="danger" busy={busy} onClick={async () => { if (await run(() => api.admin.users.deleteGlobal.mutate({ accountId, messageId: removing.id, reason: reason.trim() }))) setRemoving(null); }}>Remove</Button></>}>
      <Field label="Reason shown in its place" htmlFor="remove-reason" hint="Optional, up to 200 characters."><Input id="remove-reason" maxLength={200} value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
    </Modal>}
  </div>;
}

function categoryLabel(category: string | null): string | null {
  return category && category in REPORT_CATEGORIES ? REPORT_CATEGORIES[category as ReportCategory].short : null;
}

function HistoryTab({ record, busy, onOpenMember, onResolve }: { record: SupportRecord; busy: boolean; onOpenMember: (target: MemberTarget) => void; onResolve: (requestId: string) => void }) {
  const reports = (title: string, rows: SupportRecord['reportsAbout'], other: string) => <Section title={title} icon="alert">
    {rows.length === 0 ? <Hint>None.</Hint> : <ul className="grid gap-2">{rows.map((report) => <li key={report.id} className={ROW_CLASS}>
      <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
        {report.isChat && <Chip tone="accent" icon="message">Chat</Chip>}{categoryLabel(report.category) && <Chip>{categoryLabel(report.category)}</Chip>}
        {report.resolvedAt ? <Chip tone="outline">{report.outcome ?? 'closed'} · {shortDate(report.resolvedAt)}</Chip> : <Chip tone="danger">Open</Chip>}
        <span className="text-muted-foreground">{formatInstant(report.createdAt)} · {other} <button type="button" className="font-semibold text-foreground underline-offset-2 hover:underline" onClick={() => onOpenMember({ userId: report.otherId, name: report.otherName })}>{report.otherName || 'member'}</button>{report.schoolName ? ` · ${report.schoolName}` : ''}</span>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">{report.reason}</p>
    </li>)}</ul>}
  </Section>;
  return <div className="grid gap-4">
    {reports('Reports about them', record.reportsAbout, 'reported by')}
    {reports('Reports they sent', record.reportsBy, 'about')}
    <Section title="Support requests and feedback" icon="inbox">
      {record.supportRequests.length === 0 ? <Hint>None.</Hint> : <ul className="grid gap-2">{record.supportRequests.map((request) => <li key={request.id} className={ROW_CLASS}>
        <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]"><span className="text-muted-foreground">{formatInstant(request.createdAt)}{request.schoolName ? ` · ${request.schoolName}` : ''}</span>{request.resolvedAt ? <Chip tone="outline">Resolved {shortDate(request.resolvedAt)}</Chip> : <Button size="sm" variant="ghost" icon="check" disabled={busy} onClick={() => onResolve(request.id)}>Mark resolved</Button>}</div>
        <p className="whitespace-pre-wrap break-words text-sm">{request.message}</p>
      </li>)}</ul>}
    </Section>
  </div>;
}
