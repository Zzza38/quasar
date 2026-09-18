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
import { Button, Callout, Chip, EmptyState, Hint, Input, Modal, Panel, Section, Spacer, Toggle } from './primitives';
import { Button as ShadButton } from './ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

type Request = RouterOutput['admin']['requests'][number];

export function Admin() {
  const [schools, setSchools] = useState<School[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
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
      const [schoolList, requestList] = await Promise.all([api.admin.schools.query(), api.admin.requests.query()]);
      setSchools(schoolList); setRequests(requestList); setAllowed(true);
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
  return <div className="mx-auto min-h-dvh w-full max-w-[1120px] px-4 pb-10 pt-4 lg:px-8">
    <header className="mb-5 flex items-center justify-between gap-3">
      <div className="flex items-center gap-3"><Brand /><Chip tone="accent" icon="inbox">Support</Chip></div>
      <div className="flex items-center gap-2"><Button size="sm" variant="ghost" icon="refresh" busy={loading} onClick={() => void refresh()}>Refresh</Button><ShadButton asChild variant="outline" size="sm"><a href="/">My schedule</a></ShadButton></div>
    </header>
    <main className="grid gap-4">
      {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
      <Section id="inbox-title" title="Correction requests" description={requests.length ? `${pluralize(requests.length, 'open request')}. Resolving a request only closes it; publish the fix from the school review.` : 'Students send correction requests from their School view.'}>
        {requests.length === 0 && <EmptyState icon="inbox" title="Inbox is empty" />}
        {requests.length > 0 && <ul className="grid gap-2">{requests.map((request) => <li key={request.id} className="grid gap-2 rounded-lg bg-muted p-4">
          <div className="flex flex-wrap items-start justify-between gap-3"><strong className="text-sm">{request.schoolName}</strong><Hint>{formatDate(request.createdAt.slice(0, 10), { weekday: 'short', year: true })}</Hint></div>
          <p className="whitespace-pre-wrap text-sm">{request.message}</p>
          <div className="flex flex-wrap gap-2"><Button size="sm" icon="edit" onClick={() => setSelected(request.schoolId)}>Review school</Button><Button size="sm" variant="ghost" icon="check" onClick={async () => { setError(''); try { await api.admin.resolveRequest.mutate({ id: request.id }); await refresh(); } catch (err) { setError(errorMessage(err)); } }}>Mark resolved</Button></div>
        </li>)}</ul>}
      </Section>

      <Section id="schools-title" title="Schools" description={`${pluralize(schools.length, 'school')} · ${schools.filter((entry) => entry.approved).length} approved`} action={<Input small className="max-w-[220px]" aria-label="Filter schools" placeholder="Filter by name or town" value={filter} onChange={(event) => setFilter(event.target.value)} />}>
        {visible.length === 0 && <Hint>No schools match.</Hint>}
        {visible.length > 0 && <Table>
          <TableHeader><TableRow><TableHead>School</TableHead><TableHead>Members</TableHead><TableHead>Status</TableHead><TableHead>Rev.</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader>
          <TableBody>{visible.map((entry) => <TableRow key={entry.id}>
            <TableCell className="whitespace-normal"><strong className="text-sm">{entry.name}</strong><Hint>{entry.location}</Hint></TableCell>
            <TableCell className="tabular-nums">{entry.memberCount}</TableCell>
            <TableCell><div className="flex flex-wrap gap-1">{entry.approved ? <Chip tone="success" icon="check">Approved</Chip> : <Chip tone="warning">Unreviewed</Chip>}{entry.supportLocked && <Chip icon="lock">Support locked</Chip>}{entry.memberLocked && <Chip icon="users">Member lock</Chip>}</div></TableCell>
            <TableCell className="tabular-nums">{entry.version}</TableCell>
            <TableCell className="text-right"><Button size="sm" onClick={() => setDirectorySchool(entry.id)} aria-label={`Class directory for ${entry.name}`}>Classes</Button><Button size="sm" onClick={() => setSelected(entry.id)} aria-label={`Review ${entry.name}`}>Review</Button></TableCell>
          </TableRow>)}</TableBody>
        </Table>}
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
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const issues = describeIssues(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(school.schedule) || approved !== school.approved || supportLocked !== school.supportLocked;
  return <Modal open onClose={onClose} wide title={`Review ${school.name}`} description={`${school.location} · ${pluralize(school.memberCount, 'member')} · revision ${school.version}. Saving publishes a new revision; students keep their personal settings and review the change.`}
    footer={<><Button variant="ghost" onClick={onClose} disabled={pending}>Done</Button><Spacer />{saved && <span className="flex items-center gap-1 text-sm text-success" role="status"><Icon name="check" size={16} />Published</span>}<Button variant="primary" busy={pending} disabled={issues.length > 0 || !dirty} onClick={async () => {
      setPending(true); setError(''); setSaved(false);
      try { await api.admin.update.mutate({ schoolId: school.id, expectedVersion: school.version, schedule: scheduleSchema.parse(draft), approved, supportLocked }); setSaved(true); await onSaved(); }
      catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
    }}>Save school revision</Button></>}>
    <Panel className="grid gap-3">
      <ScheduleSummary schedule={school.schedule} />
      <div className="grid gap-2 sm:grid-cols-2">
        <Toggle label="Approved default schedule" checked={approved} onChange={setApproved} />
        <Toggle label="Lock shared edits to support" checked={supportLocked} onChange={setSupportLocked} />
      </div>
      <Hint>{approved ? 'New members get this schedule by default.' : 'Members must explicitly choose this unreviewed schedule or build their own.'} {school.memberLocked ? 'The 10-member editing lock is also in effect.' : ''}</Hint>
    </Panel>
    <ScheduleEditor value={draft} onChange={setDraft} initialSection="preview" />
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
  </Modal>;
}
