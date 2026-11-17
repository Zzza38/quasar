'use client';

import type { Task } from '@/domain/task';
import { taskClassPeriods, workLocationOf } from '@/domain/task-work';
import { formatRange } from '@/lib/format';
import type { AppState } from './app-state';

export function TaskWorkLabel({ task, state }: { task: Task; state: Pick<AppState, 'schedule' | 'personal'> }) {
  const location = workLocationOf(task);
  if (!location) return null;
  const periods = taskClassPeriods(task, state.schedule, state.personal);
  return <span>{location === 'in-class' ? 'In class' : 'Out of class'}{periods.length > 0 ? ` · ${periods.map(period => formatRange(period.start, period.end)).join(', ')}` : ''}</span>;
}
