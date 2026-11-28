import { SCHOOL_DELEGABLE_ROLES, STAFF_LABELS, isStaffRole, type StaffRole } from '@/domain/staff';
import { decodeStoredRole, encodeStoredRole } from '@/domain/stored-staff';
import { TRPCError } from '@trpc/server';
import type { Service } from './service';

/**
 * The server operator, owner and school managers share the same assignment transaction.
 */

export type StaffMember = { userId: string; email: string; displayName: string; role: StaffRole; grantedAt: string; schoolId: string | null; schoolName: string | null; currentSchoolId: string | null };
type StoredGrant = { role: StaffRole; schoolId: string | null };
type AssignmentScope = 'school' | 'global';
type ConsoleChange = { actorId: string; expectedGrant: StoredGrant | null; expectedSchoolId: string | null; scope?: AssignmentScope };

const now = () => new Date().toISOString();

/** Raised for a refusal the CLI prints as is. */
export class StaffError extends TRPCError {
  constructor(message: string) { super({ code: 'BAD_REQUEST', message }); }
}

/** The account `who` names: an exact account ID, or a Google email (which must name exactly one account). */
export function findAccount(service: Service, who: string): { id: string; email: string; displayName: string; suspended: boolean; schoolId: string | null; schoolName: string | null } {
  const query = who.trim();
  const rows = service.db.prepare(`SELECT u.id, u.email, u.display_name displayName, u.suspended_at IS NOT NULL suspended, u.school_id schoolId, s.name schoolName
    FROM users u LEFT JOIN schools s ON s.id=u.school_id WHERE u.id=? OR lower(u.email)=lower(?) ORDER BY u.created_at`)
    .all(query, query) as { id: string; email: string; displayName: string; suspended: number; schoolId: string | null; schoolName: string | null }[];
  if (rows.length === 0) throw new StaffError(`No account matches "${query}". They need to sign in to Quasar once first.`);
  if (rows.length > 1) throw new StaffError(`More than one account uses ${query}. Pass the account ID instead:\n${rows.map(row => `  ${row.id}  ${row.displayName || '(no name)'}`).join('\n')}`);
  return { ...rows[0]!, suspended: !!rows[0]!.suspended };
}

/** The owner's account, which the audit rows for role changes are written under. */
function ownerAccount(service: Service): string {
  const rows = service.db.prepare('SELECT id FROM users WHERE lower(email)=lower(?)').all(service.ownerEmail.trim()) as { id: string }[];
  const owner = rows.find(row => service.isAdmin(row.id));
  if (!owner) throw new StaffError('The owner account (OWNER_EMAIL) has not signed in yet, so role changes have no account to be logged under. Sign in to Quasar as the owner first.');
  return owner.id;
}

const delegable = (role: StaffRole) => SCHOOL_DELEGABLE_ROLES.some(candidate => candidate === role);

export function listStaff(service: Service, actorId?: string): StaffMember[] {
  const scope = actorId ? requireRoleConsole(service, actorId) : null;
  const rows = service.db.prepare(`SELECT r.user_id userId, u.email, u.display_name displayName, r.role, r.granted_at grantedAt, r.school_id schoolId, s.name schoolName, u.school_id currentSchoolId
    FROM staff_roles r JOIN users u ON u.id=r.user_id LEFT JOIN schools s ON s.id=r.school_id
    WHERE (? IS NULL OR (r.school_id=? AND u.school_id=? AND r.role IN ('school-chat-moderation','school-support'))) ORDER BY r.granted_at`).all(scope, scope, scope) as StaffMember[];
  return rows.map(row => ({ ...row, role: readRole(row.role) }));
}

export function requireRoleConsole(service: Service, actorId: string): string | null {
  const access = service.staffAccess(actorId);
  if (access?.role !== 'owner' && !(access?.role === 'school-manager' && access.schoolId)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the owner or a School Manager can manage staff assignments.' });
  }
  return access.schoolId ?? null;
}

function readRole(key: string): StaffRole {
  const role = decodeStoredRole(key);
  if (!role) throw new StaffError('This assignment uses a role this version of Quasar cannot manage.');
  return role;
}

