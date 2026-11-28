import { useEffect, useState } from 'react';
import { api, errorMessage, type RouterOutput, type School } from '@/client/api';
import { SCHOOL_DELEGABLE_ROLES, STAFF_LABELS, STAFF_ROLES, isStaffRole, type StaffRole } from '@/domain/staff';
import { Button, Callout, Chip, Field, Hint, Input, Modal, Section, Select, Spacer } from './primitives';

type Candidate = RouterOutput['admin']['roles']['candidate'];
type Grant = RouterOutput['admin']['roles']['list'][number];
type Target = Pick<Grant, 'userId' | 'email' | 'displayName'>;
type EditorMode = 'assign' | 'blocks';
type GrantScope = 'global' | 'school';
type AccessLost = (err: unknown) => Promise<boolean>;

function MemberSearch({ mode, onChoose, onClose, onAccessLost }: { mode: EditorMode; onChoose: (target: Target) => void; onClose: () => void; onAccessLost: AccessLost }) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<RouterOutput['admin']['roles']['search'] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!query.trim()) return;
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const result = await api.admin.roles.search.query({ query: query.trim() });
        if (active) setRows(result);
      } catch (err) {
        if (active) { setError(errorMessage(err)); await onAccessLost(err); }
      }
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [query, attempt, onAccessLost]);
  return <Modal open onClose={onClose} title={mode === 'assign' ? 'Assign a staff role' : 'Manage role blocks'} description={mode === 'assign' ? 'Find the member who should receive the role.' : 'Find a member to change which roles they can receive.'}>
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

