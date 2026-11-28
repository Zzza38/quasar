import { isStaffRole, type StaffRole } from './staff';

// A previous release recognizes only the global role keys. Distinct keys make a rollback ignore scoped grants.
export function decodeStoredRole(value: unknown): StaffRole | null {
  if (value === 'school-chat-moderation') return 'chat-moderation';
  if (value === 'school-support') return 'support';
  return isStaffRole(value) ? value : null;
}

export function encodeStoredRole(role: StaffRole, schoolId: string | null): string {
  if (schoolId && (role === 'chat-moderation' || role === 'support')) return `school-${role}`;
  return role;
}