function currentGrant(service: Service, userId: string): StoredGrant | null {
  const grant = service.db.prepare('SELECT role, school_id schoolId FROM staff_roles WHERE user_id=?').get(userId) as StoredGrant | undefined;
  return grant ? { ...grant, role: readRole(grant.role) } : null;
}

function checkDelegateTarget(service: Service, actorId: string, scope: string | null, account: ReturnType<typeof findAccount>, grant: StoredGrant | null) {
  if (scope && (account.schoolId !== scope || account.id === actorId || service.isAdmin(account.id) || (grant && (!delegable(grant.role) || grant.schoolId !== scope)))) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You can manage school Chat Moderation and Support assignments for eligible members of your own school.' });
  }
}

export function searchStaffCandidates(service: Service, actorId: string, query: string) {
  const scope = requireRoleConsole(service, actorId);
  if (!query.trim()) return [];
  const rows = service.db.prepare(`SELECT u.id, u.email, u.display_name displayName, u.school_id schoolId, s.name schoolName
    FROM users u LEFT JOIN schools s ON s.id=u.school_id LEFT JOIN staff_roles r ON r.user_id=u.id
    WHERE (instr(lower(u.email),lower(@query)) OR instr(lower(u.display_name),lower(@query)) OR instr(lower(u.full_name),lower(@query)) OR u.id=@query)
      AND (@scope IS NULL OR (u.school_id=@scope AND u.id<>@actorId AND (r.role IS NULL OR (r.role IN ('school-chat-moderation','school-support') AND r.school_id=@scope))))
    ORDER BY u.display_name,u.email,u.id LIMIT 30`).all({ scope, actorId, query: query.trim() }) as {
      id: string; email: string; displayName: string; schoolId: string | null; schoolName: string | null
    }[];
  return scope ? rows.filter(row => !service.isAdmin(row.id)) : rows;
}

function blockedRoles(service: Service, userId: string): StaffRole[] {
  return service.db.prepare('SELECT role FROM staff_role_blacklist WHERE user_id=? ORDER BY role').pluck().all(userId) as StaffRole[];
}

export function staffCandidate(service: Service, actorId: string, userId: string) {
  const scope = requireRoleConsole(service, actorId);
  const account = findAccount(service, userId);
  const grant = currentGrant(service, userId);
  checkDelegateTarget(service, actorId, scope, account, grant);
  const blocked = blockedRoles(service, userId);
  return { userId: account.id, schoolId: account.schoolId, schoolName: account.schoolName, suspended: account.suspended,
    owner: service.isAdmin(account.id), grant,
    blockedRoles: scope ? blocked.filter(delegable) : blocked };
}

function checkExpected(change: ConsoleChange | undefined, schoolId: string | null, stored: StoredGrant | null): void {
  if (!change) return;
  if (schoolId !== change.expectedSchoolId || stored?.role !== change.expectedGrant?.role || stored?.schoolId !== change.expectedGrant?.schoolId) {
    throw new TRPCError({ code: 'CONFLICT', message: "This member's school or staff assignment changed. Refresh their details and try again." });
  }
}

