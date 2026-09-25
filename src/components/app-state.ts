import type { Workspace } from '@/client/api';
import type { WorkspaceSnapshot } from '@/client/offline';
import { personalScheduleSchema, type PersonalSchedule, type Schedule } from '@/domain/schedule';
import type { Entity } from '@/domain/sync';
import { repairTaskDates, taskSchema, type Task } from '@/domain/task';
import { instantParts } from '@/lib/format';

export type WorkspaceContext = Omit<Workspace, 'entities'>;
export type WorkspaceClassmates = WorkspaceContext['community']['classmates'];

/**
 * The workspace context as saved on this device (IndexedDB): the workspace without its entities, and without
 * friends' names and class lists (`community.classmates`). Those stay in memory only (see withClassmates), so other
 * students' timetables never sit on the device's disk, and an unfriend or block is not undone by a cached copy.
 */
export function persistedContext(workspace: Workspace | WorkspaceContext): WorkspaceContext {
  const { entities: _entities, ...context } = workspace as Workspace;
  return { ...context, community: { ...context.community, classmates: [] } };
}

/**
 * Shape version of the context saved on this device. Bump it whenever WorkspaceContext gains, loses or changes a
 * field the client reads: a copy saved by an older build is then ignored (the network load replaces it) instead of
 * being read as the current shape and crashing a render. 2 is the first stamped version. The build before it saved
 * the context without a version; that copy is read as version 2 when it has `user.suggestedNames` (see cachedContext).
 * 3 adds `user.avatar` and the picture source (docs/CHAT.md §13) and `sanctions` (§14).
 */
export const CONTEXT_VERSION = 3;

