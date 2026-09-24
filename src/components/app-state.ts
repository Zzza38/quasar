import type { Workspace } from '@/client/api';
import type { WorkspaceSnapshot } from '@/client/offline';
import type { PersonalSchedule, Schedule } from '@/domain/schedule';
import type { Entity } from '@/domain/sync';
import { taskSchema, type Task } from '@/domain/task';

export type WorkspaceContext = Omit<Workspace, 'entities'>;
export type View = 'today' | 'schedule' | 'tasks' | 'classes' | 'school' | 'people';
export const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'classes', label: 'Classes' },
  { id: 'school', label: 'School' },
  { id: 'people', label: 'People' },
];

export interface TaskItem { id: string; task: Task; entity: Entity }

export function taskItems(entities: Entity[]): TaskItem[] {
  const items: TaskItem[] = [];
  for (const entity of entities) {
    if (entity.kind !== 'task' || entity.deleted) continue;
    const parsed = taskSchema.safeParse(entity.data);
    if (parsed.success) items.push({ id: entity.id, task: parsed.data, entity });
  }
  return items;
}

export function sortByDue(items: TaskItem[]): TaskItem[] {
  return [...items].sort((left, right) => `${left.task.dueDate ?? '9999-12-31'}T${left.task.dueTime ?? '23:59'}`.localeCompare(`${right.task.dueDate ?? '9999-12-31'}T${right.task.dueTime ?? '23:59'}`));
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
  refresh: () => Promise<void>;
  /** `replace` swaps the current history entry (for stripping one-shot params) and keeps the scroll position. */
  navigate: (view: View, params?: Record<string, string>, options?: { replace?: boolean }) => void;
  params: URLSearchParams;
}
