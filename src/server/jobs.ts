import { CalendarService } from './calendar';
import { pruneChat } from './chat';
import { pruneGlobalChat } from './global-chat';
import { NotificationService } from './notifications';
import type { Db } from './db';

type Job = 'calendar' | 'notifications' | 'chat' | 'support';
type Jobs = {
  calendar: Pick<CalendarService, 'refreshDue'>;
  notifications: Pick<NotificationService, 'deliverDue' | 'deliverChat' | 'deliverSupport'>;
  chat: { prune: (now: Date) => void };
};
type Options = { intervalMs?: number; onError?: (job: Job) => void };

/**
 * Single sequential loop: a slow cycle cannot overlap the following cycle. One cycle runs
 * calendar refresh → task reminders → chat pushes → owner support pushes → chat retention, each step isolated so a
 * failure is reported and the rest of the cycle still runs. Stopping skips the remaining steps.
 */
export function startJobs(db: Db, options: Options = {}, jobs: Jobs = {
  calendar: new CalendarService(db), notifications: new NotificationService(db), chat: { prune: now => { pruneChat(db, now); pruneGlobalChat(db, now); } },
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
    if (stopped) return;
    try { await jobs.notifications.deliverChat(); } catch { options.onError?.('chat'); }
    if (stopped) return;
    try { await jobs.notifications.deliverSupport(); } catch { options.onError?.('support'); }
    if (stopped) return;
    try { jobs.chat.prune(new Date()); } catch { options.onError?.('chat'); }
    if (!stopped) timer = setTimeout(() => { pending = cycle(); }, interval);
  };
  pending = cycle();
  return { stop: async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await pending;
  } };
}