/** Gives the account `role`, replacing any role it had. Returns the role it had before. */
export function grantStaffRole(service: Service, who: string, role: string, change?: ConsoleChange, cliScope?: AssignmentScope): { member: StaffMember; previous: StaffRole | null } {
  if (!isStaffRole(role)) throw new StaffError(`Unknown role "${role}". Roles: ${Object.keys(STAFF_LABELS).filter(isStaffRole).join(', ')}.`);
  return service.db.transaction(() => {
    const managerSchool = change ? requireRoleConsole(service, change.actorId) : null;
    const actorId = change?.actorId ?? ownerAccount(service);
    const account = findAccount(service, who);
    const grant = currentGrant(service, account.id);
    checkDelegateTarget(service, actorId, managerSchool, account, grant);
    const scope = change?.scope ?? cliScope ?? (managerSchool || role === 'school-manager' ? 'school' : 'global');
    if (managerSchool && (scope !== 'school' || !delegable(role))) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'School Managers can assign Chat Moderation or Support in their own school.' });
    }
    checkExpected(change, account.schoolId, grant);
    if (service.isAdmin(account.id)) throw new StaffError('This is the owner account. The owner already has every permission.');
    if (account.suspended) throw new StaffError('This account is suspended. Lift the suspension in the support tools first.');
    if (blockedRoles(service, account.id).includes(role)) throw new TRPCError({ code: 'FORBIDDEN', message: 'The owner blocked this role for this account.' });
    if (scope === 'global' && role === 'school-manager') throw new StaffError('School Manager requires a school assignment.');
    if (scope === 'school' && role !== 'school-manager' && !delegable(role)) throw new StaffError('This role only supports a global assignment.');
    const schoolId = scope === 'school' ? account.schoolId : null;
    if (scope === 'school' && !schoolId) throw new StaffError('This account must join a school before receiving a school role.');
    const schoolName = schoolId ? account.schoolName : null;
    const previous = grant?.role ?? null;
    if (grant?.role === role && grant.schoolId === schoolId) throw new StaffError(`${account.email} is already ${STAFF_LABELS[role].toLowerCase()}.`);
    const grantedAt = now();
    service.db.prepare(`INSERT INTO staff_roles(user_id,role,granted_at,school_id) VALUES(?,?,?,?) ON CONFLICT(user_id)
      DO UPDATE SET role=excluded.role, granted_at=excluded.granted_at, school_id=excluded.school_id`).run(account.id, encodeStoredRole(role, schoolId), grantedAt, schoolId);
    service.audit(actorId, 'staff.grant', schoolId, { userId: account.id, role, from: previous, ...(grant?.schoolId && { previousSchoolId: grant.schoolId }), via: change ? 'console' : 'cli' });
    return { member: { userId: account.id, email: account.email, displayName: account.displayName, role, grantedAt, schoolId, schoolName, currentSchoolId: account.schoolId }, previous };
  }).immediate();
}

/** Takes the account's role away. Its sessions stay signed in as a member; the support tools refuse it at once. */
export function revokeStaffRole(service: Service, who: string, change?: ConsoleChange): { email: string; role: StaffRole } {
  return service.db.transaction(() => {
    const managerSchool = change ? requireRoleConsole(service, change.actorId) : null;
    const actorId = change?.actorId ?? ownerAccount(service);
    const account = findAccount(service, who);
    const row = currentGrant(service, account.id);
    checkDelegateTarget(service, actorId, managerSchool, account, row);
    checkExpected(change, account.schoolId, row);
    if (!row) throw new StaffError(`${account.email} has no staff role.`);
    service.db.prepare('DELETE FROM staff_roles WHERE user_id=?').run(account.id);
    service.audit(actorId, 'staff.revoke', row.schoolId, { userId: account.id, role: row.role, via: change ? 'console' : 'cli' });
    return { email: account.email, role: row.role };
  }).immediate();
}

/** Blocking a role takes effect everywhere, including against concurrent CLI grants. Unblocking only permits a future grant. */
export function setStaffRoleBlocked(service: Service, actorId: string, userId: string, role: StaffRole, blocked: boolean): void {
  service.db.transaction(() => {
    service.admin(actorId);
    requireRoleConsole(service, actorId);
    findAccount(service, userId);
    if (service.isAdmin(userId)) throw new StaffError('The owner account cannot have role restrictions.');
    if (blocked) {
      const inserted = service.db.prepare('INSERT OR IGNORE INTO staff_role_blacklist(user_id,role,created_at) VALUES(?,?,?)').run(userId, role, now());
      const grant = currentGrant(service, userId);
      if (grant?.role === role) {
        service.db.prepare('DELETE FROM staff_roles WHERE user_id=?').run(userId);
        service.audit(actorId, 'staff.revoke', grant.schoolId, { userId, role, via: 'blacklist' });
      }
      if (inserted.changes) service.audit(actorId, 'staff.block', null, { userId, role });
    } else {
      const removed = service.db.prepare('DELETE FROM staff_role_blacklist WHERE user_id=? AND role=?').run(userId, role);
      if (removed.changes) service.audit(actorId, 'staff.unblock', null, { userId, role });
    }
  }).immediate();
}