function GrantEditor({ target, accountId, schools, managerSchool, mode, onClose, onSaved, onAccessLost }: {
  managerSchool?: string; mode: EditorMode;
  target: Target; accountId: string; schools: School[]; onClose: () => void; onSaved: (notice: string) => void; onAccessLost: AccessLost;
}) {
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [role, setRole] = useState<StaffRole | ''>('');
  const [scopeChoice, setScopeChoice] = useState<GrantScope>('school');
  const [confirmBlock, setConfirmBlock] = useState<StaffRole | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    api.admin.roles.candidate.query({ userId: target.userId }).then(next => {
      if (active) {
        setCandidate(next); setRole(next.grant?.role ?? '');
        setScopeChoice(next.grant ? (next.grant.schoolId ? 'school' : 'global') : next.schoolId ? 'school' : 'global');
      }
    }).catch(async err => {
      if (active) { setError(errorMessage(err)); await onAccessLost(err); }
    });
    return () => { active = false; };
  }, [attempt, onAccessLost, target.userId]);
  const grant = candidate?.grant;
  const flexibleScope = role === 'support' || role === 'chat-moderation';
  const scope = managerSchool || role === 'school-manager' ? 'school' : flexibleScope ? scopeChoice : 'global';
  const missingSchool = scope === 'school' && !candidate?.schoolId;
  const blockedRole = !!role && !!candidate?.blockedRoles.includes(role);
  const availableRoles = managerSchool ? SCHOOL_DELEGABLE_ROLES : STAFF_ROLES;
  const pinnedName = grant?.schoolId && (schools.find(school => school.id === grant.schoolId)?.name ?? grant.schoolId);
  const sameAssignment = grant?.role === role && grant.schoolId === (scope === 'school' ? candidate?.schoolId : null);
  const setBlock = async (blockedRole: StaffRole, blocked: boolean) => {
    if (!candidate || candidate.owner || busy || managerSchool) return;
    setBusy(true); setError('');
    try {
      await api.admin.roles.setBlocked.mutate({ accountId, userId: target.userId, role: blockedRole, blocked });
      onSaved(`${blocked ? 'Blocked' : 'Unblocked'} ${STAFF_LABELS[blockedRole]} for ${target.email}.`);
    } catch (err) {
      setError(errorMessage(err)); setCandidate(null); setConfirmBlock(null); setAttempt(value => value + 1);
      await onAccessLost(err);
    } finally { setBusy(false); }
  };
  const submit = async () => {
    if (!candidate || busy || candidate.owner) return;
    const params = { accountId, userId: target.userId, expectedSchoolId: candidate.schoolId, expectedGrant: candidate.grant };
    setBusy(true); setError('');
    try {
      if (revoking && candidate.grant) {
        await api.admin.roles.revoke.mutate({ ...params, expectedGrant: candidate.grant });
        onSaved(`Revoked ${STAFF_LABELS[candidate.grant.role]} for ${target.email}.`);
      } else if (role && !blockedRole && !missingSchool && !sameAssignment && !candidate.suspended) {
        await api.admin.roles.grant.mutate({ ...params, role, scope });
        onSaved(`Assigned ${STAFF_LABELS[role]}${scope === 'school' ? ` at ${candidate.schoolName}` : ' across Quasar'} to ${target.email}.`);
      }
    } catch (err) {
      setError(errorMessage(err));
      setCandidate(null); setRole(''); setRevoking(false); setAttempt(value => value + 1);
      await onAccessLost(err);
    } finally { setBusy(false); }
  };
  return <Modal open onClose={onClose} busy={busy} title={mode === 'blocks' ? 'Manage role blocks' : revoking ? 'Revoke staff role?' : grant ? 'Manage staff role' : 'Assign a staff role'}
    description={<>{target.displayName && <strong>{target.displayName} · </strong>}{target.email}</>}
    footer={<>
      <Button variant="ghost" disabled={busy} onClick={revoking ? () => setRevoking(false) : onClose}>{mode === 'blocks' ? 'Done' : 'Cancel'}</Button><Spacer />
      {mode === 'assign' && (revoking ? <Button variant="danger" busy={busy} onClick={() => void submit()}>Confirm revocation</Button> : <>
        {grant && !candidate?.owner && <Button variant="danger" disabled={busy} onClick={() => setRevoking(true)}>Revoke role</Button>}
        {candidate && !candidate.owner && <Button variant="primary" busy={busy} disabled={!role || sameAssignment || missingSchool || blockedRole || candidate.suspended}
          onClick={() => void submit()}>{grant ? 'Save change' : 'Grant role'}</Button>}
      </>)}
    </>}>
    {error && <Callout tone="danger" role="alert" actions={!candidate && <Button size="sm" onClick={() => { setError(''); setAttempt(value => value + 1); }}>Reload member</Button>}>{error}</Callout>}
    {!candidate && !error && <Hint role="status">Loading member...</Hint>}
    {candidate?.owner && <Callout>The owner already has access to every tool.</Callout>}
    {candidate && !candidate.owner && mode === 'blocks' && !managerSchool && <>
      <Hint>Blocked roles cannot be assigned at any school or across Quasar. Unblocking a role allows future grants.</Hint>
      <ul className="divide-y divide-border">{STAFF_ROLES.map(key => {
        const blocked = candidate.blockedRoles.includes(key);
        return <li key={key} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span className="text-sm font-semibold">{STAFF_LABELS[key]}</span>
          <div className="flex items-center gap-2">{blocked && <Chip tone="warning">Blocked</Chip>}
            <Button size="sm" aria-label={`${blocked ? 'Unblock' : 'Block'} ${STAFF_LABELS[key]}`} disabled={busy}
              onClick={() => { if (blocked) void setBlock(key, false); else setConfirmBlock(key); }}>{blocked ? 'Unblock' : 'Block'}</Button>
          </div>
        </li>;
      })}</ul>
      {confirmBlock && <Callout tone="warning" title={`Block ${STAFF_LABELS[confirmBlock]}?`} actions={<>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmBlock(null)}>Cancel</Button>
        <Button size="sm" variant="danger" busy={busy} onClick={() => void setBlock(confirmBlock, true)}>Confirm block</Button>
      </>}>{candidate.grant?.role === confirmBlock ? 'Blocking this role also revokes their current assignment.' : 'This prevents future grants of the role and revokes any matching assignment.'}</Callout>}
    </>}
    {candidate && !candidate.owner && mode === 'assign' && (revoking && grant
      ? <p className="text-sm">Remove {STAFF_LABELS[grant.role]}{pinnedName && ` at ${pinnedName}`} from {target.email}? Their next request will use regular member access.</p>
      : <>
        {grant && <p className="text-sm">Current role · <strong>{STAFF_LABELS[grant.role]}{pinnedName && ` at ${pinnedName}`}</strong></p>}
        {candidate.suspended && <Callout tone="warning">This account is suspended. Lift the suspension before assigning a role.</Callout>}
        <Field label="Staff role" htmlFor="grant-staff-role">
          <Select id="grant-staff-role" value={role} disabled={busy || candidate.suspended} onChange={event => { const value = event.target.value; if (isStaffRole(value)) setRole(value); }}>
            <option disabled value="">Choose a role</option>
            {availableRoles.map(key => <option key={key} value={key} disabled={candidate.blockedRoles.includes(key)}>{STAFF_LABELS[key]}{candidate.blockedRoles.includes(key) ? ' (blocked)' : ''}</option>)}
          </Select>
        </Field>
        {flexibleScope && !managerSchool && <Field label="Role scope" htmlFor="grant-role-scope">
          <Select id="grant-role-scope" value={scopeChoice} disabled={busy || candidate.suspended} onChange={event => setScopeChoice(event.target.value === 'school' ? 'school' : 'global')}>
            <option value="school" disabled={!candidate.schoolId}>{candidate.schoolName || 'Current school (no school joined)'}</option>
            <option value="global">Across Quasar</option>
          </Select>
        </Field>}
        {role && scope === 'school' && (missingSchool ? <Callout tone="warning">This member must join a school before they can receive a school role.</Callout>
          : <Callout icon="school" title={candidate.schoolName || managerSchool || 'Assigned school'}>
            {role === 'support' ? 'Handle school corrections, search the roster and verify students.' : role === 'chat-moderation' ? 'Edit or remove messages and review message changes in this school’s chat room.' : 'Manage this school and assign school Support or Chat Moderation to its members.'} This access applies while the member belongs to this school.
          </Callout>)}
        {role && scope === 'global' && flexibleScope && <Hint>{role === 'support' ? 'Answer support requests across schools, verify members, open account records and reset sessions.' : 'Review chat reports across Quasar, moderate Global chat and handle messaging pauses and appeals.'}</Hint>}
      </>)}
  </Modal>;
}

