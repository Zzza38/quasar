'use client';

import { useCallback, useEffect, useState } from 'react';
import { signIn } from 'next-auth/react';
import { api, errorMessage, type RouterOutput, type School } from '@/client/api';
import { scheduleSchema, type Schedule } from '@/domain/schedule';
import { formatDate, pluralize } from '@/lib/format';
import { Icon } from './icon';
import { describeIssues, ScheduleEditor, ScheduleSummary } from './schedule-editor';
import { Brand, CenteredNotice } from './shell';
import { Button, Callout, Chip, EmptyState, SectionHeader, Sheet, Toggle } from './ui';

type Request = RouterOutput['admin']['requests'][number];

export function Admin() {
  const [schools, setSchools] = useState<School[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [allowed, setAllowed] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
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

  if (loading && !allowed) return <CenteredNotice title="Loading support tools…"><span className="spinner inline-block" aria-hidden="true" /></CenteredNotice>;
  if (!allowed) {
    return <CenteredNotice title={signedIn ? 'Owner access required' : 'Sign in to continue'} action={<div className="grid gap-2 justify-items-center">
      {!signedIn && <Button variant="primary" onClick={() => void signIn('google', { callbackUrl: '/admin' })}>Continue with Google</Button>}
      <div className="flex gap-2"><Button size="sm" onClick={() => void refresh()}>Retry</Button><Button size="sm" variant="ghost" onClick={() => window.location.assign('/')}>Back to my schedule</Button></div>
    </div>}>
      {error || (signedIn ? 'This page is available to the project owner.' : 'Sign in with the owner account to review school schedules.')}
    </CenteredNotice>;
  }

  const visible = filter ? schools.filter((entry) => `${entry.name} ${entry.location}`.toLowerCase().includes(filter.toLowerCase())) : schools;
  return <div className="admin">
    <header className="app-topbar admin-topbar">
      <div className="flex items-center gap-3"><Brand /><Chip tone="accent" icon="inbox">Support</Chip></div>
      <div className="flex items-center gap-2"><Button size="sm" variant="ghost" icon="refresh" busy={loading} onClick={() => void refresh()}>Refresh</Button><a className="btn btn-secondary btn-sm" href="/">My schedule</a></div>
    </header>
    <main className="grid gap-4">
      {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
      <section className="card card-pad grid gap-3" aria-labelledby="inbox-title">
        <SectionHeader title={<span id="inbox-title">Correction requests</span>} description={requests.length ? `${pluralize(requests.length, 'open request')}. Resolving a request only closes it; publish the fix from the school review.` : 'Students send correction requests from their School view.'} />
        {requests.length === 0 && <EmptyState icon="inbox" title="Inbox is empty" />}
        {requests.length > 0 && <ul className="grid gap-2">{requests.map((request) => <li key={request.id} className="panel p-4 grid gap-2">
          <div className="flex items-start justify-between gap-3 flex-wrap"><strong className="text-sm">{request.schoolName}</strong><span className="hint">{formatDate(request.createdAt.slice(0, 10), { weekday: 'short', year: true })}</span></div>
          <p className="text-sm whitespace-pre-wrap">{request.message}</p>
          <div className="flex gap-2 flex-wrap"><Button size="sm" icon="edit" onClick={() => setSelected(request.schoolId)}>Review school</Button><Button size="sm" variant="ghost" icon="check" onClick={async () => { setError(''); try { await api.admin.resolveRequest.mutate({ id: request.id }); await refresh(); } catch (err) { setError(errorMessage(err)); } }}>Mark resolved</Button></div>
        </li>)}</ul>}
      </section>

      <section className="card card-pad grid gap-3" aria-labelledby="schools-title">
        <SectionHeader title={<span id="schools-title">Schools</span>} description={`${pluralize(schools.length, 'school')} · ${schools.filter((entry) => entry.approved).length} approved`} action={<input className="input sm max-w-[220px]" aria-label="Filter schools" placeholder="Filter by name or town" value={filter} onChange={(event) => setFilter(event.target.value)} />} />
        {visible.length === 0 && <p className="hint">No schools match.</p>}
        {visible.length > 0 && <div className="overflow-x-auto"><table className="admin-table">
          <thead><tr><th>School</th><th>Members</th><th>Status</th><th>Rev.</th><th><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{visible.map((entry) => <tr key={entry.id}>
            <td><strong className="text-sm">{entry.name}</strong><div className="hint">{entry.location}</div></td>
            <td className="tabular">{entry.memberCount}</td>
            <td><div className="flex gap-1 flex-wrap">{entry.approved ? <Chip tone="success" icon="check">Approved</Chip> : <Chip tone="warning">Unreviewed</Chip>}{entry.supportLocked && <Chip icon="lock">Support locked</Chip>}{entry.memberLocked && <Chip icon="users">Member lock</Chip>}</div></td>
            <td className="tabular">{entry.version}</td>
            <td className="text-right"><Button size="sm" onClick={() => setSelected(entry.id)} aria-label={`Review ${entry.name}`}>Review</Button></td>
          </tr>)}</tbody>
        </table></div>}
      </section>
    </main>
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
  return <Sheet open onClose={onClose} wide title={`Review ${school.name}`} description={`${school.location} · ${pluralize(school.memberCount, 'member')} · revision ${school.version}. Saving publishes a new revision; students keep their personal settings and review the change.`}
    footer={<><Button variant="ghost" onClick={onClose} disabled={pending}>Done</Button><span className="spacer" />{saved && <span className="text-sm text-success flex items-center gap-1" role="status"><Icon name="check" size={16} />Published</span>}<Button variant="primary" busy={pending} disabled={issues.length > 0 || !dirty} onClick={async () => {
      setPending(true); setError(''); setSaved(false);
      try { await api.admin.update.mutate({ schoolId: school.id, expectedVersion: school.version, schedule: scheduleSchema.parse(draft), approved, supportLocked }); setSaved(true); await onSaved(); }
      catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
    }}>Save school revision</Button></>}>
    <div className="panel p-4 grid gap-3">
      <ScheduleSummary schedule={school.schedule} />
      <div className="grid gap-2 sm:grid-cols-2">
        <Toggle label="Approved default schedule" checked={approved} onChange={setApproved} />
        <Toggle label="Lock shared edits to support" checked={supportLocked} onChange={setSupportLocked} />
      </div>
      <p className="hint">{approved ? 'New members get this schedule by default.' : 'Members must explicitly choose this unreviewed schedule or build their own.'} {school.memberLocked ? 'The 10-member editing lock is also in effect.' : ''}</p>
    </div>
    <ScheduleEditor value={draft} onChange={setDraft} initialSection="preview" />
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
  </Sheet>;
}