/** The record written to the device store: persistedContext stamped with CONTEXT_VERSION. */
export function storedContext(workspace: Workspace | WorkspaceContext): Record<string, unknown> {
  return { ...persistedContext(workspace), contextVersion: CONTEXT_VERSION };
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * An unversioned context saved by the build just before CONTEXT_VERSION existed (it wrote the whole workspace
 * context, friends' timetables included). Its shape is version 2's, so it is kept, with the classmates dropped.
 * Builds older still lacked `user.suggestedNames`, which the names step reads, so their copies are not accepted.
 */
function unversionedContext(saved: Record<string, unknown>): WorkspaceContext | null {
  if ('contextVersion' in saved) return null;
  const user = saved.user;
  if (!isRecord(user) || !isRecord(user.suggestedNames) || typeof user.suggestedNames.displayName !== 'string' || typeof user.suggestedNames.fullName !== 'string') return null;
  if (!isRecord(saved.community)) return null;
  return persistedContext(saved as unknown as WorkspaceContext);
}

/** The context saved on this device, or null when there is none or an older build saved it in another shape. */
export function cachedContext(saved: Record<string, unknown> | null | undefined): WorkspaceContext | null {
  if (!saved) return null;
  if (saved.contextVersion !== CONTEXT_VERSION) return unversionedContext(saved);
  const { contextVersion: _version, ...context } = saved;
  return context as unknown as WorkspaceContext;
}

/**
 * The record to re-save in place of an accepted unversioned context (stamped, without friends' data), or null when
 * the saved context needs no rewrite. Pass it to OfflineWorkspace.upgradeContext.
 */
export function upgradedContext(saved: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const context = saved ? unversionedContext(saved) : null;
  return context && storedContext(context);
}

/** The saved context with the in-memory classmates from the latest server response put back. */
export function withClassmates(context: WorkspaceContext, classmates: WorkspaceClassmates): WorkspaceContext {
  return { ...context, community: { ...context.community, classmates } };
}
export type View = 'today' | 'schedule' | 'tasks' | 'classes' | 'school' | 'people' | 'messages';
/** Every routable view. `dock: false` keeps a view out of the six-tab phone dock (it has its own top-bar link). */
export const VIEWS: Array<{ id: View; label: string; dock?: boolean }> = [
  { id: 'today', label: 'Today' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'classes', label: 'Classes' },
  { id: 'school', label: 'School' },
  { id: 'people', label: 'People' },
  { id: 'messages', label: 'Messages', dock: false },
];

export interface TaskItem { id: string; task: Task; entity: Entity }

export function taskItems(entities: Entity[]): TaskItem[] {
  const items: TaskItem[] = [];
  for (const entity of entities) {
    if (entity.kind !== 'task' || entity.deleted) continue;
    const parsed = taskSchema.safeParse(entity.data);
    // A task an older build saved with a date outside 1900-2199 is shown without that date (as the server's
    // migration 11 stores it), so the student can still open, fix or delete it while this device is offline.
    const task = parsed.success ? parsed.data : repairTaskDates(entity.data);
    if (task) items.push({ id: entity.id, task, entity });
  }
  return items;
}

export function sortByDue(items: TaskItem[]): TaskItem[] {
  return [...items].sort((left, right) => `${left.task.dueDate ?? '9999-12-31'}T${left.task.dueTime ?? '23:59'}`.localeCompare(`${right.task.dueDate ?? '9999-12-31'}T${right.task.dueTime ?? '23:59'}`));
}

/** "HH:MM" (24-hour) of `now` in the school's zone, the zone overdue checks read due times in. */
export function clockTime(now: Date, timeZone: string): string {
  return instantParts(now.toISOString(), timeZone).time;
}

/**
 * The one overdue rule, shared by task rows, the Today tile and the Tasks header and groups: an open task
 * whose due date has passed, or that is due today at a due time that has passed (`nowTime` from clockTime).
 */
export function isOverdue(task: Task, today: string, nowTime: string): boolean {
  if (task.completed || !task.dueDate) return false;
  return task.dueDate < today || (task.dueDate === today && task.dueTime !== null && task.dueTime < nowTime);
}

/**
 * Where "Wrong time?" links go. With a private schedule the times shown come from that copy, which school
 * corrections do not change, so the student edits it (Classes opens the sheet); otherwise the school's times.
 */
export function openBellTimes(state: Pick<AppState, 'personal' | 'navigate'>): void {
  if (state.personal.customSchedule) state.navigate('classes', { private: 'open' });
  else state.navigate('school', { fix: 'times' });
}

export const UNREADABLE_PERSONAL = 'Retry sync before changing your saved schedule.';

/**
 * The one way the app writes the personal schedule. When the saved copy could not be read on this
 * device, views see an empty fallback; saving that fallback (plus one edit) would replace the
 * student's classes, assignments and overrides on the server, so every save is refused until a
 * sync makes the saved copy readable again.
 */
export function personalSaver(readable: boolean, save: (personal: PersonalSchedule) => Promise<void>): (personal: PersonalSchedule) => Promise<void> {
  return async (personal) => {
    if (!readable) throw new Error(UNREADABLE_PERSONAL);
    await save(personalScheduleSchema.parse(personal));
  };
}

/** Everything a signed-in, onboarded view needs. */
export interface AppState {
  context: WorkspaceContext & { school: NonNullable<WorkspaceContext['school']> };
  snapshot: WorkspaceSnapshot;
  personal: PersonalSchedule;
  personalValid: boolean;
  /** The school's schedule; `personal.customSchedule` is applied by the domain functions automatically. */
  schedule: Schedule;
  timeZone: string;
  now: Date;
  today: string;
  online: boolean;
  saveTask: (id: string, task: Task | null) => Promise<void>;
  savePersonal: (personal: PersonalSchedule) => Promise<void>;
  /** Reloads the workspace from the server; resolves false when that failed (the error is shown by the shell). */
  refresh: () => Promise<boolean>;
  /** `replace` swaps the current history entry (for stripping one-shot params) and keeps the scroll position. */
  navigate: (view: View, params?: Record<string, string>, options?: { replace?: boolean }) => void;
  params: URLSearchParams;
  /** Unread chats (conversations, not messages) for the badge; null while offline, which hides it. */
  chatUnread: number | null;
  /** Offers a server-stamped unread count; the one with the latest `at` wins. */
  setChatUnread: (count: number, at: string) => void;
}
