import { existsSync } from 'node:fs';
import { STAFF_LABELS, STAFF_ROLES, ROLE_PERMISSIONS } from '../src/domain/staff';
import { openDatabase } from '../src/server/db';
import { Service } from '../src/server/service';
import { StaffError, grantStaffRole, listStaff, revokeStaffRole } from '../src/server/staff';

/**
 * Grants and revokes staff roles (README "Staff roles"). This is the only way to change a role: the app has no
 * procedure for it, so nobody can grant one from /admin. For the live site, run it in the production checkout; a
 * change takes effect at the account's next request, without a deploy or restart.
 *
 *   npm run staff -- list
 *   npm run staff -- grant <email or account ID> <role>
 *   npm run staff -- revoke <email or account ID>
 *   npm run staff -- roles
 */

// Same configuration as the app and the worker, so DATABASE_PATH and OWNER_EMAIL match the server's.
if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const USAGE = `Usage:
  npm run staff -- list
  npm run staff -- grant <email or account ID> <role>
  npm run staff -- revoke <email or account ID>
  npm run staff -- roles

Roles: ${STAFF_ROLES.join(', ')}. The account must have signed in to Quasar once.`;

function main(): void {
  const [command, who, role] = process.argv.slice(2).filter(arg => arg !== '--');
  if (!command || command === '--help' || command === '-h') { console.log(USAGE); return; }
  if (command === 'roles') {
    for (const key of STAFF_ROLES) console.log(`${key} (${STAFF_LABELS[key]}): ${ROLE_PERMISSIONS[key].join(', ')}`);
    return;
  }
  const db = openDatabase();
  try {
    const service = new Service(db);
    if (!service.ownerEmail.trim()) throw new StaffError('OWNER_EMAIL is not set, so there is no owner to log role changes under.');
    if (command === 'list') {
      const staff = listStaff(service);
      console.log(staff.length ? staff.map(member => `${member.email}  ${STAFF_LABELS[member.role]}  since ${member.grantedAt.slice(0, 10)}  ${member.userId}`).join('\n') : 'No staff besides the owner.');
      return;
    }
    if (!who) throw new StaffError(`"${command}" needs an email or account ID.\n\n${USAGE}`);
    if (command === 'grant') {
      if (!role) throw new StaffError(`grant needs a role.\n\n${USAGE}`);
      const { member, previous } = grantStaffRole(service, who, role);
      console.log(`${member.email} is now ${STAFF_LABELS[member.role]}${previous ? ` (was ${STAFF_LABELS[previous]})` : ''}.`);
      console.log('They open the support tools at /admin. They sign in with Google again there if their last sign-in is over two hours old.');
      return;
    }
    if (command === 'revoke') {
      const { email, role: old } = revokeStaffRole(service, who);
      console.log(`${email} is no longer ${STAFF_LABELS[old]}. The support tools refuse them from their next request.`);
      return;
    }
    throw new StaffError(`Unknown command "${command}".\n\n${USAGE}`);
  } finally {
    db.close();
  }
}

try { main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
