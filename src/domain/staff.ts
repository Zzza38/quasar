/**
 * Staff roles (src/server/staff.ts). The owner is the account in OWNER_EMAIL and holds every permission plus the
 * owner-only tools (betas, mod overrides, the whole audit log, editing a member's classes, tasks, feeds, friendships
 * and profile, moving a member between schools). Every other role is a fixed bundle of permissions, assigned by the owner in
 * the staff console or by the operator with `npm run staff`. School Managers can delegate school Support and Chat Moderation.
 */
export const STAFF_ROLES = ['administrator', 'moderator', 'support', 'schedule-editor', 'school-manager', 'chat-moderation'] as const;
export const SCHOOL_DELEGABLE_ROLES = ['support', 'chat-moderation'] as const;
export type StaffRole = typeof STAFF_ROLES[number];
/** A staff account's rank: a granted role, or the owner. */
export type StaffRank = 'owner' | StaffRole;

export const STAFF_PERMISSIONS = [
  /** Correction requests and beta feedback in the support inbox. Appeals go with the sanction they appeal. */
  'requests',
  /** Verification requests, and verifying or unverifying a member at their school. */
  'verification',
  /** Publishing or declining passed proposals on support-locked schools. */
  'proposals',
  /** Publishing school revisions, renaming schools, and editing any school's class directory and lunch menu. */
  'schools.edit',
  /** Member reports: dismissing them, reading a chat report's messages (audited) and hiding reported messages. */
  'reports',
  /** Pausing and lifting a member's messaging, and answering pause appeals. */
  'chat.pause',
  /** Editing and removing anyone's Global chat messages. */
  'global.moderate',
  /** Searching members by email, name or account ID. */
  'members.search',
  /** Opening a member's record, with a reason written to the audit log. Tasks and feeds stay owner-only. */
  'members.view',
  /** Signing a member out everywhere and forgetting their reminder browsers. */
  'members.sessions',
  /** Removing a member from a school, lifting removals, and answering removal appeals. */
  'members.remove',
  /** Suspending an account and lifting a suspension. */
  'members.suspend',
] as const;
export type StaffPermission = typeof STAFF_PERMISSIONS[number];

export const ROLE_PERMISSIONS: Record<StaffRank, readonly StaffPermission[]> = {
  owner: STAFF_PERMISSIONS,
  administrator: STAFF_PERMISSIONS,
  'school-manager': ['requests', 'verification', 'proposals', 'schools.edit', 'members.remove', 'members.search', 'reports'],
  'chat-moderation': ['reports', 'chat.pause', 'global.moderate'],
  moderator: ['reports', 'chat.pause', 'global.moderate', 'members.remove'],
  support: ['requests', 'verification', 'members.search', 'members.view', 'members.sessions'],
  'schedule-editor': ['proposals', 'schools.edit'],
};

export const STAFF_LABELS: Record<StaffRank, string> = {
  'school-manager': 'School Manager', 'chat-moderation': 'Chat Moderation',
  owner: 'Owner', administrator: 'Administrator', moderator: 'Moderator', support: 'Support', 'schedule-editor': 'Schedule editor',
};
/** How a moderation note names who acted: "Removed by the owner", "Removed by a moderator". */
export const STAFF_NOUNS: Record<StaffRank, string> = {
  'school-manager': 'a school manager', 'chat-moderation': 'a chat moderator',
  owner: 'the owner', administrator: 'an administrator', moderator: 'a moderator', support: 'support', 'schedule-editor': 'a schedule editor',
};

/** What the signed-in account may do in the support tools. */
export type StaffAccess = { role: StaffRank; permissions: StaffPermission[]; schoolId?: string; schoolName?: string };

export function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === 'string' && (STAFF_ROLES as readonly string[]).includes(value);
}
export function staffAccess(role: StaffRank | null, scope?: { schoolId: string; schoolName: string }): StaffAccess | null {
  if (!role) return null;
  let permissions = ROLE_PERMISSIONS[role];
  if (scope && role === 'support') permissions = ['requests', 'verification', 'members.search'];
  if (scope && role === 'chat-moderation') permissions = [];
  return { role, permissions: [...permissions], ...scope };
}
export function hasPermission(access: StaffAccess | null | undefined, permission: StaffPermission): boolean {
  return !!access && access.permissions.includes(permission);
}

/**
 * The moderation tiers that decide who reads text taken out of a chat: member, then moderator, administrator and
 * owner. Support and schedule editors are outside the chain and count as members.
 */
export function moderationTier(rank: StaffRank | null | undefined): number {
  if (rank === 'owner') return 3;
  if (rank === 'administrator') return 2;
  return isModerationRank(rank) ? 1 : 0;
}
export type ModerationRank = 'owner' | 'administrator' | 'moderator' | 'chat-moderation' | 'school-manager';
export function isModerationRank(value: unknown): value is ModerationRank {
  return value === 'owner' || value === 'administrator' || value === 'moderator' || value === 'chat-moderation' || value === 'school-manager';
}
/** The rank stored with a removal or an edit: the actor's place in the chain, null for a member (or support). */
export function moderationRank(rank: StaffRank | null): ModerationRank | null {
  return isModerationRank(rank) ? rank : null;
}
/** A removed message's text: moderators and up, when whoever removed it is at their tier or below. Members never. */
export function canSeeRemoved(viewer: StaffRank | null, remover: StaffRank | null): boolean {
  return moderationTier(viewer) >= 1 && moderationTier(remover) <= moderationTier(viewer);
}
/** A message's text from before an edit: anyone at the editor's tier or above, so a member's edit shows to everyone. */
export function canSeeEdited(viewer: StaffRank | null, editor: StaffRank | null): boolean {
  return moderationTier(editor) <= moderationTier(viewer);
}
/** What the slur filter replaced with asterisks: the owner only. */
export function canSeeCensored(viewer: StaffRank | null): boolean {
  return viewer === 'owner';
}