export function AdminRoleGrants({ accountId, schools, managerSchool, onAccessLost }: { accountId: string; schools: School[]; managerSchool?: string; onAccessLost: AccessLost }) {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<EditorMode>('assign');
  const [searching, setSearching] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  useEffect(() => {
    let active = true;
    api.admin.roles.list.query().then(rows => { if (active) setGrants(rows); }).catch(async err => {
      if (active) { setError(errorMessage(err)); await onAccessLost(err); }
    });
    return () => { active = false; };
  }, [attempt, onAccessLost]);
  const reload = () => { setGrants(null); setError(''); setAttempt(value => value + 1); };
  const search = (next: EditorMode) => { setNotice(''); setMode(next); setSearching(true); };
  return <Section id="staff-grants-title" title="Assigned roles" icon="users" description={managerSchool ? `Assign Support or Chat Moderation to members of ${managerSchool}.` : undefined} action={<>
    {!managerSchool && <Button onClick={() => search('blocks')}>Manage role blocks</Button>}
    <Button variant="primary" icon="userPlus" onClick={() => search('assign')}>Assign a role</Button>
  </>}>
    {notice && <Callout role="status" tone="success">{notice}</Callout>}
    {error && <Callout tone="danger" role="alert" actions={<Button size="sm" onClick={reload}>Reload assignments</Button>}>{error}</Callout>}
    {!grants && !error && <Hint role="status">Loading assignments...</Hint>}
    {grants?.length === 0 && <Hint>No staff roles assigned.</Hint>}
    {grants && grants.length > 0 && <ul className="divide-y divide-border">{grants.map(row => <li key={row.userId} className="flex flex-wrap items-center justify-between gap-3 py-2">
      <div className="min-w-0"><strong className="break-words text-sm">{row.displayName || row.email}</strong><Hint className="break-all">{row.email}</Hint></div>
      <div className="flex flex-wrap items-center gap-2"><Chip>{STAFF_LABELS[row.role]} · {row.schoolName || 'Across Quasar'}</Chip>
        {row.schoolId && row.currentSchoolId !== row.schoolId && <Chip tone="warning">School changed</Chip>}
        <Button size="sm" aria-label={`Manage role for ${row.email}`} onClick={() => { setNotice(''); setMode('assign'); setTarget(row); }}>Manage</Button>
      </div>
    </li>)}</ul>}
    {searching && <MemberSearch mode={mode} onAccessLost={onAccessLost} onClose={() => setSearching(false)} onChoose={member => { setSearching(false); setTarget(member); }} />}
    {target && <GrantEditor key={target.userId} managerSchool={managerSchool} mode={mode} accountId={accountId} schools={schools} target={target} onAccessLost={onAccessLost} onClose={() => setTarget(null)}
      onSaved={message => { setTarget(null); setNotice(message); reload(); }} />}
  </Section>;
}
