'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import { AI_BETA, AI_DEDUP_RECENT_DAYS } from '@/domain/ai';
import type { Task } from '@/domain/task';
import { MERGE_MAX, mergeTasks, pickKeep } from '@/domain/task-merge';
import { addDays, chatTime, classColor, formatTime, relativeDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { sortByDue, taskItems, type AppState, type TaskItem } from './app-state';
import { useBeta } from './betas';
import { Icon } from './icon';
import { Button, Callout, ColorDot, Hint, Input, Modal, Segmented, Select } from './primitives';
import { Checkbox } from './ui/checkbox';
import { MergeTaskDetails } from './merge-task-details';

/**
 * Tasks → Duplicates (src/server/merges.ts): merge tasks by hand (everyone), let the AI find duplicates (ai-tasks
 * beta), and the history of merges with Undo. In the beta, AiAutoDedup also checks a moment after new tasks arrive
 * and merges the ones the AI is sure of; whatever it merged is listed in the history like any other merge.
 */

type MergeEntry = RouterOutput['merges']['history'][number];
type Group = RouterOutput['ai']['duplicates']['groups'][number];
export type DuplicatesTab = 'find' | 'history';

/** What the automatic check did in this tab: merges to point out, and groups it wasn't sure enough to merge. */
type AutoDedupState = { merged: MergeEntry[]; groups: Group[]; error: string };
let autoDedup: AutoDedupState = { merged: [], groups: [], error: '' };
const listeners = new Set<() => void>();
const setAutoDedup = (next: Partial<AutoDedupState>) => { autoDedup = { ...autoDedup, ...next }; listeners.forEach((listener) => listener()); };
export const useAutoDedup = () => useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => autoDedup, () => autoDedup);
/** Longer than auto-sort's wait, so a calendar refresh that adds several tasks is one check. */
const AUTO_DEDUP_DELAY_MS = 4000;

