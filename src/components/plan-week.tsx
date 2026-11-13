'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import { AI_BETA } from '@/domain/ai';
import { workLocationOf } from '@/domain/task-work';
import { PLAN_DAYS, PLAN_LOOKAHEAD_DAYS, PLAN_TASKS_MAX, crunchDays, formatLoad, isMissed, type PlanBlock } from '@/domain/plan';
import { addDays, daysBetween, formatDate, formatMinutes, formatRange, relativeDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { clockTime, sortByDue, taskItems, type AppState, type TaskItem } from './app-state';
import { useBeta, useBetaAccount } from './betas';
import { Icon } from './icon';
import { Button, Callout, Hint, Modal, Section, Spacer } from './primitives';
import { Checkbox } from './ui/checkbox';

/**
 * Quasar AI Plus in the ai-tasks beta (src/server/plan.ts): Plan my week on Today, with the week in a sheet, and time
 * estimates: a minutes chip on task rows and a quiet warning before a heavy day. Free accounts get a small daily
 * taste of each; the "Plus" tag shows only when billing is on and the member hasn't got Plus.
 */

type AiStatus = Extract<RouterOutput['ai']['status'], { beta: true }>;
type Plan = RouterOutput['plan']['get'];

/** One small store for the AI status, the plan and the estimates, shared by every view in the tab. */
type Store = { status: AiStatus | null; plan: Plan | null; planError: string; estimates: ReadonlyMap<string, number | null>; estimateError: string };
let store: Store = { status: null, plan: null, planError: '', estimates: new Map(), estimateError: '' };
const listeners = new Set<() => void>();
const update = (next: Partial<Store>) => { store = { ...store, ...next }; listeners.forEach((listener) => listener()); };
const useStore = () => useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => store, () => store);

let statusLoad: Promise<void> | null = null;
const loadStatus = (force = false) => {
  if (!statusLoad || force) statusLoad = api.ai.status.query().then((status) => update({ status: status.beta ? status : null }), () => { statusLoad = null; });
  return statusLoad;
};
const loadPlan = () => api.plan.get.query().then((plan) => update({ plan, planError: '' }), (err) => update({ planError: errorMessage(err) }));

/** The AI is on for this member: in the beta, and something to run it on. */
function useAiReady(): AiStatus | null {
  const beta = useBeta(AI_BETA);
  const { status } = useStore();
  useEffect(() => { if (beta) void loadStatus(); }, [beta]);
  return beta && status?.available ? status : null;
}

/** Shown on a Plus feature's button only when billing is on and the member isn't Plus. */
function PlusTag({ status }: { status: AiStatus | null }) {
  if (!status || status.plusUnlocked) return null;
  return <span className="ml-0.5 rounded-full bg-primary-soft px-1.5 py-px text-[10.5px] font-bold text-primary-soft-foreground">Plus</span>;
}

/** "1 of 2 free week plans left today", when the request would run on Quasar's model. */
function quotaLine(status: AiStatus | null, key: 'plan' | 'estimate', name: string): string {
  if (!status || status.own || status.chatgpt || !status.server) return '';
  const { used, limit } = status.quota[key];
  return `${Math.max(0, limit - used)} of ${limit} ${status.plan === 'plus' ? 'Plus' : 'free'} ${name} left today.`;
}

/* ---------- Estimates ---------- */

const estimateKey = (item: TaskItem) => `${item.id}\0${item.task.title}\0${item.task.notes}`;

/** Open tasks due in the next two weeks, soonest first: the ones worth an estimate. */
export function estimateCandidates(items: TaskItem[], today: string): TaskItem[] {
  return sortByDue(items.filter((item) => !item.task.completed && item.task.dueDate && workLocationOf(item.task) !== 'in-class')).filter((item) => {
    const days = daysBetween(today, item.task.dueDate!);
    return days >= 0 && days <= PLAN_LOOKAHEAD_DAYS;
  });
}

