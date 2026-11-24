import { useEffect, useState } from 'react';
import { api, errorMessage, type RouterOutput, type School } from '@/client/api';
import { STAFF_LABELS, STAFF_ROLES, isStaffRole, type StaffRole } from '@/domain/staff';
import { Button, Callout, Chip, Field, Hint, Input, Modal, Section, Select, Spacer } from './primitives';

type Candidate = RouterOutput['admin']['roles']['candidate'];
type Grant = RouterOutput['admin']['roles']['list'][number];
type Target = Pick<Grant, 'userId' | 'email' | 'displayName'>;
type AccessLost = (err: unknown) => Promise<boolean>;

function MemberSearch({ onChoose, onClose, onAccessLost }: { onChoose: (target: Target) => void; onClose: () => void; onAccessLost: AccessLost }) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<RouterOutput['admin']['users']['search'] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!query.trim()) return;
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const result = await api.admin.users.search.query({ query: query.trim() });
        if (active) setRows(result);
      } catch (err) {
        if (active && !await onAccessLost(err)) setError(errorMessage(err));
      }
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [query, attempt, onAccessLost]);
  return <Modal open onClose={onClose} title="Assign a staff role" description="Find the member who should receive the role.">
    <Field label="Find a member" htmlFor="role-member-search">
      <Input autoFocus type="search" id="role-member-search" placeholder="Name, email or account ID" value={query} maxLength={200}
        onChange={event => { setQuery(event.target.value); setError(''); setRows(null); }} />
    </Field>
    {error && <Callout tone="danger" role="alert" actions={<Button size="sm" onClick={() => { setError(''); setAttempt(value => value + 1); }}>Retry search</Button>}>{error}</Callout>}
    {query.trim() && !rows && !error && <Hint role="status">Searching...</Hint>}
    {rows?.length === 0 && <Hint role="status">No matching members.</Hint>}
    {rows && rows.length > 0 && <ul className="grid max-h-80 gap-1 overflow-y-auto">{rows.map(row => <li key={row.id}>
      <Button className="h-auto w-full justify-start whitespace-normal py-2 text-left" onClick={() => onChoose({ userId: row.id, email: row.email, displayName: row.displayName })}>
        <span className="grid break-all"><strong>{row.displayName || row.email}</strong><span className="text-xs font-normal text-muted-foreground">{row.email}{row.schoolName && ` · ${row.schoolName}`}</span></span>
      </Button>
    </li>)}</ul>}
  </Modal>;
}

