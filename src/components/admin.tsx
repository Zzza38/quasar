'use client';

import { useCallback, useEffect, useState } from 'react';
import { signIn } from 'next-auth/react';
import { GoogleLogo } from './google-logo';
import { SchoolDirectory } from './school-directory';
import { api, errorMessage, type RouterOutput, type School } from '@/client/api';
import { scheduleSchema, type Schedule } from '@/domain/schedule';
import { formatDate, pluralize } from '@/lib/format';
import { Icon, Spinner } from './icon';
import { describeIssues, ScheduleEditor, ScheduleSummary } from './schedule-editor';
import { Brand, CenteredNotice } from './shell';
import { Button, Callout, Chip, EmptyState, Field, Hint, Input, Modal, PageHeader, Panel, Section, Spacer, StatTile, Toggle } from './primitives';
import { Button as ShadButton } from './ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

type Request = RouterOutput['admin']['requests'][number];
type VerificationRequest = RouterOutput['admin']['verificationRequests'][number];
type Report = RouterOutput['admin']['reports'][number];
type PendingProposal = RouterOutput['admin']['proposals'][number];

export function Admin() {
  const [schools, setSchools] = useState<School[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [verifications, setVerifications] = useState<VerificationRequest[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [proposals, setProposals] = useState<PendingProposal[]>([]);
  const [allowed, setAllowed] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [directorySchool, setDirectorySchool] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const session = await api.session.query(); setSignedIn(Boolean(session));
      if (!session?.isAdmin) { setAllowed(false); setSchools([]); setRequests([]); return; }
      const [schoolList, requestList, verificationList, reportList, proposalList] = await Promise.all([api.admin.schools.query(), api.admin.requests.query(), api.admin.verificationRequests.query(), api.admin.reports.query(), api.admin.proposals.query()]);
      setSchools(schoolList); setRequests(requestList); setVerifications(verificationList); setReports(reportList); setProposals(proposalList); setAllowed(true);
    } catch (err) { setError(errorMessage(err)); setAllowed(false); setSchools([]); setRequests([]); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const school = schools.find((entry) => entry.id === selected);

  if (loading && !allowed) return <CenteredNotice title="Loading support tools…"><Spinner className="inline-block text-primary" size={20} /></CenteredNotice>;
  if (!allowed) {
    return <CenteredNotice title={signedIn ? 'Owner access required' : 'Sign in to continue'} action={<div className="grid justify-items-center gap-2">
      {!signedIn && <Button variant="primary" onClick={() => void signIn('google', { callbackUrl: '/admin' })}><GoogleLogo />Continue with Google</Button>}
      <div className="flex gap-2"><Button size="sm" onClick={() => void refresh()}>Retry</Button><Button size="sm" variant="ghost" onClick={() => window.location.assign('/')}>Back to my schedule</Button></div>
    </div>}>
      {error || (signedIn ? 'This page is available to the project owner.' : 'Sign in with the owner account to review school schedules.')}
    </CenteredNotice>;
  }

  const visible = filter ? schools.filter((entry) => `${entry.name} ${entry.location}`.toLowerCase().includes(filter.toLowerCase())) : schools;
  const approved = schools.filter((entry) => entry.approved).length;
  const act = async (action: () => Promise<unknown>) => { setError(''); try { await action(); await refresh(); } catch (err) { setError(errorMessage(err)); } };
  const openCount = requests.length + verifications.length + reports.length + proposals.length;
  return <div className="app-canvas min-h-dvh">
    <header className="glass sticky top-0 z-30 border-b border-foreground/[0.06]">
      <div className="mx-auto flex h-14 w-full max-w-[1120px] items-center justify-between gap-3 px-4 lg:px-8">
        <div className="flex items-center gap-3"><Brand /><Chip tone="accent" icon="inbox">Support</Chip></div>
        <div className="flex items-center gap-2"><Button size="sm" variant="ghost" icon="refresh" busy={loading} onClick={() => void refresh()}>Refresh</Button><ShadButton asChild variant="outline" size="sm" className="rounded-lg font-semibold"><a href="/">My schedule</a></ShadButton></div>
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
      <Section id="inbox-title" title="Correction requests" icon="inbox" description={requests.length ? `${pluralize(requests.length, 'open request')}. Resolving a request only closes it; publish the fix from the school review.` : 'Students send correction requests from their School view.'}>
        {requests.length === 0 && <EmptyState icon="inbox" title="Inbox is empty" />}
        {requests.length > 0 && <ul className="grid gap-2">{requests.map((request) => <li key={request.id} className="grid gap-2 rounded-2xl bg-muted/70 p-4 ring-1 ring-inset ring-foreground/[0.04]">
          <div className="flex flex-wrap items-start justify-between gap-3"><span><strong className="text-sm font-bold">{request.schoolName ?? 'No school yet'}</strong> <Hint className="inline">({request.email})</Hint></span><Hint>{formatDate(request.createdAt.slice(0, 10), { weekday: 'short', year: true })}</Hint></div>
          <p className="whitespace-pre-wrap text-sm">{request.message}</p>
          <div className="flex flex-wrap gap-2">{request.schoolId && <Button size="sm" icon="edit" onClick={() => setSelected(request.schoolId)}>Review school</Button>}<Button size="sm" variant="ghost" icon="check" onClick={async () => { setError(''); try { await api.admin.resolveRequest.mutate({ id: request.id }); await refresh(); } catch (err) { setError(errorMessage(err)); } }}>Mark resolved</Button></div>
        </li>)}</ul>}
      </Section>

      <Section id="verifications-title" title="Verification requests" icon="checkCircle" description={verifications.length ? `${pluralize(verifications.length, 'student')} waiting for a decision. Approve only with convincing proof of enrollment.` : 'Students without a school email send proof from their People view.'}>
        {verifications.length === 0 && <EmptyState icon="checkCircle" title="Nothing to verify" />}
        {verifications.length > 0 && <ul className="grid gap-2">{verifications.map((request) => <li key={request.id} className="grid gap-2 rounded-2xl bg-muted/70 p-4 ring-1 ring-inset ring-foreground/[0.04]">
          <div className="flex flex-wrap items-start justify-between gap-3"><span><strong className="text-sm font-bold">{request.displayName}</strong> <Hint className="inline">({request.fullName} · {request.email})</Hint><Hint>{request.schoolName}</Hint></span><Hint>{formatDate(request.createdAt.slice(0, 10), { weekday: 'short', year: true })}</Hint></div>
          <p className="whitespace-pre-wrap text-sm">{request.proof}</p>
          <div className="flex flex-wrap gap-2"><Button size="sm" variant="primary" icon="check" onClick={() => void act(() => api.admin.decideVerification.mutate({ id: request.id, approve: true }))}>Verify</Button><Button size="sm" variant="ghost" onClick={() => void act(() => api.admin.decideVerification.mutate({ id: request.id, approve: false }))}>Decline</Button></div>
        </li>)}</ul>}
      </Section>

      <Section id="reports-title" title="Member reports" icon="alert" description={reports.length ? `${pluralize(reports.length, 'open report')}. Removing a member takes them out of the school, ends their friendships there and blocks rejoining.` : 'Students report members from a profile. Reports are private.'}>
        {reports.length === 0 && <EmptyState icon="users" title="No open reports" />}
        {reports.length > 0 && <ul className="grid gap-2">{reports.map((report) => <li key={report.id} className="grid gap-2 rounded-2xl bg-muted/70 p-4 ring-1 ring-inset ring-foreground/[0.04]">
          <div className="flex flex-wrap items-start justify-between gap-3"><span><strong className="text-sm font-bold">{report.reportedName}</strong> <Hint className="inline">({report.reportedEmail})</Hint><Hint>Reported by {report.reporterName}{report.schoolName ? ` · ${report.schoolName}` : ''}</Hint></span><Hint>{formatDate(report.createdAt.slice(0, 10), { weekday: 'short', year: true })}</Hint></div>
          <p className="whitespace-pre-wrap text-sm">{report.reason}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" icon="check" onClick={() => void act(() => api.admin.resolveReport.mutate({ id: report.id, outcome: 'dismissed' }))}>Dismiss</Button>
            {report.schoolId && <Button size="sm" variant="danger" onClick={() => { const reason = prompt(`Remove ${report.reportedName} from ${report.schoolName}? Enter the reason for the audit log.`); if (reason?.trim()) void act(() => api.admin.removeMember.mutate({ userId: report.reportedId, schoolId: report.schoolId!, reason: reason.trim() })); }}>Remove from school</Button>}
          </div>
        </li>)}</ul>}
      </Section>

      <Section id="proposals-title" title="Passed proposals awaiting support" icon="users" description={proposals.length ? 'These votes passed on support-locked schools. Publishing keeps the approval and lock; students review the change as a new revision.' : 'Votes that pass on a support-locked school appear here for publication.'}>
        {proposals.length === 0 && <EmptyState icon="layers" title="Nothing waiting" />}
        {proposals.length > 0 && <ul className="grid gap-2">{proposals.map((proposal) => <li key={proposal.id} className="grid gap-2 rounded-2xl bg-muted/70 p-4 ring-1 ring-inset ring-foreground/[0.04]">
          <div className="flex flex-wrap items-start justify-between gap-3"><span><strong className="text-sm font-bold">{proposal.summary}</strong><Hint>{schools.find((entry) => entry.id === proposal.schoolId)?.name ?? proposal.schoolId} · proposed by {proposal.proposerName} · {proposal.votesFor} for, {proposal.votesAgainst} against · based on revision {proposal.baseVersion}</Hint></span><Hint>{formatDate(proposal.createdAt.slice(0, 10), { weekday: 'short', year: true })}</Hint></div>
          <Panel><ScheduleSummary schedule={proposal.schedule} /></Panel>
          <div className="flex flex-wrap gap-2"><Button size="sm" variant="primary" icon="check" onClick={() => void act(() => api.admin.decideProposal.mutate({ id: proposal.id, publish: true }))}>Publish revision</Button><Button size="sm" variant="ghost" onClick={() => void act(() => api.admin.decideProposal.mutate({ id: proposal.id, publish: false }))}>Decline</Button><Button size="sm" onClick={() => setSelected(proposal.schoolId)}>Review school</Button></div>
        </li>)}</ul>}
      </Section>

      <Section id="schools-title" title="Schools" icon="school" description={`${pluralize(schools.length, 'school')} · ${approved} approved`} action={<div className="relative"><Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" /><Input small className="max-w-[240px] pl-8" aria-label="Filter schools" placeholder="Filter by name or town" value={filter} onChange={(event) => setFilter(event.target.value)} /></div>}>
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
    </main>
    {directorySchool && <SchoolDirectory schoolId={directorySchool} online onClose={() => setDirectorySchool(null)} />}
    {school && <ReviewSheet key={school.id} school={school} onClose={() => setSelected(null)} onSaved={refresh} />}
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
  return <Modal open onClose={onClose} wide title={`Review ${school.name}`} description={`${school.location} · ${pluralize(school.memberCount, 'member')} · revision ${school.version}. Saving publishes a new revision; students keep their personal settings and review the change.`}
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
      <Field label="School email domains" htmlFor="school-domains" hint="Students who sign in with a Google address on one of these domains are verified automatically. Separate several with commas."><Input id="school-domains" placeholder="students.example.org, example.org" value={domains} onChange={(event) => setDomains(event.target.value)} /></Field>
    </Panel>
    <ScheduleEditor value={draft} onChange={setDraft} initialSection="preview" />
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
  </Modal>;
}
