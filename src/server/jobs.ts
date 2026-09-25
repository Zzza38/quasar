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
/**
 * onError: a step threw, with the thrown value (log it through errorSummary, never its message). onFailures: a push
 * step ran but some pushes failed (each failure is caught per row, so a broken VAPID setup or a provider rejecting
 * every push would otherwise never reach the log). Only the step name and a count are reported, never provider text.
 */
type Options = { intervalMs?: number; onError?: (job: Job, error: unknown) => void; onFailures?: (job: Exclude<Job, 'calendar'>, failed: number) => void };

const TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;
/**
 * A loggable description of a thrown value: its class name plus any `code` (such as SQLITE_BUSY or
 * SQLITE_CONSTRAINT_FOREIGNKEY) and HTTP `statusCode`. The message is left out, because it can quote a feed URL,
 * a push endpoint or user text, and so is any field that does not look like a plain identifier.
 */
export function errorSummary(error: unknown): string {
  if (!(error instanceof Error)) return 'non-error value';
  const record = error as Error & { code?: unknown; statusCode?: unknown };
  const parts = [TOKEN.test(error.name) ? error.name : 'Error'];
  if (typeof record.code === 'string' && TOKEN.test(record.code)) parts.push(`code ${record.code}`);
  if (typeof record.statusCode === 'number' && Number.isInteger(record.statusCode)) parts.push(`status ${record.statusCode}`);
  return parts.join(', ');
}

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
  const push = async (job: Exclude<Job, 'calendar'>, run: () => Promise<{ failed: number }>) => {
    const { failed } = await run();
    if (failed > 0) options.onFailures?.(job, failed);
  };
  const cycle = async () => {
    try { await jobs.calendar.refreshDue(); } catch (error) { options.onError?.('calendar', error); }
    if (stopped) return;
    try { await push('notifications', () => jobs.notifications.deliverDue()); } catch (error) { options.onError?.('notifications', error); }
    if (stopped) return;
    try { await push('chat', () => jobs.notifications.deliverChat()); } catch (error) { options.onError?.('chat', error); }
    if (stopped) return;
    try { await push('support', () => jobs.notifications.deliverSupport()); } catch (error) { options.onError?.('support', error); }
    if (stopped) return;
    try { jobs.chat.prune(new Date()); } catch (error) { options.onError?.('chat', error); }
    if (!stopped) timer = setTimeout(() => { pending = cycle(); }, interval);
  };
  pending = cycle();
  return { stop: async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await pending;
  } };
}
