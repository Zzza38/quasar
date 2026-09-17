import { CalendarService } from './calendar';
import { NotificationService } from './notifications';
import type { Db } from './db';

type Jobs = {
  calendar: Pick<CalendarService, 'refreshDue'>;
  notifications: Pick<NotificationService, 'deliverDue'>;
};
type Options = { intervalMs?: number; onError?: (job: 'calendar' | 'notifications') => void };

/** Single sequential loop: a slow cycle cannot overlap the following cycle. */
export function startJobs(db: Db, options: Options = {}, jobs: Jobs = {
  calendar: new CalendarService(db), notifications: new NotificationService(db),
}): { stop: () => Promise<void> } {
  const interval = options.intervalMs ?? 60_000;
  if (!Number.isFinite(interval) || interval < 1) throw new Error('Worker interval must be positive');
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void>;
  const cycle = async () => {
    try { await jobs.calendar.refreshDue(); } catch { options.onError?.('calendar'); }
    if (stopped) return;
    try { await jobs.notifications.deliverDue(); } catch { options.onError?.('notifications'); }
    if (!stopped) timer = setTimeout(() => { pending = cycle(); }, interval);
  };
  pending = cycle();
  return { stop: async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await pending;
  } };
}
