'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { signIn } from 'next-auth/react';
import { GoogleLogo } from './google-logo';
import { SchoolDirectory } from './school-directory';
import { api, errorMessage, isAccessDenied, type RouterOutput, type School } from '@/client/api';
import { scheduleSchema, type Schedule } from '@/domain/schedule';
import { REPORT_CATEGORIES } from '@/domain/chat';
import { browserTimeZone, formatDate, formatTime, instantParts, pluralize } from '@/lib/format';
import { Icon } from './icon';
import { describeIssues, ScheduleEditor, ScheduleSummary } from './schedule-editor';
import { Brand, CenteredNotice } from './shell';
import { Button, Callout, Chip, Field, Hint, Input, Modal, PageHeader, Panel, Section, Select, Spacer, StatTile, Textarea, Toggle } from './primitives';
import { Button as ShadButton } from './ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

type Request = RouterOutput['admin']['requests'][number];
type VerificationRequest = RouterOutput['admin']['verificationRequests'][number];
type Report = RouterOutput['admin']['reports'][number];
type PendingProposal = RouterOutput['admin']['proposals'][number];
type ChatPauseRow = RouterOutput['admin']['chatPauses'][number];
type BanRow = RouterOutput['admin']['bans'][number];
/** What a support request is: a correction request or feedback, or an appeal against a pause or a removal (docs/CHAT.md §14). */
function requestKind(kind: Request['kind']): { label: string; appeal: 'pause' | 'ban' } | null {
  if (kind === 'appeal:pause') return { label: 'Appeal: messaging pause', appeal: 'pause' };
  if (kind === 'appeal:ban') return { label: 'Appeal: removal from school', appeal: 'ban' };
  return null;
}
type EvidenceItem = RouterOutput['admin']['showEvidence']['items'][number];
type PauseTarget = { userId: string; name: string };

/** Admin has no AppState, so instants are shown in the browser's time zone. */
function formatInstant(iso: string): string {
  const { date, time } = instantParts(iso, browserTimeZone());
  return `${formatDate(date, { weekday: 'short' })}, ${formatTime(time)}`;
}

/** What the server knows about the request's session (src/app/admin/page.tsx), so the page paints its verdict at once. */
export type AdminBoot = { accountId: string | null; isAdmin: boolean };