/** Asks for estimates of candidates not seen in this tab yet; the server answers unchanged ones from its own table. */
function useEstimates(state: AppState, enabled: boolean) {
  const account = useBetaAccount();
  const { estimates } = useStore();
  const candidates = useMemo(() => estimateCandidates(taskItems(state.snapshot.entities), state.today), [state.snapshot.entities, state.today]);
  const missing = candidates.filter((item) => !estimates.has(estimateKey(item)));
  const key = missing.map(estimateKey).join('\n');
  useEffect(() => {
    if (!enabled || !key || !account?.online) return;
    let cancelled = false;
    const timer = setTimeout(() => void (async () => {
      const batch = missing.slice(0, PLAN_TASKS_MAX);
      try {
        const { minutes } = await api.plan.estimate.mutate({ accountId: account.accountId, tasks: batch.map(({ id, task }) => ({ id, title: task.title, notes: task.notes, classId: task.classId, dueDate: task.dueDate })) });
        const next = new Map(store.estimates);
        for (const item of batch) next.set(estimateKey(item), minutes[item.id] ?? null);
        update({ estimates: next, estimateError: '' });
        void loadStatus(true);
      } catch (err) {
        // Not asked again in this tab: a used-up quota would otherwise retry on every render.
        const next = new Map(store.estimates);
        for (const item of batch) next.set(estimateKey(item), null);
        if (!cancelled) update({ estimates: next, estimateError: errorMessage(err) });
      }
    })(), 1200);
    return () => { cancelled = true; clearTimeout(timer); };
    // `missing` is read when the timer fires; its keys decide when to ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, account?.online, account?.accountId]);
  return { minutesOf: (item: TaskItem) => estimates.get(estimateKey(item)) ?? undefined, candidates };
}

/** The minutes chip on a task row (TaskRow in views/today.tsx), once the AI has estimated the task. */
export function EstimateChip({ item }: { item: TaskItem }) {
  const { estimates } = useStore();
  const minutes = estimates.get(estimateKey(item));
  if (!minutes || item.task.completed || workLocationOf(item.task) === 'in-class') return null;
  return <span className="inline-flex items-center gap-1" title="Time estimate from AI"><Icon name="clock" size={11} strokeWidth={2.4} />~{formatMinutes(minutes)}</span>;
}

/** Busy due dates, their estimated workload, and an earlier starting point for the largest task. */
export function CrunchNotice({ state }: { state: AppState }) {
  const status = useAiReady();
  const { minutesOf, candidates } = useEstimates(state, !!status && state.online);
  const [expanded, setExpanded] = useState<string[]>([]);
  if (!status) return null;
  const byId = new Map(candidates.map((item) => [item.id, item]));
  const crunches = crunchDays(candidates.map(({ id, task }) => ({ id, title: task.title, dueDate: task.dueDate, completed: task.completed })), (id) => { const item = byId.get(id); return item ? minutesOf(item) : undefined; }, state.today).slice(0, 2);
  if (crunches.length === 0) return null;
  return <section role="status" aria-label="Heavy days" className="grid gap-1 rounded-xl border bg-card px-4 py-2">
    <h3 className="py-1 text-sm font-semibold">Workload ahead</h3>
    <ul className="divide-y">{crunches.map(crunch => {
      const tasks = candidates.filter(item => item.task.dueDate === crunch.date);
      const estimated = tasks.filter(item => minutesOf(item) !== undefined).length;
      const open = expanded.includes(crunch.date);
      return <li key={crunch.date} className="grid min-w-0 gap-2 py-2">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="text-sm font-medium">{relativeDate(crunch.date, state.today, { weekday: 'long' })}</span>
          <Button size="sm" variant="link" className="h-auto min-w-0 gap-2 px-0 py-1" aria-expanded={open} aria-controls={`workload-${crunch.date}`} onClick={() => setExpanded(current => open ? current.filter(date => date !== crunch.date) : [...current, crunch.date])}>
            <span className="font-normal text-muted-foreground">{estimated} {estimated === 1 ? 'estimate' : 'estimates'}</span><span className="font-semibold tabular-nums">~{formatLoad(crunch.minutes)}</span><Icon name="chevronDown" className={open ? 'rotate-180' : undefined} size={14} />
          </Button>
        </div>
        {open && <ul id={`workload-${crunch.date}`} className="grid min-w-0 gap-1 border-t pt-2" aria-label={`Task estimates for ${crunch.date}`}>{tasks.map(item => <li key={item.id}>
          <Button variant="link" size="sm" className="h-auto w-full min-w-0 justify-between gap-3 whitespace-normal px-0 py-1 text-left text-foreground" onClick={() => state.navigate('tasks', { edit: item.id })}>
            <span className="min-w-0 break-words">{item.task.title}</span><span className="shrink-0 text-xs font-normal text-muted-foreground">{minutesOf(item) === undefined ? 'No estimate' : `~${formatLoad(minutesOf(item)!)}`}</span>
          </Button>
        </li>)}</ul>}
      </li>;
    })}</ul>
    <Hint className="pb-1">In-class work is excluded. Tasks without enough detail stay unestimated.</Hint>
  </section>;
}

/* ---------- Plan my week ---------- */

/** Blocks to show: those for tasks still open (or already marked), so a finished task's leftover blocks go away. */
function visibleBlocks(plan: Plan | null, open: ReadonlyMap<string, TaskItem>): PlanBlock[] {
  return (plan?.blocks ?? []).filter((block) => block.status !== 'planned' || open.has(block.taskId));
}

function usePlanState(state: AppState) {
  const status = useAiReady();
  const { plan, planError } = useStore();
  useEffect(() => { if (status) void loadPlan(); }, [status]);
  const open = useMemo(() => new Map(taskItems(state.snapshot.entities).filter((item) => !item.task.completed).map((item) => [item.id, item])), [state.snapshot.entities]);
  const nowTime = clockTime(state.now, state.timeZone);
  const blocks = visibleBlocks(plan, open);
  const missed = blocks.filter((block) => isMissed(block, state.today, nowTime));
  return { status, plan, planError, open, blocks, missed, nowTime };
}

async function makePlan(accountId: string): Promise<string> {
  const result = await api.plan.make.mutate({ accountId });
  update({ plan: result, planError: '' });
  void loadStatus(true);
  const count = result.blocks.filter((block) => block.status === 'planned').length;
  return count === 0 ? 'Nothing needed a study block this week.' : `Planned ${count} study ${count === 1 ? 'block' : 'blocks'}.${result.dropped ? ` ${result.dropped} AI ${result.dropped === 1 ? 'suggestion didn’t' : 'suggestions didn’t'} fit your free time and ${result.dropped === 1 ? 'was' : 'were'} left out.` : ''}`;
}

async function markBlock(accountId: string, blockId: string, status: PlanBlock['status']) {
  update({ plan: await api.plan.mark.mutate({ accountId, blockId, status }) });
}

/** Today: today's study blocks, a missed-block nudge, and the week sheet. The crunch warning sits above it. */
export function PlanToday({ state }: { state: AppState }) {
  const { status, plan, planError, open, blocks, missed } = usePlanState(state);
  const [sheet, setSheet] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  if (!status || state.personal.classes.length === 0) return null;
  const accountId = state.context.user.id;
  const todays = blocks.filter((block) => block.date === state.today && !missed.includes(block));
  const upcoming = blocks.find((block) => block.date > state.today && block.status === 'planned');
  const hasPlan = !!plan?.plan && blocks.some((block) => block.date >= state.today || missed.includes(block));
  const replan = async () => {
    setPending(true); setError('');
    try { await makePlan(accountId); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
  };
  return <>
    <CrunchNotice state={state} />
    <Section title="Study plan" id="today-plan" description={hasPlan ? undefined : 'Study blocks for your tests and big work, placed in your free periods and after school.'}
      action={hasPlan
        ? <Button size="sm" variant="ghost" iconRight="arrowRight" onClick={() => setSheet(true)}>Week</Button>
        : <Button size="sm" icon="sparkle" busy={pending} disabled={!state.online} onClick={() => void replan()}>Plan my week<PlusTag status={status} /></Button>}>
      {!plan && !planError && <Hint>Loading…</Hint>}
      {hasPlan && todays.length > 0 && <ul className="grid gap-0.5" aria-label="Today’s study blocks">{todays.map((block) => <BlockRow key={block.id} block={block} task={open.get(block.taskId)} accountId={accountId} online={state.online} />)}</ul>}
      {hasPlan && todays.length === 0 && <p className="text-sm text-muted-foreground">{upcoming ? `Nothing planned for today. Next: ${relativeDate(upcoming.date, state.today)} · ${upcoming.slotLabel} · ${upcoming.title}` : 'Nothing else planned this week.'}</p>}
      {missed.length > 0 && <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-muted/70 px-3.5 py-2.5 text-[13.5px]">
        <span>{missed.length === 1 ? '1 study block was missed.' : `${missed.length} study blocks were missed.`} Replan to fit {missed.length === 1 ? 'it' : 'them'} into the rest of the week.</span>
        <Button size="sm" icon="refresh" busy={pending} disabled={!state.online} onClick={() => void replan()}>Replan<PlusTag status={status} /></Button>
      </div>}
      {(error || planError) && <Hint tone="danger" role="alert">{error || planError}</Hint>}
    </Section>
    {sheet && <PlanWeekSheet state={state} onClose={() => setSheet(false)} />}
  </>;
}

function BlockRow({ block, task, accountId, online, showTask }: { block: PlanBlock; task: TaskItem | undefined; accountId: string; online: boolean; showTask?: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const mark = async (status: PlanBlock['status']) => {
    setPending(true); setError('');
    try { await markBlock(accountId, block.id, status); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
  };
  const done = block.status === 'done', skipped = block.status === 'skipped';
  const id = `plan-block-${block.id}`;
  return <li className="flex items-start gap-3 rounded-2xl px-2.5 py-2.5 transition-colors hover:bg-muted/70">
    <Checkbox id={id} className="mt-0.5 size-[22px] rounded-full border-2 border-control-border shadow-none data-checked:border-primary [&_svg]:size-3.5" checked={done} disabled={pending || !online || skipped}
      aria-label={`Mark ${block.title} ${done ? 'not done' : 'done'}`} onCheckedChange={(checked) => void mark(checked === true ? 'done' : 'planned')} />
    <div className="grid min-w-0 flex-1 gap-0.5">
      <label htmlFor={id} className={cn('text-[14.5px] font-semibold leading-snug', (done || skipped) && 'text-muted-foreground', done && 'line-through')}>{block.title}</label>
      <span className="text-xs font-medium tabular-nums text-muted-foreground">{block.slotLabel} · {formatRange(block.start, block.end)}{skipped ? ' · Skipped' : ''}</span>
      {showTask && task && <span className="truncate text-xs text-muted-foreground">For {task.task.title}</span>}
      {error && <Hint tone="danger" role="alert">{error}</Hint>}
    </div>
    {!done && <Button size="sm" variant="ghost" className="shrink-0" busy={pending} disabled={!online} aria-label={`${skipped ? 'Undo skipping' : 'Skip'} ${block.title}`} onClick={() => void mark(skipped ? 'planned' : 'skipped')}>
      {skipped ? 'Undo' : 'Skip'}</Button>}
  </li>;
}

/** The week: each day's blocks, marking, and Replan. */
function PlanWeekSheet({ state, onClose }: { state: AppState; onClose: () => void }) {
  const { status, open, blocks, missed } = usePlanState(state);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const accountId = state.context.user.id;
  const days = Array.from({ length: PLAN_DAYS }, (_, offset) => addDays(state.today, offset))
    .map((date) => ({ date, blocks: blocks.filter((block) => block.date === date && !missed.includes(block)) })).filter((day) => day.blocks.length > 0);
  const replan = async () => {
    setPending(true); setError(''); setDone('');
    try { setDone(await makePlan(accountId)); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
  };
  const quota = quotaLine(status, 'plan', 'week plans');
  return <Modal open onClose={onClose} busy={pending} wide title="Your week"
    description={`Study blocks in your free periods and after school, for tests and big work due soon.${quota ? ` ${quota}` : ''}`}
    footer={<><Button variant="ghost" disabled={pending} onClick={onClose}>Done</Button><Spacer />
      <Button variant="primary" icon="refresh" busy={pending} disabled={!state.online} onClick={() => void replan()}>Replan<PlusTag status={status} /></Button></>}>
    {missed.length > 0 && <Callout tone="neutral" icon="info">{missed.length === 1 ? 'One block was missed.' : `${missed.length} blocks were missed.`} Replan to find {missed.length === 1 ? 'it' : 'them'} a new place this week.</Callout>}
    {days.length === 0 && <p className="text-sm text-muted-foreground">Nothing is planned for the rest of the week.</p>}
    {days.map((day) => <section key={day.date} aria-labelledby={`plan-day-${day.date}`} className="grid gap-0.5">
      <h3 id={`plan-day-${day.date}`} className="px-2.5 pt-1 text-[12px] font-extrabold uppercase tracking-[0.1em] text-muted-foreground">
        {relativeDate(day.date, state.today, { weekday: 'long' })}{daysBetween(state.today, day.date) > 1 ? '' : ` · ${formatDate(day.date)}`}
        <span className="font-semibold text-muted-foreground/70"> · {formatMinutes(day.blocks.reduce((sum, block) => block.status === 'skipped' ? sum : sum + block.minutes, 0))}</span>
      </h3>
      <ul className="grid gap-0.5">{day.blocks.map((block) => <BlockRow key={block.id} block={block} task={open.get(block.taskId)} accountId={accountId} online={state.online} showTask />)}</ul>
    </section>)}
    {done && <Callout tone="success" icon="check" role="status">{done}</Callout>}
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    {!state.online && <Hint>Connect to the internet to replan.</Hint>}
  </Modal>;
}
