import { STAFF_LABELS, isStaffRole, type StaffRole } from '@/domain/staff';
import { TRPCError } from '@trpc/server';
import { BetaService } from './betas';
import type { Service } from './service';

/**
 * The server operator and the beta's owner console share the same grant transaction.
 */

export type StaffMember = { userId: string; email: string; displayName: string; role: StaffRole; grantedAt: string; schoolId: string | null; schoolName: string | null; currentSchoolId: string | null };
type StoredGrant = { role: StaffRole; schoolId: string | null };
type ConsoleChange = { actorId: string; expectedGrant: StoredGrant | null; expectedSchoolId: string | null };

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

export function listStaff(service: Service): StaffMember[] {
  return service.db.prepare(`SELECT r.user_id userId, u.email, u.display_name displayName, r.role, r.granted_at grantedAt, r.school_id schoolId, s.name schoolName, u.school_id currentSchoolId
    FROM staff_roles r JOIN users u ON u.id=r.user_id LEFT JOIN schools s ON s.id=r.school_id ORDER BY r.granted_at`).all() as StaffMember[];
}

export function requireRoleConsole(service: Service, actorId: string): void {
  service.admin(actorId);
  if (!new BetaService(service).joined(actorId).some(beta => beta.key === 'staff-roles')) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Join the Staff roles beta to manage assignments here.' });
  }
}

function currentGrant(service: Service, userId: string): StoredGrant | null {
  return (service.db.prepare('SELECT role, school_id schoolId FROM staff_roles WHERE user_id=?').get(userId) as StoredGrant | undefined) ?? null;
}

export function staffCandidate(service: Service, userId: string) {
  const account = findAccount(service, userId);
  return { userId: account.id, schoolId: account.schoolId, schoolName: account.schoolName, suspended: account.suspended,
    owner: service.isAdmin(account.id), joinedBeta: new BetaService(service).joined(userId).some(beta => beta.key === 'staff-roles'), grant: currentGrant(service, userId) };
}

function checkExpected(change: ConsoleChange | undefined, schoolId: string | null, stored: StoredGrant | null): void {
  if (!change) return;
  if (schoolId !== change.expectedSchoolId || stored?.role !== change.expectedGrant?.role || stored?.schoolId !== change.expectedGrant?.schoolId) {
    throw new TRPCError({ code: 'CONFLICT', message: "This member's school or staff assignment changed. Refresh their details and try again." });
  }
}

/** Gives the account `role`, replacing any role it had. Returns the role it had before. */
export function grantStaffRole(service: Service, who: string, role: string, change?: ConsoleChange): { member: StaffMember; previous: StaffRole | null } {
  if (!isStaffRole(role)) throw new StaffError(`Unknown role "${role}". Roles: ${Object.keys(STAFF_LABELS).filter(isStaffRole).join(', ')}.`);
  return service.db.transaction(() => {
    if (change) requireRoleConsole(service, change.actorId);
    const ownerId = change?.actorId ?? ownerAccount(service);
    const account = findAccount(service, who);
    const grant = currentGrant(service, account.id);
    checkExpected(change, account.schoolId, grant);
    if (service.isAdmin(account.id)) throw new StaffError('This is the owner account. The owner already has every permission.');
    if (account.suspended) throw new StaffError('This account is suspended. Lift the suspension in the support tools first.');
    const schoolId = role === 'school-manager' ? account.schoolId : null;
    if (role === 'school-manager' && !schoolId) throw new StaffError('This account must join a school before it can manage one.');
    const schoolName = schoolId ? account.schoolName : null;
    const previous = grant?.role ?? null;
    if (grant?.role === role && grant.schoolId === schoolId) throw new StaffError(`${account.email} is already ${STAFF_LABELS[role].toLowerCase()}.`);
    const grantedAt = now();
    service.db.prepare(`INSERT INTO staff_roles(user_id,role,granted_at,school_id) VALUES(?,?,?,?) ON CONFLICT(user_id)
      DO UPDATE SET role=excluded.role, granted_at=excluded.granted_at, school_id=excluded.school_id`).run(account.id, role, grantedAt, schoolId);
    service.audit(ownerId, 'staff.grant', schoolId, { userId: account.id, role, from: previous, ...(grant?.schoolId && { previousSchoolId: grant.schoolId }), via: change ? 'console' : 'cli' });
    return { member: { userId: account.id, email: account.email, displayName: account.displayName, role, grantedAt, schoolId, schoolName, currentSchoolId: account.schoolId }, previous };
  }).immediate();
}

/** Takes the account's role away. Its sessions stay signed in as a member; the support tools refuse it at once. */
export function revokeStaffRole(service: Service, who: string, change?: ConsoleChange): { email: string; role: StaffRole } {
  return service.db.transaction(() => {
    if (change) requireRoleConsole(service, change.actorId);
    const ownerId = change?.actorId ?? ownerAccount(service);
    const account = findAccount(service, who);
    const row = currentGrant(service, account.id);
    checkExpected(change, account.schoolId, row);
    if (!row) throw new StaffError(`${account.email} has no staff role.`);
    service.db.prepare('DELETE FROM staff_roles WHERE user_id=?').run(account.id);
    service.audit(ownerId, 'staff.revoke', row.schoolId, { userId: account.id, role: row.role, via: change ? 'console' : 'cli' });
    return { email: account.email, role: row.role };
  }).immediate();
}