export function Admin({ initial }: { initial?: AdminBoot }) {
  const [schools, setSchools] = useState<School[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [verifications, setVerifications] = useState<VerificationRequest[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [proposals, setProposals] = useState<PendingProposal[]>([]);
  const [pauses, setPauses] = useState<ChatPauseRow[]>([]);
  const [bans, setBans] = useState<BanRow[]>([]);
  // adminScoped mutations carry the signed-in account, so a switch in another tab can't write under the wrong one.
  const [accountId, setAccountId] = useState<string | null>(initial?.accountId ?? null);
  const accountRef = useRef<string | null>(initial?.accountId ?? null);
  // Report snapshots stay in memory only, and only while their card is open.
  const [evidence, setEvidence] = useState<Record<string, EvidenceItem[]>>({});
  const [opening, setOpening] = useState<string | null>(null);
  const [hiding, setHiding] = useState<string | null>(null);
  const [pauseTarget, setPauseTarget] = useState<PauseTarget | null>(null);
  const [allowed, setAllowed] = useState(!!initial?.isAdmin);
  const [signedIn, setSignedIn] = useState(!!initial?.accountId);
  const [loading, setLoading] = useState(true);
  // Whether the page knows who is asking: from the server render, or after the first session check.
  const [decided, setDecided] = useState(!!initial);
  const [error, setError] = useState('');
  // The last refresh failed for a reason other than access (offline, a server error), so the notice says so.
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [directorySchool, setDirectorySchool] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const refresh = useCallback(async () => {
    // Losing owner access drops everything support loaded, including student proofs and report snapshots.
    const revoke = () => { setAllowed(false); setSchools([]); setRequests([]); setVerifications([]); setReports([]); setProposals([]); setPauses([]); setBans([]); setEvidence({}); };
    setLoading(true); setError(''); setFailed(false);
    try {
      const session = await api.session.query(); setSignedIn(Boolean(session));
      const nextAccount = session?.user.id ?? null;
      if (accountRef.current !== nextAccount) setEvidence({});
      accountRef.current = nextAccount; setAccountId(nextAccount);
      if (!session?.isAdmin) { revoke(); return; }
      const [schoolList, requestList, verificationList, reportList, proposalList, pauseList, banList] = await Promise.all([api.admin.schools.query(), api.admin.requests.query(), api.admin.verificationRequests.query(), api.admin.reports.query(), api.admin.proposals.query(), api.admin.chatPauses.query(), api.admin.bans.query()]);
      setSchools(schoolList); setRequests(requestList); setVerifications(verificationList); setReports(reportList); setProposals(proposalList); setPauses(pauseList); setBans(banList); setAllowed(true);
      // Drop snapshots of reports that are no longer open.
      const open = new Set(reportList.map((report) => report.id));
      setEvidence((current) => Object.fromEntries(Object.entries(current).filter(([id]) => open.has(id))));
    } catch (err) {
      setError(errorMessage(err));
      // Only a refusal ends access. A network blip or one failing list keeps what is loaded (and any open sheet or
      // report snapshot) on screen with the error above it, so reopening evidence does not write another audit entry.
      if (isAccessDenied(err)) revoke(); else setFailed(true);
    }
    finally { setLoading(false); setDecided(true); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const school = schools.find((entry) => entry.id === selected);

  // Only a page the server could not decide waits for the session check, as a plain background rather than a loader.
  if (!decided) return <div className="min-h-dvh" aria-busy="true" />;
  if (!allowed) {
    return <CenteredNotice title={failed ? 'Support tools could not load' : signedIn ? 'Owner access required' : 'Sign in to continue'} action={<div className="grid justify-items-center gap-2">
      {!signedIn && !failed && <Button variant="primary" onClick={() => void signIn('google', { callbackUrl: '/admin' })}><GoogleLogo />Continue with Google</Button>}
      <div className="flex gap-2"><Button size="sm" onClick={() => void refresh()}>Retry</Button><Button size="sm" variant="ghost" onClick={() => window.location.assign('/')}>Back to my schedule</Button></div>
    </div>}>
      {error || (signedIn ? 'This page is available to the project owner.' : 'Sign in with the owner account to review school schedules.')}
    </CenteredNotice>;
  }

  const visible = filter ? schools.filter((entry) => `${entry.name} ${entry.location}`.toLowerCase().includes(filter.toLowerCase())) : schools;
  const approved = schools.filter((entry) => entry.approved).length;
  const act = async (action: () => Promise<unknown>) => {
    setError('');
    let failure: unknown = null;
    try { await action(); } catch (err) { failure = err; }
    // Reload after a refusal too: some commit first (a banned student's verification request is declined, a stale
    // proposal is superseded), so the list must drop them. refresh clears the error, so the action's shows after it.
    await refresh();
    if (failure) setError(errorMessage(failure));
  };
  const openCount = requests.length + verifications.length + reports.length + proposals.length;
  const showEvidence = async (reportId: string) => {
    if (!accountId) return;
    setError(''); setOpening(reportId);
    try { const result = await api.admin.showEvidence.mutate({ accountId, reportId }); setEvidence((current) => ({ ...current, [reportId]: result.items })); }
    catch (err) { setError(errorMessage(err)); }
    finally { setOpening(null); }
  };
  const closeEvidence = (reportId: string) => setEvidence((current) => { const next = { ...current }; delete next[reportId]; return next; });
  const hideMessage = async (reportId: string, seq: number) => {
    if (!accountId || !window.confirm('Hide this message from both students?')) return;
    setError(''); setHiding(`${reportId}:${seq}`);
    try {
      await api.admin.redactMessage.mutate({ accountId, reportId, seq });
      // The server marked the snapshot item too; mirror it here instead of reading the snapshot again.
      setEvidence((current) => current[reportId] ? { ...current, [reportId]: current[reportId].map((item) => item.seq === seq ? { ...item, deletedBy: 'support' as const } : item) } : current);
    } catch (err) { setError(errorMessage(err)); }
    finally { setHiding(null); }
  };
  return <div className="app-canvas min-h-dvh">
    <header className="glass sticky top-0 z-30 border-b border-foreground/[0.06]">
      <div className="mx-auto flex h-14 w-full max-w-[1120px] items-center justify-between gap-3 px-4 lg:px-8">
        <div className="flex min-w-0 items-center gap-3"><Brand compact href="/" className="sm:hidden" /><Brand href="/" className="max-sm:hidden" /><Chip tone="accent" icon="inbox">Support</Chip></div>
        <div className="flex shrink-0 items-center gap-2"><Button size="sm" variant="ghost" icon="refresh" busy={loading} className="max-sm:size-8 max-sm:px-0 pointer-coarse:max-sm:size-11" onClick={() => void refresh()}><span className="max-sm:sr-only">Refresh</span></Button><ShadButton asChild variant="outline" size="sm" className="rounded-lg font-semibold"><a href="/">My schedule</a></ShadButton></div>
      </div>
    </header>
    <main className="mx-auto grid w-full max-w-[1120px] gap-5 px-4 pb-12 pt-6 lg:px-8 lg:pt-8">
      <PageHeader title="Support" eyebrow="Owner tools" description="Review shared schedules, publish corrections, verify members and handle reports." />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile icon="inbox" tone={openCount ? 'now' : 'success'} value={openCount} label="open items" />
        <StatTile icon="school" tone="accent" value={schools.length} label="schools" />
        <StatTile icon="checkCircle" tone="success" value={approved} label="approved" className="max-sm:col-span-2" />
      </div>
      {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
      <Section id="schools-title" title="Schools" icon="school" description={`${pluralize(schools.length, 'school')} · ${approved} approved`} action={<div className="relative min-w-[180px]"><Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" /><Input small className="max-w-[240px] pl-8" aria-label="Filter schools" placeholder="Filter by name or town" value={filter} onChange={(event) => setFilter(event.target.value)} /></div>}>
        {visible.length === 0 && <Hint>No schools match.</Hint>}
        {visible.length > 0 && <div className="overflow-hidden rounded-2xl ring-1 ring-foreground/[0.06]"><Table>
          <TableHeader className="bg-muted/70"><TableRow><TableHead>School</TableHead><TableHead>Members</TableHead><TableHead>Status</TableHead><TableHead>Rev.</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
          <TableBody>{visible.map((entry) => <TableRow key={entry.id}>
            <TableCell className="whitespace-normal"><strong className="text-sm font-bold">{entry.name}</strong><Hint>{entry.location}</Hint></TableCell>
            <TableCell className="tabular-nums">{entry.memberCount}</TableCell>
            <TableCell><div className="flex flex-wrap gap-1">{entry.approved ? <Chip tone="success" icon="check">Approved</Chip> : <Chip tone="warning">Unreviewed</Chip>}{entry.supportLocked && <Chip icon="lock">Support locked</Chip>}{entry.memberLocked && <Chip icon="users">Member lock</Chip>}</div></TableCell>
            <TableCell className="tabular-nums">{entry.version}</TableCell>
            <TableCell className="text-right"><div className="inline-flex gap-1.5"><Button size="sm" onClick={() => setDirectorySchool(entry.id)} aria-label={`Class directory for ${entry.name}`}>Classes</Button><Button size="sm" variant="soft" onClick={() => setSelected(entry.id)} aria-label={`Review ${entry.name}`}>Review</Button></div></TableCell>
          </TableRow>)}</TableBody>
        </Table></div>}
      </Section>

      <Section id="inbox-title" title="Correction requests and appeals" icon="inbox" description={requests.length ? `${pluralize(requests.length, 'open request')}. Resolving a request only closes it; publish the fix from the school review. An appeal is answered by lifting the pause or removal, or by resolving it to keep the sanction.` : 'Students send correction requests from their School view, and appeals against a messaging pause or a removal.'}>
        {!loading && requests.length === 0 && <Hint className="flex items-center gap-1.5"><Icon name="check" size={14} />Inbox is empty</Hint>}
        {requests.length > 0 && <ul className="grid gap-2">{requests.map((request) => {
          const appeal = requestKind(request.kind);
          return <li key={request.id} className="grid gap-2 rounded-2xl bg-muted/70 p-4 ring-1 ring-inset ring-foreground/[0.04]">
            {appeal && <div><Chip tone="warning" icon="flag">{appeal.label}</Chip></div>}
            <div className="flex flex-wrap items-start justify-between gap-3"><span><strong className="text-sm font-bold">{appeal ? request.displayName || request.email : request.schoolName ?? 'No school yet'}</strong> <Hint className="inline">({request.email}{appeal && request.schoolName ? ` · ${request.schoolName}` : ''})</Hint></span><Hint>{formatDate(instantParts(request.createdAt, browserTimeZone()).date, { weekday: 'short', year: true })}</Hint></div>
            <p className="whitespace-pre-wrap text-sm">{request.message}</p>
            <div className="flex flex-wrap gap-2">
              {!appeal && request.schoolId && <Button size="sm" icon="edit" onClick={() => setSelected(request.schoolId)}>Review school</Button>}
              {appeal?.appeal === 'pause' && <Button size="sm" icon="unlock" disabled={!accountId} onClick={() => { if (accountId) void act(() => api.admin.liftChatPause.mutate({ accountId, userId: request.userId })); }}>Lift pause</Button>}
              {appeal?.appeal === 'ban' && request.schoolId && <Button size="sm" icon="unlock" disabled={!accountId} onClick={() => { if (accountId) void act(() => api.admin.liftBan.mutate({ accountId, userId: request.userId, schoolId: request.schoolId! })); }}>Lift removal</Button>}
              <Button size="sm" variant="ghost" icon="check" onClick={async () => { setError(''); try { await api.admin.resolveRequest.mutate({ id: request.id }); await refresh(); } catch (err) { setError(errorMessage(err)); } }}>{appeal ? 'Keep as is' : 'Mark resolved'}</Button>
            </div>
          </li>;
        })}</ul>}
      </Section>

      <Section id="verifications-title" title="Verification requests" icon="checkCircle" description={verifications.length ? `${pluralize(verifications.length, 'student')} waiting for a decision. Approve only with convincing proof of enrollment.` : 'Students without a school email send proof from their People view.'}>
        {!loading && verifications.length === 0 && <Hint className="flex items-center gap-1.5"><Icon name="check" size={14} />Nothing to verify</Hint>}
        {verifications.length > 0 && <ul className="grid gap-2">{verifications.map((request) => <li key={request.id} className="grid gap-2 rounded-2xl bg-muted/70 p-4 ring-1 ring-inset ring-foreground/[0.04]">
          <div className="flex flex-wrap items-start justify-between gap-3"><span><strong className="text-sm font-bold">{request.displayName}</strong> <Hint className="inline">({request.fullName} · {request.email})</Hint><Hint>{request.schoolName}</Hint></span><Hint>{formatDate(instantParts(request.createdAt, browserTimeZone()).date, { weekday: 'short', year: true })}</Hint></div>
          <p className="whitespace-pre-wrap text-sm">{request.proof}</p>
          <div className="flex flex-wrap gap-2"><Button size="sm" variant="primary" icon="check" onClick={() => void act(() => api.admin.decideVerification.mutate({ id: request.id, approve: true }))}>Verify</Button><Button size="sm" variant="ghost" onClick={() => void act(() => api.admin.decideVerification.mutate({ id: request.id, approve: false }))}>Decline</Button></div>
        </li>)}</ul>}
      </Section>

      <Section id="reports-title" title="Member reports" icon="alert" description={`${reports.length ? `${pluralize(reports.length, 'open report')}. Removing a member takes them out of the school, closes their verification request, ends all of their friendships and chats (at any school) and blocks rejoining.` : 'Students report members from a profile or a chat. Reports are private.'} Chat reports include messages from that one chat only, and opening them is logged. Other chats stay private.`}>
        {!loading && reports.length === 0 && <Hint className="flex items-center gap-1.5"><Icon name="check" size={14} />No open reports</Hint>}
        {reports.length > 0 && <ul className="grid gap-2">{reports.map((report) => {
          const items = evidence[report.id];
          return <li key={report.id} className="grid gap-2 rounded-2xl bg-muted/70 p-4 ring-1 ring-inset ring-foreground/[0.04]">
            {report.isChat && <div className="flex flex-wrap gap-1.5"><Chip tone="accent" icon="message">Chat</Chip>{report.category && <Chip tone={report.category === 'danger' ? 'danger' : 'neutral'} icon={report.category === 'danger' ? 'alert' : undefined}>{REPORT_CATEGORIES[report.category].short}</Chip>}</div>}
            <div className="flex flex-wrap items-start justify-between gap-3"><span><strong className="text-sm font-bold">{report.reportedName}</strong> <Hint className="inline">({report.reportedEmail})</Hint><Hint>Reported by {report.reporterName}{report.schoolName ? ` · ${report.schoolName}` : ''}</Hint></span><Hint>{formatDate(instantParts(report.createdAt, browserTimeZone()).date, { weekday: 'short', year: true })}</Hint></div>
            <p className="whitespace-pre-wrap break-words text-sm">{report.reason}</p>
            {report.isChat && <Hint>{pluralize(report.history.reports, 'report')} · {pluralize(report.history.removals, 'removal')} · {pluralize(report.history.pauses, 'pause')}</Hint>}
            {report.pause && <Hint className="flex items-center gap-1.5"><Icon name="lock" size={14} />{report.pause.until ? `Messaging paused until ${formatInstant(report.pause.until)}` : 'Messaging paused until lifted'}</Hint>}
            {items && <ol aria-label="Reported messages" className="grid gap-2">{items.map((item) => {
              const key = `${report.id}:${item.seq}`;
              return <li key={item.seq} className={`grid gap-1.5 rounded-xl bg-card p-3 ring-1 ring-inset ${item.anchor ? 'ring-destructive/40' : 'ring-foreground/[0.06]'}`}>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[13px] font-semibold">{item.senderName} · <span className="font-normal text-muted-foreground">{formatInstant(item.createdAt)}</span></span>
                  {item.anchor && <Chip tone="danger">Reported message</Chip>}
                  {item.deletedBy === 'sender' && <Chip tone="outline">Deleted by sender</Chip>}
                  {item.deletedBy === 'support' && <Chip tone="warning">Hidden by support</Chip>}
                </div>
                {/* Plain text only: no links, no markup. */}
                <p className="whitespace-pre-wrap break-words text-sm">{item.body}</p>
                {item.deletedBy !== 'support' && <div><Button size="sm" variant="ghost" busy={hiding === key} disabled={hiding !== null && hiding !== key} onClick={() => void hideMessage(report.id, item.seq)}>Hide message</Button></div>}
              </li>;
            })}</ol>}
            <div className="flex flex-wrap gap-2">
              {report.isChat && report.evidenceCount > 0 && (items
                ? <Button size="sm" variant="soft" icon="x" onClick={() => closeEvidence(report.id)}>Close messages</Button>
                : <Button size="sm" variant="soft" icon="message" busy={opening === report.id} disabled={!accountId} onClick={() => void showEvidence(report.id)}>Show messages ({report.evidenceCount})</Button>)}
              <Button size="sm" variant="ghost" icon="check" onClick={() => void act(() => api.admin.resolveReport.mutate({ id: report.id, outcome: 'dismissed' }))}>Dismiss</Button>
              <Button size="sm" icon="lock" disabled={!accountId} onClick={() => setPauseTarget({ userId: report.reportedId, name: report.reportedName })}>Pause messaging</Button>
              {report.schoolId && <Button size="sm" variant="danger" onClick={() => { const reason = prompt(`Remove ${report.reportedName} from ${report.schoolName}? Enter the reason. The student sees it and can appeal.`); if (reason?.trim()) void act(() => api.admin.removeMember.mutate({ userId: report.reportedId, schoolId: report.schoolId!, reason: reason.trim() })); }}>Remove from school</Button>}
            </div>
          </li>;
        })}</ul>}
      </Section>

      <Section id="paused-title" title="Paused members" icon="lock" description="These accounts can read their chats but cannot send messages. They see the reason and can appeal.">
        {!loading && pauses.length === 0 && <Hint className="flex items-center gap-1.5"><Icon name="check" size={14} />Nobody is paused.</Hint>}
        {pauses.length > 0 && <ul className="grid gap-2">{pauses.map((pause) => <li key={pause.userId} className="flex flex-wrap items-start justify-between gap-3 rounded-2xl bg-muted/70 p-4 ring-1 ring-inset ring-foreground/[0.04]">
          <div className="min-w-0"><p className="text-sm"><strong className="font-bold">{pause.displayName}</strong> · until {pause.until ? formatInstant(pause.until) : 'lifted'}</p><Hint>{pause.email}</Hint><Hint className="whitespace-pre-wrap break-words">Reason: {pause.reason}</Hint></div>
          <Button size="sm" icon="unlock" disabled={!accountId} aria-label={`Lift pause for ${pause.displayName}`} onClick={() => { if (accountId) void act(() => api.admin.liftChatPause.mutate({ accountId, userId: pause.userId })); }}>Lift pause</Button>
        </li>)}</ul>}
      </Section>

      <Section id="removed-title" title="Removed members" icon="ban" description="Students removed from a school. They see the reason on the school step, can appeal, and can join another school. Lifting a removal lets them rejoin.">
        {!loading && bans.length === 0 && <Hint className="flex items-center gap-1.5"><Icon name="check" size={14} />Nobody is removed.</Hint>}
        {bans.length > 0 && <ul className="grid gap-2">{bans.map((ban) => <li key={`${ban.userId}:${ban.schoolId}`} className="flex flex-wrap items-start justify-between gap-3 rounded-2xl bg-muted/70 p-4 ring-1 ring-inset ring-foreground/[0.04]">
          <div className="min-w-0 grid gap-1"><p className="text-sm"><strong className="font-bold">{ban.displayName}</strong> · removed from {ban.schoolName} on {formatDate(instantParts(ban.createdAt, browserTimeZone()).date, { weekday: 'short', year: true })}</p><Hint>{ban.email}</Hint><Hint className="whitespace-pre-wrap break-words">Reason: {ban.reason}</Hint>{ban.appealed && <div><Chip tone="warning" icon="flag">Appeal pending</Chip></div>}</div>
          <Button size="sm" icon="unlock" disabled={!accountId} aria-label={`Lift removal for ${ban.displayName}`} onClick={() => { if (accountId) void act(() => api.admin.liftBan.mutate({ accountId, userId: ban.userId, schoolId: ban.schoolId })); }}>Lift removal</Button>
        </li>)}</ul>}
      </Section>

      <Section id="proposals-title" title="Passed proposals awaiting support" icon="users" description={proposals.length ? 'These votes passed on support-locked schools. Publishing keeps the approval and lock; students review the change as a new revision.' : 'Votes that pass on a support-locked school appear here for publication.'}>
        {!loading && proposals.length === 0 && <Hint className="flex items-center gap-1.5"><Icon name="check" size={14} />Nothing waiting</Hint>}
        {proposals.length > 0 && <ul className="grid gap-2">{proposals.map((proposal) => <li key={proposal.id} className="grid gap-2 rounded-2xl bg-muted/70 p-4 ring-1 ring-inset ring-foreground/[0.04]">
          <div className="flex flex-wrap items-start justify-between gap-3"><span><strong className="text-sm font-bold">{proposal.summary}</strong><Hint>{schools.find((entry) => entry.id === proposal.schoolId)?.name ?? proposal.schoolId} · proposed by {proposal.proposerName} · {proposal.votesFor} for, {proposal.votesAgainst} against · based on revision {proposal.baseVersion}</Hint></span><Hint>{formatDate(instantParts(proposal.createdAt, browserTimeZone()).date, { weekday: 'short', year: true })}</Hint></div>
          <Panel><ScheduleSummary schedule={proposal.schedule} /></Panel>
          <div className="flex flex-wrap gap-2"><Button size="sm" variant="primary" icon="check" onClick={() => void act(() => api.admin.decideProposal.mutate({ id: proposal.id, publish: true }))}>Publish revision</Button><Button size="sm" variant="ghost" onClick={() => void act(() => api.admin.decideProposal.mutate({ id: proposal.id, publish: false }))}>Decline</Button><Button size="sm" onClick={() => setSelected(proposal.schoolId)}>Review school</Button></div>
        </li>)}</ul>}
      </Section>
    </main>
    {directorySchool && <SchoolDirectory schoolId={directorySchool} online onClose={() => setDirectorySchool(null)} />}
    {school && <ReviewSheet key={school.id} school={school} onClose={() => setSelected(null)} onSaved={refresh} />}
    {pauseTarget && accountId && <PauseSheet key={pauseTarget.userId} target={pauseTarget} accountId={accountId} onClose={() => setPauseTarget(null)} onPaused={refresh} />}
  </div>;
}

function ReviewSheet({ school, onClose, onSaved }: { school: School; onClose: () => void; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState<Schedule>(() => structuredClone(school.schedule));
  const [approved, setApproved] = useState(school.approved);
  const [supportLocked, setSupportLocked] = useState(school.supportLocked);
  const [domains, setDomains] = useState(school.emailDomains.join(', '));
  const domainList = domains.split(/[,\s]+/).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const issues = describeIssues(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(school.schedule) || approved !== school.approved || supportLocked !== school.supportLocked || domainList.join(',') !== school.emailDomains.join(',');
  return <Modal open onClose={onClose} dirty={dirty} busy={pending} wide title={`Review ${school.name}`} description={`${school.location} · ${pluralize(school.memberCount, 'member')} · revision ${school.version}. Saving publishes a new revision; students keep their personal settings and review the change.`}
    footer={<><Button variant="ghost" onClick={onClose} disabled={pending}>Done</Button><Spacer />{saved && <span className="flex items-center gap-1 text-sm font-semibold text-success" role="status"><Icon name="check" size={16} />Published</span>}<Button variant="primary" busy={pending} disabled={issues.length > 0 || !dirty} onClick={async () => {
      setPending(true); setError(''); setSaved(false);
      try { await api.admin.update.mutate({ schoolId: school.id, expectedVersion: school.version, schedule: scheduleSchema.parse(draft), approved, supportLocked, emailDomains: domainList }); setSaved(true); await onSaved(); }
      catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
    }}>Save school revision</Button></>}>
    <Panel className="grid gap-3">
      <ScheduleSummary schedule={school.schedule} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Toggle label="Approved default schedule" checked={approved} onChange={setApproved} description="New members get this schedule by default." />
        <Toggle label="Lock shared edits to support" checked={supportLocked} onChange={setSupportLocked} description={school.memberLocked ? 'The 10-member editing lock is also in effect.' : 'Members can no longer publish revisions.'} />
      </div>
      <Field label="School email domains" htmlFor="school-domains" hint="Students who sign in with a Google address on one of these domains are verified automatically, including current members the next time they open Quasar. Separate several with commas."><Input id="school-domains" placeholder="students.example.org, example.org" value={domains} onChange={(event) => setDomains(event.target.value)} /></Field>
    </Panel>
    <ScheduleEditor value={draft} onChange={setDraft} initialSection="preview" />
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
  </Modal>;
}

const PAUSE_LENGTHS = { '1': 1, '7': 7, '30': 30, lifted: null } as const;
type PauseLength = keyof typeof PAUSE_LENGTHS;

function PauseSheet({ target, accountId, onClose, onPaused }: { target: PauseTarget; accountId: string; onClose: () => void; onPaused: () => Promise<void> }) {
  const [length, setLength] = useState<PauseLength>('7');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const trimmed = reason.trim();
  const submit = async () => {
    setPending(true); setError('');
    try {
      await api.admin.pauseChat.mutate({ accountId, userId: target.userId, days: PAUSE_LENGTHS[length], reason: trimmed });
      onClose(); await onPaused();
    } catch (err) { setError(errorMessage(err)); }
    finally { setPending(false); }
  };
  return <Modal open onClose={onClose} dirty={reason.length > 0} busy={pending} title={`Pause ${target.name}’s messaging`}
    description="They can still read their chats, mute, block and report, but they cannot send messages. They see the reason and can appeal. Their open reports close as paused, and the pause is written to the audit log."
    footer={<><Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button><Spacer /><Button variant="danger" busy={pending} disabled={trimmed.length < 3} onClick={() => void submit()}>Pause messaging</Button></>}>
    <div className="grid gap-4">
      <Field label="Pause length" htmlFor="pause-length">
        <Select id="pause-length" aria-label="Pause length" value={length} onChange={(event) => setLength(event.target.value as PauseLength)} disabled={pending}>
          <option value="1">1 day</option>
          <option value="7">7 days</option>
          <option value="30">30 days</option>
          <option value="lifted">Until lifted</option>
        </Select>
      </Field>
      <Field label="Reason (shown to the student)" htmlFor="pause-reason" hint="The student reads this under the pause notice and can appeal. At least 3 characters."><Textarea id="pause-reason" required minLength={3} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} disabled={pending} /></Field>
      {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    </div>
  </Modal>;
}
