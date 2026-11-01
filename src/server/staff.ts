import { STAFF_LABELS, isStaffRole, type StaffRole } from '@/domain/staff';
import type { Service } from './service';

/**
 * Granting and revoking staff roles (src/domain/staff.ts). Only `npm run staff` (scripts/staff.ts) calls this: no
 * tRPC procedure changes a role, so nobody can grant one from the app, the owner and administrators included.
 * Each change is written to the audit log under the owner's account, since the server operator acts for the owner.
 */

export type StaffMember = { userId: string; email: string; displayName: string; role: StaffRole; grantedAt: string };

const now = () => new Date().toISOString();

/** Raised for a refusal the CLI prints as is. */
export class StaffError extends Error {}

/** The account `who` names: an exact account ID, or a Google email (which must name exactly one account). */
export function findAccount(service: Service, who: string): { id: string; email: string; displayName: string; suspended: boolean } {
  const query = who.trim();
  const rows = service.db.prepare('SELECT id, email, display_name displayName, suspended_at IS NOT NULL suspended FROM users WHERE id=? OR lower(email)=lower(?) ORDER BY created_at')
    .all(query, query) as { id: string; email: string; displayName: string; suspended: number }[];
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
  return service.db.prepare(`SELECT r.user_id userId, u.email, u.display_name displayName, r.role, r.granted_at grantedAt
    FROM staff_roles r JOIN users u ON u.id=r.user_id ORDER BY r.granted_at`).all() as StaffMember[];
}

/** Gives the account `role`, replacing any role it had. Returns the role it had before. */
export function grantStaffRole(service: Service, who: string, role: string): { member: StaffMember; previous: StaffRole | null } {
  if (!isStaffRole(role)) throw new StaffError(`Unknown role "${role}". Roles: ${Object.keys(STAFF_LABELS).filter(isStaffRole).join(', ')}.`);
  return service.db.transaction(() => {
    const ownerId = ownerAccount(service);
    const account = findAccount(service, who);
    if (service.isAdmin(account.id)) throw new StaffError('This is the owner account. The owner already has every permission.');
    if (account.suspended) throw new StaffError('This account is suspended. Lift the suspension in the support tools first.');
    const previous = (service.db.prepare('SELECT role FROM staff_roles WHERE user_id=?').get(account.id) as { role: StaffRole } | undefined)?.role ?? null;
    if (previous === role) throw new StaffError(`${account.email} is already ${STAFF_LABELS[role].toLowerCase()}.`);
    const grantedAt = now();
    service.db.prepare('INSERT INTO staff_roles(user_id,role,granted_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET role=excluded.role, granted_at=excluded.granted_at')
      .run(account.id, role, grantedAt);
    service.audit(ownerId, 'staff.grant', null, { userId: account.id, role, from: previous, via: 'cli' });
    return { member: { userId: account.id, email: account.email, displayName: account.displayName, role, grantedAt }, previous };
  }).immediate();
}

/** Takes the account's role away. Its sessions stay signed in as a member; the support tools refuse it at once. */
export function revokeStaffRole(service: Service, who: string): { email: string; role: StaffRole } {
  return service.db.transaction(() => {
    const ownerId = ownerAccount(service);
    const account = findAccount(service, who);
    const row = service.db.prepare('SELECT role FROM staff_roles WHERE user_id=?').get(account.id) as { role: StaffRole } | undefined;
    if (!row) throw new StaffError(`${account.email} has no staff role.`);
    service.db.prepare('DELETE FROM staff_roles WHERE user_id=?').run(account.id);
    service.audit(ownerId, 'staff.revoke', null, { userId: account.id, role: row.role, via: 'cli' });
    return { email: account.email, role: row.role };
  }).immediate();
}
