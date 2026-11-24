import { STAFF_LABELS, isStaffRole, type StaffRole } from '@/domain/staff';
import type { Service } from './service';

/**
 * Granting and revoking staff roles (src/domain/staff.ts). Only `npm run staff` (scripts/staff.ts) calls this: no
 * tRPC procedure changes a role, so nobody can grant one from the app, the owner and administrators included.
 * Each change is written to the audit log under the owner's account, since the server operator acts for the owner.
 */

export type StaffMember = { userId: string; email: string; displayName: string; role: StaffRole; grantedAt: string; schoolId: string | null; schoolName: string | null };
type StoredGrant = { role: StaffRole; schoolId: string | null };

const now = () => new Date().toISOString();

/** Raised for a refusal the CLI prints as is. */
export class StaffError extends Error {}

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
  return service.db.prepare(`SELECT r.user_id userId, u.email, u.display_name displayName, r.role, r.granted_at grantedAt, r.school_id schoolId, s.name schoolName
    FROM staff_roles r JOIN users u ON u.id=r.user_id LEFT JOIN schools s ON s.id=r.school_id ORDER BY r.granted_at`).all() as StaffMember[];
}

/** Gives the account `role`, replacing any role it had. Returns the role it had before. */
export function grantStaffRole(service: Service, who: string, role: string): { member: StaffMember; previous: StaffRole | null } {
  if (!isStaffRole(role)) throw new StaffError(`Unknown role "${role}". Roles: ${Object.keys(STAFF_LABELS).filter(isStaffRole).join(', ')}.`);
  return service.db.transaction(() => {
    const ownerId = ownerAccount(service);
    const account = findAccount(service, who);
    if (service.isAdmin(account.id)) throw new StaffError('This is the owner account. The owner already has every permission.');
    if (account.suspended) throw new StaffError('This account is suspended. Lift the suspension in the support tools first.');
    const schoolId = role === 'school-manager' ? account.schoolId : null;
    if (role === 'school-manager' && !schoolId) throw new StaffError('This account must join a school before it can manage one.');
    const schoolName = schoolId ? account.schoolName : null;
    const grant = service.db.prepare('SELECT role, school_id schoolId FROM staff_roles WHERE user_id=?').get(account.id) as StoredGrant | undefined;
    const previous = grant?.role ?? null;
    if (grant?.role === role && grant.schoolId === schoolId) throw new StaffError(`${account.email} is already ${STAFF_LABELS[role].toLowerCase()}.`);
    const grantedAt = now();
    service.db.prepare(`INSERT INTO staff_roles(user_id,role,granted_at,school_id) VALUES(?,?,?,?) ON CONFLICT(user_id)
      DO UPDATE SET role=excluded.role, granted_at=excluded.granted_at, school_id=excluded.school_id`).run(account.id, role, grantedAt, schoolId);
    service.audit(ownerId, 'staff.grant', schoolId, { userId: account.id, role, from: previous, ...(grant?.schoolId && { previousSchoolId: grant.schoolId }), via: 'cli' });
    return { member: { userId: account.id, email: account.email, displayName: account.displayName, role, grantedAt, schoolId, schoolName }, previous };
  }).immediate();
}

/** Takes the account's role away. Its sessions stay signed in as a member; the support tools refuse it at once. */
export function revokeStaffRole(service: Service, who: string): { email: string; role: StaffRole } {
  return service.db.transaction(() => {
    const ownerId = ownerAccount(service);
    const account = findAccount(service, who);
    const row = service.db.prepare('SELECT role, school_id schoolId FROM staff_roles WHERE user_id=?').get(account.id) as StoredGrant | undefined;
    if (!row) throw new StaffError(`${account.email} has no staff role.`);
    service.db.prepare('DELETE FROM staff_roles WHERE user_id=?').run(account.id);
    service.audit(ownerId, 'staff.revoke', row.schoolId, { userId: account.id, role: row.role, via: 'cli' });
    return { email: account.email, role: row.role };
  }).immediate();
}
