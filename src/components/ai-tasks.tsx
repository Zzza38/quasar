'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import { AI_BETA, AI_CLASSIFY_MAX, AI_PLUS_BREAKDOWN_DAILY_LIMIT, AI_PLUS_SORT_DAILY_LIMIT, AI_PROVIDER_IDS, AI_PROVIDERS, AI_SORT_MAX, type AiProvider } from '@/domain/ai';
import type { Task } from '@/domain/task';
import { browserTimeZone, formatDate, instantParts } from '@/lib/format';
import { cn } from '@/lib/utils';
import { sortByDue, taskItems, type AppState, type TaskItem } from './app-state';
import { useBeta, useBetaAccount } from './betas';
import { Icon } from './icon';
import { Button, Callout, Field, Hint, Input, Modal, Select, Spacer } from './primitives';

/**
 * AI task helpers behind the `ai-tasks` beta (src/server/ai.ts): "Sort with AI" on Tasks, "Break it down" in the
 * task sheet, and the AI block in Account. The server only suggests; every change here goes through state.saveTask
 * or the task draft, so it syncs and merges like an edit the student made.
 */

type AiStatus = RouterOutput['ai']['status'];
type BillingStatus = RouterOutput['billing']['status'];
type Suggestion = RouterOutput['ai']['sort']['suggestions'][number];
/** What the AI called each task, keyed by id + title + notes so an edit asks again. Lives across visits to Tasks. */
const assessmentCache = new Map<string, 'test' | 'quiz' | 'none'>();
const assessmentKey = (item: TaskItem) => `${item.id}\0${item.task.title}\0${item.task.notes}`;

/**
 * The AI's test-or-quiz call for `candidates` (ai.assessments). Only tasks not in the cache are sent; the server keeps
 * its own copy too, so a reload costs nothing for tasks it already checked.
 */