function GrantEditor({ target, accountId, schools, onClose, onSaved, onAccessLost }: {
  target: Target; accountId: string; schools: School[]; onClose: () => void; onSaved: (notice: string) => void; onAccessLost: AccessLost;
}) {
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [role, setRole] = useState<StaffRole | ''>('');
  const [revoking, setRevoking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    api.admin.roles.candidate.query({ userId: target.userId }).then(next => {
      if (active) { setCandidate(next); setRole(next.grant?.role ?? ''); }
    }).catch(async err => {
      if (active && !await onAccessLost(err)) setError(errorMessage(err));
    });
    return () => { active = false; };
  }, [attempt, onAccessLost, target.userId]);
  const grant = candidate?.grant;
  const needsBeta = role === 'school-manager' || role === 'chat-moderation';
  const missingSchool = role === 'school-manager' && !candidate?.schoolId;
  const pinnedName = grant?.schoolId && (schools.find(school => school.id === grant.schoolId)?.name ?? grant.schoolId);
  const sameAssignment = grant?.role === role && (role !== 'school-manager' || grant.schoolId === candidate?.schoolId);
  const submit = async () => {
    if (!candidate || busy || candidate.owner) return;
    const params = { accountId, userId: target.userId, expectedSchoolId: candidate.schoolId, expectedGrant: candidate.grant };
    setBusy(true); setError('');
    try {
      if (revoking && candidate.grant) {
        await api.admin.roles.revoke.mutate({ ...params, expectedGrant: candidate.grant });
        onSaved(`Revoked ${STAFF_LABELS[candidate.grant.role]} for ${target.email}.`);
      } else if (role && !missingSchool && !sameAssignment && !candidate.suspended) {
        await api.admin.roles.grant.mutate({ ...params, role });
        onSaved(`Assigned ${STAFF_LABELS[role]}${role === 'school-manager' ? ` at ${candidate.schoolName}` : ''} to ${target.email}.`);
      }
    } catch (err) {
      if (!await onAccessLost(err)) {
        setError(errorMessage(err));
        setCandidate(null); setRole(''); setRevoking(false); setAttempt(value => value + 1);
      }
    } finally { setBusy(false); }
  };
  return <Modal open onClose={onClose} busy={busy} title={revoking ? 'Revoke staff role?' : grant ? 'Manage staff role' : 'Assign a staff role'}
    description={<>{target.displayName && <strong>{target.displayName} · </strong>}{target.email}</>}
    footer={<>
      <Button variant="ghost" disabled={busy} onClick={revoking ? () => setRevoking(false) : onClose}>Cancel</Button><Spacer />
      {revoking ? <Button variant="danger" busy={busy} onClick={() => void submit()}>Confirm revocation</Button> : <>
        {grant && !candidate?.owner && <Button variant="danger" disabled={busy} onClick={() => setRevoking(true)}>Revoke role</Button>}
        {candidate && !candidate.owner && <Button variant="primary" busy={busy} disabled={!role || sameAssignment || missingSchool || candidate.suspended}
          onClick={() => void submit()}>{grant ? 'Save change' : 'Grant role'}</Button>}
      </>}
    </>}>
    {error && <Callout tone="danger" role="alert" actions={!candidate && <Button size="sm" onClick={() => { setError(''); setAttempt(value => value + 1); }}>Reload member</Button>}>{error}</Callout>}
    {!candidate && !error && <Hint role="status">Loading member...</Hint>}
    {candidate?.owner && <Callout>The owner already has access to every tool.</Callout>}
    {candidate && !candidate.owner && (revoking && grant
      ? <p className="text-sm">Remove {STAFF_LABELS[grant.role]}{pinnedName && ` at ${pinnedName}`} from {target.email}? Their next request will use regular member access.</p>
      : <>
        {grant && <p className="text-sm">Current role · <strong>{STAFF_LABELS[grant.role]}{pinnedName && ` at ${pinnedName}`}</strong></p>}
        {candidate.suspended && <Callout tone="warning">This account is suspended. Lift the suspension before assigning a role.</Callout>}
        <Field label="Staff role" htmlFor="grant-staff-role">
          <Select id="grant-staff-role" value={role} disabled={busy || candidate.suspended} onChange={event => { const value = event.target.value; if (isStaffRole(value)) setRole(value); }}>
            <option disabled value="">Choose a role</option>
            {STAFF_ROLES.map(key => <option key={key} value={key}>{STAFF_LABELS[key]}</option>)}
          </Select>
        </Field>
        {role === 'school-manager' && (missingSchool ? <Callout tone="warning">This member must join a school before they can become its manager.</Callout>
          : <Callout icon="school" title={candidate.schoolName || 'Assigned school'}>{grant?.role === 'school-manager' && grant.schoolId !== candidate.schoolId ? 'Saving moves their manager assignment to this school.' : 'School Manager access applies only here.'} The member must stay enrolled at this school to use the role.</Callout>)}
        {needsBeta && <Hint>{candidate.joinedBeta ? 'This member has joined the Staff roles beta.' : 'This member must join the Staff roles beta in Account before they can use this role.'}</Hint>}
      </>)}
  </Modal>;
}

export function AdminRoleGrants({ accountId, schools, onAccessLost }: { accountId: string; schools: School[]; onAccessLost: AccessLost }) {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [searching, setSearching] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  useEffect(() => {
    let active = true;
    api.admin.roles.list.query().then(rows => { if (active) setGrants(rows); }).catch(async err => {
      if (active && !await onAccessLost(err)) setError(errorMessage(err));
    });
    return () => { active = false; };
  }, [attempt, onAccessLost]);
  const reload = () => { setGrants(null); setError(''); setAttempt(value => value + 1); };
  return <Section id="staff-grants-title" title="Assigned roles" icon="users" action={<Button variant="primary" icon="userPlus" onClick={() => { setNotice(''); setSearching(true); }}>Assign a role</Button>}>
    {notice && <Callout role="status" tone="success">{notice}</Callout>}
    {error && <Callout tone="danger" role="alert" actions={<Button size="sm" onClick={reload}>Reload assignments</Button>}>{error}</Callout>}
    {!grants && !error && <Hint role="status">Loading assignments...</Hint>}
    {grants?.length === 0 && <Hint>No staff roles assigned.</Hint>}
    {grants && grants.length > 0 && <ul className="divide-y divide-border">{grants.map(row => <li key={row.userId} className="flex flex-wrap items-center justify-between gap-3 py-2">
      <div className="min-w-0"><strong className="break-words text-sm">{row.displayName || row.email}</strong><Hint className="break-all">{row.email}</Hint></div>
      <div className="flex flex-wrap items-center gap-2"><Chip>{STAFF_LABELS[row.role]}{row.schoolName && ` · ${row.schoolName}`}</Chip>
        {row.role === 'school-manager' && row.currentSchoolId !== row.schoolId && <Chip tone="warning">School changed</Chip>}
        <Button size="sm" aria-label={`Manage role for ${row.email}`} onClick={() => { setNotice(''); setTarget(row); }}>Manage</Button>
      </div>
    </li>)}</ul>}
    {searching && <MemberSearch onAccessLost={onAccessLost} onClose={() => setSearching(false)} onChoose={member => { setSearching(false); setTarget(member); }} />}
    {target && <GrantEditor key={target.userId} accountId={accountId} schools={schools} target={target} onAccessLost={onAccessLost} onClose={() => setTarget(null)}
      onSaved={message => { setTarget(null); setNotice(message); reload(); }} />}
  </Section>;
}