/** One per signed-in app (tracker.tsx). The server only asks the model when a task is new or edited since its last check. */
export function AiAutoDedup({ state }: { state: AppState }) {
  const beta = useBeta(AI_BETA);
  const latest = useRef(state);
  latest.current = state;
  const key = useMemo(() => taskItems(state.snapshot.entities).map((item) => item.id).sort().join(','), [state.snapshot.entities]);
  const enabled = beta && state.online && state.snapshot.pending === 0;
  useEffect(() => {
    if (!enabled || !key) return;
    let cancelled = false;
    const timer = setTimeout(() => void (async () => {
      try {
        const result = await api.ai.duplicates.mutate({ accountId: latest.current.context.user.id, auto: true });
        if (cancelled || !result.checked) return;
        setAutoDedup({ merged: [...result.merged, ...autoDedup.merged], groups: result.groups, error: '' });
        if (result.merged.length) await latest.current.refresh();
      } catch (err) { if (!cancelled) setAutoDedup({ error: errorMessage(err) }); }
    })(), AUTO_DEDUP_DELAY_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [enabled, key]);
  return null;
}

/** Tasks that can be merged: open ones, and ones completed lately (a copy already checked off still has a twin). */
export function mergeCandidates(items: TaskItem[], today: string): TaskItem[] {
  const since = addDays(today, -AI_DEDUP_RECENT_DAYS);
  return sortByDue(items.filter((item) => !item.task.completed || (item.task.completedAt ?? '').slice(0, 10) >= since));
}

/** What a merge copies into the kept task, for the preview: "class, notes and 2 checklist steps". */
export function mergeSummary(keep: Task, merged: Task): string {
  const parts = [
    merged.classId !== keep.classId && 'class',
    merged.priority !== keep.priority && 'priority',
    merged.dueDate !== keep.dueDate && 'due date',
    merged.reminder !== keep.reminder && 'reminder',
    merged.notes !== keep.notes && 'notes',
    (merged.subtasks?.length ?? 0) > (keep.subtasks?.length ?? 0) && `${(merged.subtasks?.length ?? 0) - (keep.subtasks?.length ?? 0)} checklist ${(merged.subtasks?.length ?? 0) - (keep.subtasks?.length ?? 0) === 1 ? 'step' : 'steps'}`,
    merged.completed && !keep.completed && 'completion',
  ].filter((part): part is string => !!part);
  return parts.length === 0 ? '' : parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The note above Tasks after the automatic check merged or found something. */
export function DuplicatesBanner({ onReview }: { onReview: (tab: DuplicatesTab) => void }) {
  const beta = useBeta(AI_BETA);
  const { merged, groups } = useAutoDedup();
  const [seen, setSeen] = useState(0);
  const fresh = merged.length - seen;
  if (!beta) return null;
  return <>
    {fresh > 0 && <Callout tone="success" icon="sparkle" role="status" actions={<><Button size="sm" onClick={() => { setSeen(merged.length); onReview('history'); }}>Review</Button><Button size="sm" variant="ghost" onClick={() => setSeen(merged.length)}>Dismiss</Button></>}>
      AI merged {fresh === 1 ? `a duplicate of “${merged[0].kept.title}”` : `${fresh} duplicate tasks`}. You can undo it in Duplicates.
    </Callout>}
    {groups.length > 0 && <Callout tone="neutral" icon="layers" actions={<Button size="sm" onClick={() => onReview('find')}>Review</Button>}>
      AI found {groups.length === 1 ? 'a possible duplicate' : `${groups.length} possible duplicates`} it wasn’t sure enough to merge.
    </Callout>}
  </>;
}

export function DuplicatesSheet({ state, tab: initialTab, onClose }: { state: AppState; tab: DuplicatesTab; onClose: () => void }) {
  const beta = useBeta(AI_BETA);
  const accountId = state.context.user.id;
  const [tab, setTab] = useState<DuplicatesTab>(initialTab);
  const [history, setHistory] = useState<MergeEntry[] | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const auto = useAutoDedup();
  const [groups, setGroups] = useState<Group[]>(auto.groups);
  const [checked, setChecked] = useState(false);
  const items = useMemo(() => taskItems(state.snapshot.entities), [state.snapshot.entities]);
  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const loadHistory = useCallback(() => api.merges.history.query().then(setHistory, (err) => setError(errorMessage(err))), []);
  useEffect(() => { void loadHistory(); }, [loadHistory]);

  /** Resolves whether the action worked; its error shows at the top of the sheet. */
  const run = async (key: string, action: () => Promise<string | void>): Promise<boolean> => {
    setPending(key); setError(''); setNote('');
    try { const message = await action(); if (message) setNote(message); return true; }
    catch (err) { setError(errorMessage(err)); return false; }
    finally { setPending(null); }
  };
  const merge = (key: string, keepId: string, ids: string[], reason?: string) => run(key, async () => {
    await api.merges.merge.mutate({ accountId, keepId, removeIds: ids.filter((id) => id !== keepId), ...(reason ? { reason } : {}) });
    await state.refresh();
    void loadHistory();
    setGroups((current) => current.filter((group) => !group.ids.includes(keepId)));
    setAutoDedup({ groups: autoDedup.groups.filter((group) => !group.ids.includes(keepId)) });
    return `Merged into “${byId.get(keepId)?.task.title ?? 'the kept task'}”. Undo it under History.`;
  });
  const apart = (group: Group) => run(`apart-${group.ids.join()}`, async () => {
    await api.merges.notDuplicates.mutate({ accountId, ids: group.ids });
    setGroups((current) => current.filter((entry) => entry !== group));
    setAutoDedup({ groups: autoDedup.groups.filter((entry) => entry.ids.join() !== group.ids.join()) });
  });
  const check = () => run('check', async () => {
    const result = await api.ai.duplicates.mutate({ accountId, auto: false });
    setGroups(result.groups); setChecked(true);
  });
  const undo = (entry: MergeEntry) => run(`undo-${entry.id}`, async () => {
    const result = await api.merges.undo.mutate({ accountId, id: entry.id });
    await state.refresh();
    void loadHistory();
    const parts = [result.restored ? `Put back ${result.restored === 1 ? '1 task' : `${result.restored} tasks`}.` : '',
      result.skipped ? `${result.skipped === 1 ? '1 task was' : `${result.skipped} tasks were`} already back or changed, so ${result.skipped === 1 ? 'it was' : 'they were'} left alone.` : '',
      result.keptChanged ? `“${entry.kept.title}” changed after the merge, so it keeps your later edits.` : ''];
    return parts.filter(Boolean).join(' ') || 'Undone.';
  });

  // Groups whose tasks are all still here: a task merged or deleted since drops its group.
  const live = groups.filter((group) => group.ids.every((id) => byId.has(id)));
  return <Modal open onClose={onClose} busy={pending !== null} wide title="Duplicates"
    description="Merge copies of the same assignment into one task. Notes and checklist steps are combined. History shows the original copies and lets you undo a merge."
    footer={<Button variant="ghost" className="ml-auto" onClick={onClose}>Done</Button>}>
    <Segmented label="Duplicates" value={tab} onChange={setTab} options={[{ value: 'find', label: 'Find' }, { value: 'history', label: `History${history?.length ? ` · ${history.length}` : ''}` }]} />
    {note && <Callout tone="success" icon="check" role="status">{note}</Callout>}
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    {tab === 'find' && <div className="grid gap-5">
      {beta && <section className="grid gap-2.5" aria-labelledby="dupes-ai">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="grid gap-0.5"><h3 id="dupes-ai" className="text-sm font-bold">Found by AI</h3>
            <Hint>New tasks are checked automatically. The AI merges only the ones it’s sure of; the rest wait here.</Hint></div>
          <Button size="sm" icon="sparkle" busy={pending === 'check'} disabled={!state.online || pending !== null} onClick={() => void check()}>Check with AI</Button>
        </div>
        {live.length === 0 ? <Hint>{checked ? 'No duplicates found.' : 'Nothing waiting.'}</Hint>
          : <ul className="grid gap-2" aria-label="Possible duplicates">{live.map((group) => <AiGroup key={group.ids.join()} group={group} state={state} byId={byId} pending={pending}
            onMerge={(keepId) => void merge(`merge-${group.ids.join()}`, keepId, group.ids, group.reason)} onApart={() => void apart(group)} />)}</ul>}
      </section>}
      <ManualMerge state={state} items={items} pending={pending} onMerge={(keepId, ids) => merge('manual', keepId, ids)} />
    </div>}
    {tab === 'history' && (history === null ? <Hint>Loading…</Hint> : history.length === 0 ? <Hint>No merges yet.</Hint>
      : <ul className="grid gap-3" aria-label="Merge history">{history.map(entry => <MergeHistoryItem key={entry.id} entry={entry} state={state} pending={pending} onUndo={() => void undo(entry)} />)}</ul>)}
  </Modal>;
}

const originLabel = (task: Pick<MergeEntry['kept'], 'origin'>) => task.origin === 'calendar' ? 'Calendar import' : task.origin === 'schoology' ? 'Schoology import' : 'Quasar task';

function MergeHistoryItem({ entry, state, pending, onUndo }: { entry: MergeEntry; state: AppState; pending: string | null; onUndo: () => void }) {
  const [expanded, setExpanded] = useState(false);
  return <li className="grid min-w-0 gap-4 rounded-2xl bg-muted/60 p-4 ring-1 ring-inset ring-foreground/[0.04]">
    <div className="flex items-start gap-3">
      <Icon name={entry.source === 'ai' ? 'sparkle' : 'layers'} size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <span className="text-[14px] font-semibold leading-snug">{entry.source === 'ai' ? 'AI automatically merged' : 'You merged'} {entry.removed.length + 1} tasks</span>
        <Hint>{chatTime(entry.createdAt, state.timeZone, state.now)}{entry.undoneAt ? ' · Undone' : ''}</Hint>
      </div>
      {!entry.undoneAt && <Button size="sm" variant="ghost" icon="refresh" busy={pending === `undo-${entry.id}`} disabled={!state.online || pending !== null} onClick={onUndo}>Undo<span className="sr-only">: {entry.kept.title}</span></Button>}
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <HistoryTask label="Kept" task={entry.kept} state={state} />
      {entry.removed.map(task => <HistoryTask key={task.id} label="Removed duplicate" task={task} state={state} />)}
    </div>
    {entry.reason && <div className="grid gap-0.5">
      <span className="text-xs font-semibold">{entry.source === 'ai' ? 'Why AI merged them' : 'Reason for merging'}</span>
      <Hint className="break-words">{entry.reason}</Hint>
    </div>}
    <Button size="sm" variant="ghost" className="justify-self-start" aria-expanded={expanded} aria-controls={`merge-details-${entry.id}`} onClick={() => setExpanded(!expanded)}>{expanded ? 'Hide full details' : 'View full details'}</Button>
    {expanded && <div id={`merge-details-${entry.id}`} className="grid min-w-0 gap-4 border-t pt-4">
      <div className="grid gap-1"><h3 className="text-sm font-bold">Current task</h3><Hint>Includes any edits made after this merge. Changed fields are compared with the original kept copy.</Hint></div>
      {entry.current ? <MergeTaskDetails label="Current kept task" task={entry.current.details} origin={originLabel(entry.current)} state={state} previous={entry.kept.details} /> : <Hint>The kept task has since been deleted.</Hint>}
      <div className="grid gap-1"><h3 className="text-sm font-bold">Before the merge</h3><Hint>The original copies, exactly as they were saved.</Hint></div>
      <div className="grid min-w-0 items-start gap-3 sm:grid-cols-2">
        <MergeTaskDetails label="Original kept copy" task={entry.kept.details} origin={originLabel(entry.kept)} state={state} />
        {entry.removed.map((task, index) => <MergeTaskDetails key={task.id} label={`Original removed copy${entry.removed.length > 1 ? ` ${index + 1}` : ''}`} task={task.details} origin={originLabel(task)} state={state} />)}
      </div>
    </div>}
  </li>;
}

function HistoryTask({ label, task, state }: { label: string; task: MergeEntry['removed'][number]; state: AppState }) {
  const cls = state.personal.classes.find(entry => entry.id === task.classId);
  const origin = task.origin === 'calendar' ? 'Calendar import' : task.origin === 'schoology' ? 'Schoology import' : 'Quasar task';
  return <div className="grid min-w-0 gap-0.5">
    <span className="text-xs font-semibold text-muted-foreground">{label}</span>
    <span className="break-words text-[14px] font-semibold leading-snug">{task.title}</span>
    <Hint className="break-words">{origin} · {cls?.name ?? (task.classId ? 'Class no longer available' : 'No class')} · {task.dueDate ? `Due ${relativeDate(task.dueDate, state.today)}${task.dueTime ? ` at ${formatTime(task.dueTime)}` : ''}` : 'No due date'}</Hint>
  </div>;
}

function TaskLine({ item, state }: { item: TaskItem; state: AppState }) {
  const { task } = item;
  const cls = state.personal.classes.find((entry) => entry.id === task.classId);
  return <span className="grid min-w-0 gap-0.5">
    <span className={cn('line-clamp-2 text-[14px] font-semibold leading-snug', task.completed && 'line-through text-muted-foreground')}>{task.title}</span>
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs font-medium text-muted-foreground">
      <span>{task.dueDate ? relativeDate(task.dueDate, state.today) : 'No date'}</span>
      {cls && <span className="inline-flex items-center gap-1.5"><ColorDot color={classColor(cls.id, 'class', cls.color).dot} size={8} />{cls.name}</span>}
      {task.imported && <span className="inline-flex items-center gap-1"><Icon name="calendar" size={11} strokeWidth={2.4} />Calendar</span>}
      {task.completed && <span>Done</span>}
    </span>
  </span>;
}

function AiGroup({ group, state, byId, pending, onMerge, onApart }: { group: Group; state: AppState; byId: Map<string, TaskItem>; pending: string | null; onMerge: (keepId: string) => void; onApart: () => void }) {
  const [keepId, setKeepId] = useState(group.keepId);
  const members = group.ids.map((id) => byId.get(id)!);
  return <li className="grid gap-2 rounded-2xl bg-muted/60 p-3 ring-1 ring-inset ring-foreground/[0.04]">
    {group.reason && <Hint>{group.reason}</Hint>}
    <ul className="grid gap-1">{members.map((item) => <li key={item.id} className="flex items-start justify-between gap-3 rounded-xl bg-card px-3 py-2">
      <TaskLine item={item} state={state} />
      {item.id === keepId ? <span className="shrink-0 rounded-md bg-primary-soft px-1.5 py-0.5 text-xs font-bold text-primary-soft-foreground">Keep</span>
        : <Button size="sm" variant="ghost" className="shrink-0" onClick={() => setKeepId(item.id)}>Keep this<span className="sr-only">: {item.task.title}</span></Button>}
    </li>)}</ul>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="primary" busy={pending === `merge-${group.ids.join()}`} disabled={!state.online || pending !== null} onClick={() => onMerge(keepId)}>Merge</Button>
      <Button size="sm" variant="ghost" disabled={!state.online || pending !== null} onClick={onApart}>Not duplicates</Button>
    </div>
  </li>;
}

function ManualMerge({ state, items, pending, onMerge }: { state: AppState; items: TaskItem[]; pending: string | null; onMerge: (keepId: string, ids: string[]) => Promise<boolean> }) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [keepChoice, setKeepChoice] = useState<string | null>(null);
  const candidates = useMemo(() => mergeCandidates(items, state.today), [items, state.today]);
  const chosen = picked.map((id) => candidates.find((item) => item.id === id)).filter((item): item is TaskItem => !!item);
  const keep = chosen.find((item) => item.id === keepChoice) ?? (chosen.length ? pickKeep(chosen) : null);
  const others = chosen.filter((item) => item !== keep);
  const summary = keep && others.length ? mergeSummary(keep.task, mergeTasks(keep.task, others.map((item) => item.task))) : '';
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  // Picked tasks stay listed while the search changes.
  const shown = candidates.filter((item) => picked.includes(item.id) || words.every((word) => item.task.title.toLowerCase().includes(word))).slice(0, 60);
  const toggle = (id: string, on: boolean) => setPicked((current) => on ? [...current, id].slice(0, MERGE_MAX) : current.filter((entry) => entry !== id));
  return <section className="grid gap-2.5" aria-labelledby="dupes-manual">
    <div className="grid gap-0.5"><h3 id="dupes-manual" className="text-sm font-bold">Merge tasks yourself</h3><Hint>Pick the copies of one assignment.</Hint></div>
    <div className="relative">
      <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
      <Input small aria-label="Search tasks" placeholder="Search tasks" value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" />
    </div>
    <ul className="grid max-h-72 gap-0.5 overflow-y-auto rounded-2xl bg-muted/60 p-1.5 ring-1 ring-inset ring-foreground/[0.04]" aria-label="Tasks to merge">
      {shown.length === 0 && <li className="px-2 py-3"><Hint>No matching tasks.</Hint></li>}
      {shown.map((item) => {
        const id = `merge-pick-${item.id}`;
        const on = picked.includes(item.id);
        return <li key={item.id} className="flex items-start gap-3 rounded-xl px-2 py-2 hover:bg-card">
          <Checkbox id={id} className="mt-0.5 size-5 rounded-full [&_svg]:size-3.5" checked={on} disabled={!on && picked.length >= MERGE_MAX} onCheckedChange={(value) => toggle(item.id, value === true)} />
          <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer"><TaskLine item={item} state={state} /></label>
        </li>;
      })}
    </ul>
    {chosen.length >= 2 && keep && <div className="grid gap-2.5 rounded-2xl bg-muted/60 p-3 ring-1 ring-inset ring-foreground/[0.04]">
      <div className="flex flex-wrap items-center gap-2 text-sm"><label htmlFor="merge-keep" className="font-semibold">Keep</label>
        <Select id="merge-keep" small className="w-auto max-w-full" value={keep.id} onChange={(event) => setKeepChoice(event.target.value)}>
          {chosen.map((item) => <option key={item.id} value={item.id}>{item.task.title}{item.task.imported ? ' (calendar)' : ''}</option>)}
        </Select></div>
      <Hint>{others.length === 1 ? 'The other task is' : `The other ${others.length} tasks are`} deleted.{summary ? ` Copied over: ${summary}.` : ''}{keep.task.imported ? ' The kept task keeps updating from its calendar.' : ''}</Hint>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" busy={pending === 'manual'} disabled={!state.online || pending !== null} onClick={() => void onMerge(keep.id, chosen.map((item) => item.id)).then((merged) => { if (merged) { setPicked([]); setKeepChoice(null); } })}>Merge {chosen.length} tasks</Button>
        <Button size="sm" variant="ghost" disabled={pending !== null} onClick={() => { setPicked([]); setKeepChoice(null); }}>Clear</Button>
      </div>
    </div>}
    {!state.online && <Hint>Connect to the internet to merge tasks.</Hint>}
  </section>;
}
