import { useEffect, useState } from 'react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import { browserTimeZone, formatDate, formatTime, instantParts } from '@/lib/format';
import { ROLE_PERMISSIONS, STAFF_LABELS, type StaffAccess, type StaffPermission, type StaffRank } from '@/domain/staff';
import { Icon, type IconName } from './icon';
import { Button, Callout, Hint, Panel, Section } from './primitives';

const featured = ['school-manager', 'chat-moderation', 'support'] as const;
const icons: Record<StaffRank, IconName> = {
  owner: 'crown', 'school-manager': 'school', 'chat-moderation': 'message', support: 'inbox',
  administrator: 'settings', moderator: 'flag', 'schedule-editor': 'calendar',
};

const actions: Record<StaffPermission, string> = {
  requests: 'Answer corrections and beta feedback',
  verification: 'Approve enrollment proof and change verification',
  proposals: 'Review schedule proposals and logo votes',
  'schools.edit': 'Edit schedules, school details, guides, class directories and lunch menus',
  reports: 'Review member reports and hide reported messages',
  'chat.pause': 'Pause or restore messaging and decide pause appeals',
  'global.moderate': 'Edit or remove Global chat posts',
  'members.search': 'Find members by name, email or account ID',
  'members.view': 'Open a member record with a reason for the audit log',
  'members.sessions': 'Sign members out and reset their reminder browsers',
  'members.remove': 'Remove members from a school and decide removal appeals',
  'members.suspend': 'Suspend or restore accounts',
};

function RoleCard({ role, permissions, schoolName }: { role: StaffRank; permissions: readonly StaffPermission[]; schoolName?: string | null }) {
  const scope = role === 'school-manager' ? schoolName || 'One school' : 'Across Quasar';
  const roleActions: Partial<Record<StaffPermission, string>> = role === 'school-manager' ? {
    reports: 'Review school member reports and moderate the school chat room',
    requests: 'Answer school correction requests',
    'members.remove': 'Remove members, lift removals and decide removal appeals',
  } : role === 'chat-moderation' ? {
    reports: 'Review chat reports, open their evidence and hide reported messages',
    'global.moderate': 'Edit or remove posts in Global and your school chat',
  } : {};
  return <Panel className="grid content-start gap-4 p-4">
    <div className="flex items-center gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-soft-foreground"><Icon name={icons[role]} size={19} /></span>
      <div className="min-w-0"><h3 className="text-base font-bold">{STAFF_LABELS[role]}</h3><Hint className="break-words">{scope}</Hint></div>
    </div>
    <ul className="grid gap-2 text-sm leading-snug">
      {permissions.map(permission => <li key={permission} className="flex items-start gap-2"><Icon name="check" size={14} className="mt-0.5 text-muted-foreground" />{roleActions[permission] ?? actions[permission]}</li>)}
      {role === 'school-manager' && <li className="flex items-start gap-2"><Icon name="check" size={14} className="mt-0.5 text-muted-foreground" />Read the school activity log</li>}
    </ul>
  </Panel>;
}

export function AdminRoles({ access }: { access: StaffAccess }) {
  if (access.role !== 'owner') return <Section id="staff-access-title" title="Your access" icon="lock">
    <RoleCard role={access.role} schoolName={access.schoolName} permissions={access.permissions} />
  </Section>;
  return <Section id="staff-access-title" title="Staff roles" icon="users" description="Each account can hold one staff role.">
    <div className="grid items-stretch gap-3 md:grid-cols-3">{featured.map(role => <RoleCard key={role} role={role} permissions={ROLE_PERMISSIONS[role]} />)}</div>
    <details className="rounded-xl border border-border p-3">
      <summary className="cursor-pointer text-sm font-semibold">Administrator, Moderator and Schedule editor</summary>
      <div className="mt-3 grid gap-3 md:grid-cols-3">{(['administrator', 'moderator', 'schedule-editor'] as const).map(role => <RoleCard key={role} role={role} permissions={ROLE_PERMISSIONS[role]} />)}</div>
    </details>
    <Hint>Grant or revoke roles with the staff command on the server. A School Manager grant records the school their account belongs to at the time.</Hint>
  </Section>;
}

export function SchoolActivity({ onAccessLost }: { onAccessLost: (error: unknown) => Promise<boolean> }) {
  const [rows, setRows] = useState<RouterOutput['admin']['schoolActivity'] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    api.admin.schoolActivity.query().then(result => { if (active) setRows(result); }).catch(async err => {
      if (!active) return;
      const handled = await onAccessLost(err);
      if (active && !handled) setError(errorMessage(err));
    });
    return () => { active = false; };
  }, [attempt, onAccessLost]);
  return <Section id="school-activity-title" title="School activity" icon="clock" description="Recent changes at your school, newest first.">
    {error && <Callout tone="danger" role="alert" actions={<Button size="sm" onClick={() => { setError(''); setAttempt(value => value + 1); }}>Retry</Button>}>{error}</Callout>}
    {!rows && !error && <Hint role="status">Loading activity...</Hint>}
    {rows?.length === 0 && <Hint>No school activity yet.</Hint>}
    {rows && rows.length > 0 && <ol className="divide-y divide-border">{rows.map(row => {
      const { date, time } = instantParts(row.createdAt, browserTimeZone());
      return <li key={row.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-3">
        <div><strong className="text-sm">{row.action}</strong><Hint>{row.schoolName}</Hint></div>
        <time className="text-xs text-muted-foreground" dateTime={row.createdAt}>{formatDate(date, { year: true })} · {formatTime(time)}</time>
      </li>;
    })}</ol>}
  </Section>;
}