export function useAssessmentKinds(candidates: TaskItem[], enabled: boolean) {
  const account = useBetaAccount();
  const [, setVersion] = useState(0);
  const [error, setError] = useState('');
  const missing = candidates.filter((item) => !assessmentCache.has(assessmentKey(item)));
  const key = missing.map(assessmentKey).join('\n');
  useEffect(() => {
    if (!enabled || !key || !account?.online) return;
    let cancelled = false;
    const timer = setTimeout(() => void (async () => {
      try {
        const batch = missing.slice(0, AI_CLASSIFY_MAX);
        const { kinds } = await api.ai.assessments.mutate({ accountId: account.accountId, tasks: batch.map(({ id, task }) => ({ id, title: task.title, notes: task.notes, classId: task.classId })) });
        for (const item of batch) assessmentCache.set(assessmentKey(item), kinds[item.id] ?? 'none');
        if (!cancelled) { setError(''); setVersion((version) => version + 1); }
      } catch (err) { if (!cancelled) setError(errorMessage(err)); }
    })(), 800);
    return () => { cancelled = true; clearTimeout(timer); };
    // `missing` is read when the timer fires; its keys decide when to ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, account?.online, account?.accountId]);
  return { kindOf: (item: TaskItem) => assessmentCache.get(assessmentKey(item)), pending: enabled && missing.length > 0 && !error, error };
}

const PRIORITY_LABEL = { low: 'Low', normal: 'Normal', high: 'High' } as const;
const PRIORITY_TONE = { high: 'font-bold text-destructive', normal: '', low: 'text-blue-600 dark:text-blue-400' } as const;
const PRIORITY_BARS = { high: 3, normal: 2, low: 1 } as const;

/** Priority as a three-bar meter (ai-tasks beta): filled bars in the label's color, the rest faint, so low still reads as a meter. */
export function PriorityLabel({ priority, className }: { priority: 'low' | 'normal' | 'high'; className?: string }) {
  return <span className={cn('inline-flex items-center gap-1', PRIORITY_TONE[priority], className)}>
    <svg width="13" height="12" viewBox="0 0 13 12" aria-hidden="true">{[0, 1, 2].map((bar) =>
      <rect key={bar} x={bar * 4.5} y={8 - bar * 3.5} width="3" height={4 + bar * 3.5} rx="1" fill="currentColor" opacity={bar < PRIORITY_BARS[priority] ? 1 : 0.28} />)}</svg>
    {PRIORITY_LABEL[priority]} priority
  </span>;
}

function useAiStatus(enabled: boolean) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const reload = useCallback(() => api.ai.status.query().then(setStatus, () => setStatus(null)), []);
  useEffect(() => { if (enabled) void reload(); }, [enabled, reload]);
  return { status, setStatus, reload };
}

/** Open tasks nobody has prioritized yet: calendar imports, and quick adds the student never opened. */
export function sortCandidates(items: TaskItem[]): TaskItem[] {
  return sortByDue(items.filter((item) => !item.task.completed && (item.task.priority === undefined || item.task.workLocation === undefined)));
}

export const sortAttemptKey = (accountId: string, item: TaskItem) => JSON.stringify([accountId, item.id, item.task.title, item.task.notes, item.task.dueDate, item.task.dueTime]);

/** What a suggestion would change on a task: the class only when the task has none, the priority only when unset. */
export function applySuggestion(task: Task, suggestion: Pick<Suggestion, 'classId' | 'priority' | 'workLocation'>): Task {
  return { ...task, classId: task.classId ?? suggestion.classId, priority: task.priority ?? suggestion.priority,
    ...(!task.workLocation && suggestion.workLocation ? { workLocation: suggestion.workLocation, workLocationSource: 'ai' as const } : {}) };
}

/**
 * Auto-sort (one per signed-in app, in tracker.tsx): a moment after tasks with no priority appear (added here, on
 * another device or by a calendar refresh), they go to the AI once each. Every priority is applied, and a class when the AI
 * found one and the task has none. Tasks it skipped stay for the manual Sort with AI sheet.
 */
type AutoSortState = { attempted: ReadonlySet<string>; running: number; error: string };
let autoSort: AutoSortState = { attempted: new Set(), running: 0, error: '' };
const autoSortListeners = new Set<() => void>();
const setAutoSort = (next: Partial<AutoSortState>) => { autoSort = { ...autoSort, ...next }; autoSortListeners.forEach((listener) => listener()); };
const useAutoSortState = () => useSyncExternalStore((listener) => { autoSortListeners.add(listener); return () => { autoSortListeners.delete(listener); }; }, () => autoSort, () => autoSort);
/** How long new tasks settle before a sort, so a few quick adds go as one request. */
const AUTO_SORT_DELAY_MS = 1500;

export function AiAutoSort({ state }: { state: AppState }) {
  const beta = useBeta(AI_BETA);
  const { status } = useAiStatus(beta);
  const { attempted, running } = useAutoSortState();
  const latest = useRef(state);
  latest.current = state;
  const pending = useMemo(() => sortCandidates(taskItems(state.snapshot.entities)).filter((item) => !attempted.has(sortAttemptKey(state.context.user.id, item))), [state.snapshot.entities, attempted, state.context.user.id]);
  const key = pending.map(item => sortAttemptKey(state.context.user.id, item)).join(',');
  const enabled = beta && !!status?.beta && status.available && state.online;
  useEffect(() => {
    if (!enabled || !key || running) return;
    const timer = setTimeout(() => void (async () => {
      const batch = pending.slice(0, AI_SORT_MAX);
      setAutoSort({ attempted: new Set([...autoSort.attempted, ...batch.map(item => sortAttemptKey(latest.current.context.user.id, item))]), running: batch.length, error: '' });
      try {
        const { suggestions } = await api.ai.sort.mutate({ accountId: latest.current.context.user.id, tasks: batch.map(({ id, task }) => ({ id, title: task.title, notes: task.notes, dueDate: task.dueDate, dueTime: task.dueTime, classId: task.classId, priority: task.priority ?? null })) });
        // Read each task again: the student may have edited it while the AI was thinking.
        const current = new Map(taskItems(latest.current.snapshot.entities).map((item) => [item.id, item.task]));
        for (const entry of suggestions) {
          const task = current.get(entry.id);
          if (!task || (task.priority !== undefined && task.workLocation !== undefined)) continue;
          const next = applySuggestion(task, entry);
          if (JSON.stringify(next) !== JSON.stringify(task)) await latest.current.saveTask(entry.id, next);
        }
        setAutoSort({ running: 0 });
      } catch (err) { setAutoSort({ running: 0, error: errorMessage(err) }); }
    })(), AUTO_SORT_DELAY_MS);
    return () => clearTimeout(timer);
    // `pending` is read when the timer fires; its ids (`key`) decide when to start over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, running]);
  return null;
}

/** The Tasks banner: auto-sort progress, tasks it left (the Sort with AI sheet), and the return from Connect OpenRouter. */
export function AiTasksBanner({ state, items }: { state: AppState; items: TaskItem[] }) {
  const beta = useBeta(AI_BETA);
  const { attempted, running, error } = useAutoSortState();
  // Only what auto-sort already tried and left; anything newer is about to be sorted automatically.
  const candidates = useMemo(() => sortCandidates(items).filter((item) => attempted.has(sortAttemptKey(state.context.user.id, item)) || !state.online), [items, attempted, state.online, state.context.user.id]);
  const connected = useOpenRouterReturn(state, beta);
  const billing = state.params.get('billing');
  const [billingNote] = useState(billing);
  useEffect(() => { if (billing) state.navigate('tasks', undefined, { replace: true }); }, [billing, state]);
  const [billingShown, setBillingShown] = useState(true);
  if (!beta) return null;
  return <>
    {connected}
    {billingNote && billingShown && <Callout tone={billingNote === 'success' ? 'success' : 'neutral'} icon={billingNote === 'success' ? 'check' : 'info'} role="status"
      actions={<Button size="sm" variant="ghost" onClick={() => setBillingShown(false)}>Dismiss</Button>}>
      {billingNote === 'success' ? 'Thanks for getting Plus. Your higher AI limit turns on as soon as Stripe confirms the payment, usually within a few seconds.' : 'Checkout was cancelled. Nothing was charged.'}
    </Callout>}
    {running > 0 && <Hint role="status">Labeling {running} {running === 1 ? 'task' : 'tasks'}…</Hint>}
    {error && !running && <Callout tone="warning" icon="alert" role="alert" actions={<Button size="sm" variant="ghost" onClick={() => setAutoSort({ error: '' })}>Dismiss</Button>}>Couldn’t sort new tasks automatically. {error}</Callout>}
    {candidates.length > 0 && !running && <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{candidates.length === 1 ? '1 task needs your label' : `${candidates.length} tasks need your labels`}</span>
      <Button size="sm" variant="ghost" onClick={() => state.navigate('tasks', { edit: candidates[0].id })}>Review {candidates.length === 1 ? 'task' : 'labels'}</Button>
    </div>}
  </>;
}

/** "Break it down" in the task sheet's checklist: adds the AI's steps to the draft, which the student saves or edits. */
export function AiBreakdownButton({ draft, onSteps }: { draft: Task; onSteps: (steps: string[]) => void }) {
  const beta = useBeta(AI_BETA);
  const account = useBetaAccount();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  if (!beta || !account) return null;
  const run = async () => {
    setPending(true); setError('');
    try {
      const { steps } = await api.ai.breakdown.mutate({ accountId: account.accountId, title: draft.title.trim(), notes: draft.notes, dueDate: draft.dueDate, classId: draft.classId });
      onSteps(steps);
    } catch (err) { setError(errorMessage(err)); }
    finally { setPending(false); }
  };
  return <>
    <Button size="sm" variant="ghost" icon="sparkle" className="shrink-0" busy={pending} disabled={!account.online || !draft.title.trim() || (draft.subtasks?.length ?? 0) >= 100}
      title={!draft.title.trim() ? 'Name the task first' : undefined} onClick={() => void run()}>Break it down</Button>
    {error && <Hint tone="danger" role="alert" className="basis-full">{error}</Hint>}
  </>;
}

/**
 * Returning from Connect OpenRouter lands on /tasks?code=…&state=…: the server swaps the code for a key (the PKCE
 * verifier never left it), and the address is cleaned so a reload doesn't try again.
 */
function useOpenRouterReturn(state: AppState, beta: boolean) {
  const code = state.params.get('code');
  const returned = state.params.get('state');
  const [result, setResult] = useState<{ tone: 'neutral' | 'success' | 'danger'; text: string } | null>(null);
  const handled = useRef(false);
  useEffect(() => {
    if (!beta || !code || !returned || handled.current) return;
    handled.current = true;
    setResult({ tone: 'neutral', text: 'Connecting OpenRouter…' });
    state.navigate('tasks', undefined, { replace: true });
    api.ai.openRouterFinish.mutate({ accountId: state.context.user.id, code, state: returned })
      .then(() => setResult({ tone: 'success', text: 'OpenRouter is connected. AI now runs on your OpenRouter credits.' }), (err) => setResult({ tone: 'danger', text: errorMessage(err) }));
  }, [beta, code, returned, state]);
  if (!result) return null;
  return <Callout tone={result.tone} icon={result.tone === 'success' ? 'check' : result.tone === 'danger' ? 'alert' : 'sparkle'} role={result.tone === 'danger' ? 'alert' : 'status'}
    actions={result.tone !== 'neutral' ? <Button size="sm" variant="ghost" onClick={() => setResult(null)}>Dismiss</Button> : undefined}>{result.text}</Callout>;
}

/** The AI block in Account: what AI runs on, today's free quota, and the member's own key. */
export function AiSettings() {
  const beta = useBeta(AI_BETA);
  const account = useBetaAccount();
  const { status, setStatus, reload } = useAiStatus(beta);
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<'remove' | 'connect' | null>(null);
  const [error, setError] = useState('');
  if (!beta || !account) return null;
  const online = account.online;
  const remove = async () => {
    setPending('remove'); setError('');
    try { setStatus(await api.ai.removeKey.mutate({ accountId: account.accountId })); }
    catch (err) { setError(errorMessage(err)); }
    finally { setPending(null); }
  };
  const connect = async () => {
    setPending('connect'); setError('');
    try { const { url } = await api.ai.openRouterStart.mutate({ accountId: account.accountId }); window.location.assign(url); }
    catch (err) { setError(errorMessage(err)); setPending(null); }
  };
  const own = status?.beta ? status.own : null;
  return <div className="grid gap-3">
    <div className="grid gap-2 rounded-2xl bg-muted/80 p-3.5 ring-1 ring-inset ring-foreground/[0.04]">
      {!status ? <Hint>Loading…</Hint> : !status.beta ? null : own ? <div className="grid gap-0.5">
        <strong className="text-sm font-bold">{own.via === 'openrouter' ? 'Connected to OpenRouter' : `Your ${own.providerName} key`}</strong>
        <Hint>Key {own.hint} · model {own.model}. AI runs on your account, with no daily limit from Quasar.</Hint>
      </div> : status.chatgpt ? <div className="grid gap-0.5">
        <strong className="text-sm font-bold">Your ChatGPT plan</strong>
        <Hint>Owner testing: AI runs through Codex on the ChatGPT plan signed in on the server, with no daily limit from Quasar. Only your account uses it.</Hint>
      </div> : <div className="grid gap-0.5">
        <strong className="text-sm font-bold">{status.server ? status.plan === 'plus' ? 'Quasar AI Plus' : 'Quasar’s AI' : 'Not set up yet'}</strong>
        <Hint>{status.server
          ? `${status.plan === 'plus' ? 'Plus' : 'Free'} each day: ${Math.max(0, status.quota.sort.limit - status.quota.sort.used)} of ${status.quota.sort.limit} sorts and ${Math.max(0, status.quota.breakdown.limit - status.quota.breakdown.used)} of ${status.quota.breakdown.limit} breakdowns left. Use your own key for no limit.`
          : 'This server has no AI of its own. Add an API key or connect OpenRouter to use AI.'}</Hint>
      </div>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon="externalLink" busy={pending === 'connect'} disabled={!online || pending !== null} onClick={() => void connect()}>{own?.via === 'openrouter' ? 'Reconnect OpenRouter' : 'Connect OpenRouter'}</Button>
        <Button size="sm" icon="lock" disabled={!online || pending !== null} onClick={() => setAdding(true)}>{own?.via === 'key' ? 'Change key' : 'Use an API key'}</Button>
        {own && <Button size="sm" variant="ghost" busy={pending === 'remove'} disabled={!online || pending !== null} onClick={() => void remove()}>Remove</Button>}
      </div>
    </div>
    <PlusBlock online={online} accountId={account.accountId} onChanged={reload} />
    <Hint>In the AI beta, automatic sorting, duplicate checks and test-and-quiz checks send task titles, notes and due dates to the AI provider, including recently completed tasks for duplicate checks. Sorting and planning also use class names, teachers and your timetable. Manual AI tools send the tasks, photos or pasted text you submit. Automatic sorting can label tasks and duplicate checks can merge matching tasks; you can undo merges. The provider is configured by Quasar unless you add your own key or connect OpenRouter in Account. Saved keys are encrypted and never shown again.</Hint>
    {error && <Hint tone="danger" role="alert">{error}</Hint>}
    {!online && <Hint>Connect to the internet to change AI settings.</Hint>}
    {adding && <AiKeyModal accountId={account.accountId} onClose={() => setAdding(false)} onSaved={(next) => { setStatus(next); setAdding(false); }} />}
  </div>;
}

const money = (amount: number, currency: string) => new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: amount % 100 ? 2 : 0 }).format(amount / 100);
const shortDate = (iso: string) => formatDate(instantParts(iso, browserTimeZone()).date, { year: true });
/** What Plus adds, for the pitch in PlusBlock. */
const PLUS_FEATURES: Array<[string, string]> = [
  ['Plan my week', 'Study time for tests and big assignments, placed in your free periods and after school.'],
  ['Photo to tasks', 'Snap the board, a syllabus or a handout, and its assignments become tasks.'],
  ['Study sets', 'Flashcards and a practice quiz for a test, made from your notes or study guide.'],
  ['Crunch warnings', 'How long each task should take, and a heads-up before a heavy night.'],
  ['More AI every day', `${AI_PLUS_SORT_DAILY_LIMIT} sorts and ${AI_PLUS_BREAKDOWN_DAILY_LIMIT} breakdowns a day.`],
];

/** Quasar AI Plus (src/server/billing.ts) in Account → AI: get it through Stripe Checkout, or manage it in Stripe's portal. */
function PlusBlock({ accountId, online, onChanged }: { accountId: string; online: boolean; onChanged: () => unknown }) {
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  // The AI quota depends on the plan, so it is reloaded with it (`onChanged` is useAiStatus's stable reload).
  useEffect(() => { api.billing.status.query().then((next) => { setBilling(next); void onChanged(); }, () => setBilling(null)); }, [onChanged]);
  if (!billing?.enabled) return null;
  const go = async (key: string, open: () => Promise<{ url: string }>) => {
    setPending(key); setError('');
    try { window.location.assign((await open()).url); } catch (err) { setError(errorMessage(err)); setPending(null); }
  };
  const plus = billing.plan === 'plus';
  return <div className="grid gap-2 rounded-2xl bg-muted/80 p-3.5 ring-1 ring-inset ring-foreground/[0.04]">
    <div className="grid gap-0.5">
      <strong className="text-sm font-bold">{plus ? 'You have Plus' : 'Quasar AI Plus'}</strong>
      {plus && (billing.status === 'past_due' || billing.renewsAt) && <Hint>{billing.status === 'past_due' ? 'Your last payment didn’t go through. Update your card to keep Plus.'
        : `${billing.cancelAtPeriodEnd ? 'Ends' : 'Renews'} ${shortDate(billing.renewsAt!)}.`}</Hint>}
    </div>
    <ul className="grid gap-1 text-[13px]" aria-label={plus ? 'Included with Plus' : 'What Plus adds'}>
      {PLUS_FEATURES.map(([name, detail]) => <li key={name} className="flex items-start gap-2"><Icon name="check" size={14} className="mt-0.5 shrink-0 text-muted-foreground" /><span><strong className="font-semibold">{name}.</strong> <span className="text-muted-foreground">{detail}</span></span></li>)}
    </ul>
    {!plus && <Hint>The rest of Quasar stays free, and your own key always works.</Hint>}
    <div className="flex flex-wrap gap-2">
      {plus || billing.hasCustomer ? <Button size="sm" icon="settings" busy={pending === 'portal'} disabled={!online || pending !== null} onClick={() => void go('portal', () => api.billing.portal.mutate({ accountId }))}>{plus ? 'Manage billing' : 'Billing history'}</Button> : null}
      {!plus && billing.prices.map((price) => <Button key={price.interval} size="sm" variant={price.interval === 'month' ? 'primary' : 'secondary'} icon="sparkle" busy={pending === price.interval} disabled={!online || pending !== null}
        onClick={() => void go(price.interval, () => api.billing.checkout.mutate({ accountId, interval: price.interval }))}>
        {price.amount !== null ? `${money(price.amount, price.currency)} a ${price.interval}` : price.interval === 'month' ? 'Monthly' : 'Yearly'}</Button>)}
    </div>
    {!plus && <Hint>Payment is handled by Stripe. Cancel any time from Manage billing.</Hint>}
    {error && <Hint tone="danger" role="alert">{error}</Hint>}
  </div>;
}

function AiKeyModal({ accountId, onClose, onSaved }: { accountId: string; onClose: () => void; onSaved: (status: AiStatus) => void }) {
  const [provider, setProvider] = useState<AiProvider>('openai');
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const entry = AI_PROVIDERS[provider];
  const save = async () => {
    setPending(true); setError('');
    try { onSaved(await api.ai.setKey.mutate({ accountId, provider, key: key.trim(), ...(model.trim() ? { model: model.trim() } : {}) })); }
    catch (err) { setError(errorMessage(err)); setPending(false); }
  };
  return <Modal open onClose={onClose} busy={pending} dirty={key.length > 0} title="Use your own API key"
    description="AI requests run on your key and bill your account, with no daily limit from Quasar. Quasar checks the key with one tiny request before saving it."
    footer={<><Button variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button><Spacer /><Button variant="primary" form="ai-key-form" type="submit" busy={pending} disabled={key.trim().length < 8}>{pending ? 'Checking key…' : 'Save key'}</Button></>}>
    <form id="ai-key-form" className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <Field label="Provider" htmlFor="ai-provider"><Select id="ai-provider" value={provider} disabled={pending} onChange={(event) => { setProvider(event.target.value as AiProvider); setError(''); }}>
        {AI_PROVIDER_IDS.map((id) => <option key={id} value={id}>{AI_PROVIDERS[id].name}</option>)}
      </Select></Field>
      <Field label="API key" htmlFor="ai-key" hint={<a href={entry.keysPage} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold underline underline-offset-2">Get a key from {entry.name}<Icon name="externalLink" size={12} /></a>}>
        <Input id="ai-key" type="password" autoComplete="off" spellCheck={false} maxLength={500} value={key} disabled={pending} onChange={(event) => { setKey(event.target.value); setError(''); }} />
      </Field>
      <Field label="Model (optional)" htmlFor="ai-model" hint={`Leave empty for ${entry.model}.`}>
        <Input id="ai-model" autoComplete="off" spellCheck={false} maxLength={120} placeholder={entry.model} value={model} disabled={pending} onChange={(event) => { setModel(event.target.value); setError(''); }} />
      </Field>
      {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    </form>
  </Modal>;
}
