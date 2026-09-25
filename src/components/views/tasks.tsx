'use client';

import { useEffect, useMemo, useState } from 'react';
import { errorMessage } from '@/client/api';
import { FIRST_DATE, LAST_DATE } from '@/domain/schedule';
import { taskSchema, type Task } from '@/domain/task';
import { addDays, classColor, daysBetween, formatTime, formatTimeZone, reminderLabel } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AppState, TaskItem } from '../app-state';
import { clockTime, isOverdue, sortByDue, taskItems } from '../app-state';
import { ChangedWhileEditing, taskFields } from '../conflicts';
import { Icon } from '../icon';
import { Button, Callout, ColorDot, EmptyState, Eyebrow, Field, Hint, Input, Modal, PageHeader, Select, Spacer, Textarea } from '../primitives';
import { buttonVariants } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Label } from '../ui/label';
import { Toggle } from '../ui/toggle';
import { QuickAdd, TaskRow, useCompletionUndo } from './today';

const emptyTask: Task = { title: '', dueDate: null, dueTime: null, classId: null, notes: '', completed: false };

const COMPLETED_PAGE = 50;

/** Reminder lead times the editor offers, in minutes; a saved value outside the list is added as its own option. */
const REMINDER_CHOICES = [0, 10, 30, 60, 1440];

/**
 * The hint for a date-only task's reminder, or '' when no reminder is chosen. The server counts reminders from
 * 9:00 AM and then subtracts the lead time (reminderInstant in src/server/notifications.ts), so only "At due time"
 * arrives at 9:00 AM itself. The wording stays about reminders: the task itself is not overdue until the day ends.
 */
export function dateOnlyReminderNote(minutesBefore?: number): string {
  if (minutesBefore === undefined) return '';
  const base = 'With no due time, reminders count from 9:00 AM';
  const total = 9 * 60 - minutesBefore;
  const daysBefore = -Math.floor(total / 1440);
  const minutes = ((total % 1440) + 1440) % 1440;
  const time = formatTime(`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`);
  const day = daysBefore === 0 ? '' : daysBefore === 1 ? ' the day before' : ` ${daysBefore} days before`;
  return `${base}, so this reminder comes at ${time}${day}.`;
}

/** Checklist items left blank (or only spaces) are dropped on save instead of failing the whole form. */
export function withoutBlankSubtasks(task: Task): Task {
  return task.subtasks ? { ...task, subtasks: task.subtasks.filter((item) => item.title.trim() !== '') } : task;
}

const GROUP_TONES: Record<string, string> = { Overdue: 'bg-destructive', Today: 'bg-primary', Tomorrow: 'bg-now', 'Next 7 days': 'bg-success', Later: 'bg-muted-foreground/60', 'No due date': 'bg-muted-foreground/40' };

export function TasksView({ state }: { state: AppState }) {
  const items = useMemo(() => taskItems(state.snapshot.entities), [state.snapshot.entities]);
  const open = useMemo(() => sortByDue(items.filter((item) => !item.task.completed)), [items]);
  // Most recently completed first. Tasks completed before completedAt existed have no stamp and follow, newest edits first.
  const completed = useMemo(() => items.filter((item) => item.task.completed).sort((left, right) =>
    (right.task.completedAt ?? '').localeCompare(left.task.completedAt ?? '') || right.entity.version - left.entity.version), [items]);
  const [completedShown, setCompletedShown] = useState(COMPLETED_PAGE);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [classFilter, setClassFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [sort, setSort] = useState('due');
  const editParam = state.params.get('edit');
  const { onComplete, undoBar } = useCompletionUndo(state);
  useEffect(() => { if (editParam) { setEditing(editParam); state.navigate('tasks', undefined, { replace: true }); } }, [editParam, state]);

  const filtered = open.filter((item) => (!classFilter || item.task.classId === classFilter) && (!priorityFilter || (item.task.priority ?? 'normal') === priorityFilter));
  if (sort === 'priority') { const rank = { high: 0, normal: 1, low: 2 }; filtered.sort((a, b) => rank[a.task.priority ?? 'normal'] - rank[b.task.priority ?? 'normal']); }
  // One overdue rule for the header, the groups and each row: a due time earlier today counts too.
  const nowTime = clockTime(state.now, state.timeZone);
  const late = (item: TaskItem) => isOverdue(item.task, state.today, nowTime);
  const groups: Array<{ title: string; items: TaskItem[] }> = [
    { title: 'Overdue', items: filtered.filter(late) },
    { title: 'Today', items: filtered.filter((item) => item.task.dueDate === state.today && !late(item)) },
    { title: 'Tomorrow', items: filtered.filter((item) => item.task.dueDate && daysBetween(state.today, item.task.dueDate) === 1) },
    { title: 'Next 7 days', items: filtered.filter((item) => item.task.dueDate && daysBetween(state.today, item.task.dueDate) > 1 && daysBetween(state.today, item.task.dueDate) <= 7) },
    { title: 'Later', items: filtered.filter((item) => item.task.dueDate && daysBetween(state.today, item.task.dueDate) > 7) },
    { title: 'No due date', items: filtered.filter((item) => !item.task.dueDate) },
  ].filter((group) => group.items.length > 0);
  const current = editing && editing !== 'new' ? items.find((item) => item.id === editing) : undefined;
  const overdue = open.filter(late).length;
  const filterToggle = 'h-9 shrink-0 gap-1.5 pointer-coarse:h-10 rounded-full bg-card px-3 text-[13px] font-semibold shadow-card ring-1 ring-foreground/[0.06] hover:bg-muted data-[state=on]:bg-foreground data-[state=on]:text-background data-[state=on]:ring-foreground';

  return <div className="grid grid-cols-[minmax(0,1fr)] gap-5 animate-in fade-in-0 duration-300">
    <PageHeader title="Tasks" eyebrow="To do" description={open.length === 0 ? 'Nothing open. Nice.' : `${open.length} open${overdue ? ` · ${overdue} overdue` : ''}${completed.length > 0 ? ` · ${completed.length} done` : ''}`}
      actions={<Button variant="primary" icon="plus" onClick={() => setEditing('new')}>New task</Button>} />
    <QuickAdd today={state.today} classes={state.personal.classes} onAdd={(title, extra) => state.saveTask(crypto.randomUUID(), { ...emptyTask, title, dueDate: extra.dueDate ?? null, classId: extra.classId ?? null })} />
    {undoBar}
    {(open.length > 0 || classFilter || priorityFilter) && <div className="relative flex flex-wrap items-center gap-x-4 gap-y-2.5 max-sm:-mx-4 max-sm:-my-1 max-sm:flex-nowrap max-sm:gap-x-3 max-sm:overflow-x-auto max-sm:px-4 max-sm:py-1 max-sm:[scrollbar-width:none]">
      {/* On phones the class chips and the two selects share one sideways-scrolling row, however many classes there are.
          `relative` keeps each Select's hidden native <select> inside the scroller; otherwise it widens the page on phones. */}
      {state.personal.classes.length > 0 && <div className="flex flex-wrap gap-1.5 max-sm:shrink-0 max-sm:flex-nowrap" role="group" aria-label="Filter by class">
        <Toggle pressed={classFilter === ''} onPressedChange={() => setClassFilter('')} className={filterToggle}>All</Toggle>
        {state.personal.classes.map((cls) => <Toggle key={cls.id} pressed={classFilter === cls.id} onPressedChange={() => setClassFilter(classFilter === cls.id ? '' : cls.id)} className={filterToggle}><ColorDot color={classColor(cls.id, 'class', cls.color).dot} size={8} />{cls.name}</Toggle>)}
      </div>}
      <div className="ml-auto flex flex-wrap items-center gap-2 max-sm:ml-0 max-sm:shrink-0 max-sm:flex-nowrap">
        <label className="sr-only" htmlFor="priority-filter">Priority</label>
        <Select id="priority-filter" small className="w-auto shrink-0" value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)}><option value="">All priorities</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></Select>
        <label className="sr-only" htmlFor="task-sort">Sort within each group</label>
        <Select id="task-sort" small className="w-auto shrink-0" value={sort} onChange={(event) => setSort(event.target.value)}><option value="due">Sort by due time</option><option value="priority">Sort by priority</option></Select>
      </div>
    </div>}
    {groups.length === 0 && <Card><EmptyState icon="checkCircle" title={classFilter || priorityFilter ? 'No matching open tasks' : 'All clear'} action={!(classFilter || priorityFilter) ? <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>Add a task</Button> : <Button onClick={() => { setClassFilter(''); setPriorityFilter(''); }}>Clear filters</Button>}>{classFilter || priorityFilter ? 'Try another filter or add a task.' : 'Add homework, forms, practice, anything you need to remember.'}</EmptyState></Card>}
    {groups.map((group) => <Card key={group.title} className="gap-1 py-3" role="region" aria-labelledby={`group-${group.title}`}>
      <CardContent className="grid gap-1 px-2 sm:px-3">
        <h2 id={`group-${group.title}`} className={cn('flex items-center gap-2 px-2.5 pt-1 text-[12px] font-extrabold uppercase tracking-[0.1em] text-muted-foreground', group.title === 'Overdue' && 'text-destructive')}>
          <span aria-hidden="true" className={cn('size-2 rounded-full', GROUP_TONES[group.title])} />
          {group.title} <span className="font-semibold text-muted-foreground/70">· {group.items.length}</span>
        </h2>
        <ul className="grid gap-0.5">{group.items.map((item) => <TaskRow key={item.id} item={item} state={state} onComplete={onComplete} showDate={group.title !== 'Today' && group.title !== 'Tomorrow'} />)}</ul>
      </CardContent>
    </Card>)}
    {completed.length > 0 && <Card className="gap-1 py-3">
      <CardContent className="grid gap-1 px-2 sm:px-3">
        {/* The disclosure button sits inside the heading: a button's children are presentational, so an h2 inside it would drop out of heading navigation. */}
        <h2><button type="button" className="flex w-full items-center justify-between rounded-xl px-2.5 py-1.5 text-left hover:bg-muted" aria-expanded={showCompleted} onClick={() => setShowCompleted(!showCompleted)}>
          <span className="flex items-center gap-2 text-[12px] font-extrabold uppercase tracking-[0.1em] text-muted-foreground"><Icon name="checkCircle" size={13} className="text-success" />Completed · {completed.length}</span>
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground">{showCompleted ? 'Hide' : 'Show'}<Icon name="chevronDown" size={14} className={cn('transition-transform', showCompleted && 'rotate-180')} /></span>
        </button></h2>
        {showCompleted && <ul className="mt-1 grid gap-0.5">{completed.slice(0, completedShown).map((item) => <TaskRow key={item.id} item={item} state={state} />)}</ul>}
        {showCompleted && completed.length > completedShown && <div className="px-1 pt-1"><Button size="sm" variant="ghost" onClick={() => setCompletedShown(completedShown + COMPLETED_PAGE)}>Show more · {completed.length - completedShown} older hidden</Button></div>}
      </CardContent>
    </Card>}
    <TaskSheet key={editing ?? 'closed'} open={editing !== null} onClose={() => setEditing(null)} initial={editing === 'new' ? emptyTask : current?.task ?? null} current={editing === 'new' ? undefined : current?.task ?? null} classes={state.personal.classes} today={state.today} timeZone={state.timeZone}
      onSave={async (task) => { await state.saveTask(editing === 'new' || !editing ? crypto.randomUUID() : editing, task); setEditing(null); }}
      onDelete={editing && editing !== 'new' ? async () => { await state.saveTask(editing, null); setEditing(null); } : undefined} />
  </div>;
}

function FormGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="grid gap-3 rounded-2xl bg-muted/60 p-4 ring-1 ring-inset ring-foreground/[0.04]">
    <Eyebrow>{title}</Eyebrow>
    {children}
  </div>;
}

export function TaskSheet({ open, onClose, initial, current, classes, today, timeZone, onSave, onDelete }: { open: boolean; onClose: () => void; initial: Task | null; current?: Task | null; classes: Array<{ id: string; name: string; color?: string }>; today: string; timeZone: string; onSave: (task: Task) => Promise<void>; onDelete?: () => Promise<void> }) {
  const [original, setOriginal] = useState<Task>(initial ?? emptyTask);
  const [draft, setDraft] = useState<Task>(original);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const serialized = JSON.stringify(current);
  const [acknowledged, setAcknowledged] = useState(serialized);
  const changed = current !== undefined && serialized !== acknowledged;
  const isNew = current === undefined;
  // Decided once per opening (the sheet is keyed by the task): a task deleted while the form is open keeps the draft and shows ChangedWhileEditing.
  const [missingAtOpen] = useState(open && initial === null && !isNew);
  const deleted = current === null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(original);
  const run = async (action: () => Promise<void>) => { setPending(true); setError(''); try { await action(); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); } };
  // The in-place confirmation for deleting the task (docs/CHAT.md §Dialogs: no native confirm()).
  const [deleting, setDeleting] = useState(false);
  if (open && missingAtOpen) return <Modal open onClose={onClose} title="Task not found"><p className="text-sm text-muted-foreground">This task was deleted.</p></Modal>;
  const quick = [{ label: 'Today', offset: 0 }, { label: 'Tomorrow', offset: 1 }, { label: 'In 2 days', offset: 2 }, { label: 'Next week', offset: 7 }];
  // An imported due time is written in its calendar's zone, so its reminder counts from that zone. Overdue checks
  // still use the school's zone; the calendar zone defaults to it (FeedSubscribeForm), which keeps the two aligned.
  const newReminderZone = draft.imported?.timeZone ?? timeZone;
  const reminderZone = formatTimeZone(draft.reminder?.timeZone ?? newReminderZone);
  return <Modal open={open} onClose={onClose} dirty={dirty} busy={pending} title={isNew ? 'New task' : 'Edit task'}
    footer={<>{onDelete && !deleted && <Button variant="danger" disabled={pending || changed} onClick={() => setDeleting(true)}>Delete</Button>}<Spacer /><Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button><Button variant="primary" form="task-form" type="submit" busy={pending} disabled={changed || !draft.title.trim()}>{isNew || deleted ? 'Add task' : 'Save'}</Button></>}>
    <form id="task-form" className="grid gap-4" onSubmit={(event) => { event.preventDefault(); if (!changed) void run(() => onSave(taskSchema.parse(withoutBlankSubtasks({ ...draft, title: draft.title.trim() })))); }}>
      <Field label="Task" htmlFor="task-title"><Input id="task-title" autoFocus={isNew} required maxLength={300} value={draft.title} placeholder="What needs to get done?" className="h-12 text-[17px] font-semibold" onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></Field>
      <FormGroup title="When">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Due date" htmlFor="task-date"><Input id="task-date" type="date" min={FIRST_DATE} max={LAST_DATE} value={draft.dueDate ?? ''} onChange={(event) => setDraft({ ...draft, dueDate: event.target.value || null, dueTime: event.target.value ? draft.dueTime : null, recurrence: event.target.value ? (draft.recurrence ? { ...draft.recurrence, anchorDate: event.target.value } : draft.recurrence) : null, reminder: event.target.value ? draft.reminder : null })} /></Field>
          <Field label="Due time" htmlFor="task-time" hint={!draft.dueDate ? 'Pick a date first' : undefined}><Input id="task-time" type="time" disabled={!draft.dueDate} value={draft.dueTime ?? ''} onChange={(event) => setDraft({ ...draft, dueTime: event.target.value || null })} /></Field>
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick due dates">
          {quick.map((entry) => {
            const date = addDays(today, entry.offset);
            return <Button key={entry.offset} size="sm" variant={draft.dueDate === date ? 'primary' : 'secondary'} aria-pressed={draft.dueDate === date} className="rounded-full" onClick={() => setDraft({ ...draft, dueDate: date, ...(draft.recurrence ? { recurrence: { ...draft.recurrence, anchorDate: date } } : {}) })}>{entry.label}</Button>;
          })}
          {draft.dueDate && <Button size="sm" variant="ghost" className="rounded-full" onClick={() => setDraft({ ...draft, dueDate: null, dueTime: null, recurrence: null, reminder: null })}>No date</Button>}
        </div>
      </FormGroup>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Class" htmlFor="task-class"><Select id="task-class" value={draft.classId ?? ''} onChange={(event) => setDraft({ ...draft, classId: event.target.value || null })}><option value="">No class</option>{classes.map((cls) => <option key={cls.id} value={cls.id}>{cls.name}</option>)}{draft.classId && !classes.some((cls) => cls.id === draft.classId) && <option value={draft.classId}>Removed class</option>}</Select></Field>
        <Field label="Priority" htmlFor="task-priority"><Select id="task-priority" value={draft.priority ?? 'normal'} onChange={(event) => setDraft({ ...draft, priority: event.target.value as Task['priority'] })}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></Select></Field>
      </div>
      {draft.imported && <Callout tone="neutral" icon="calendar" actions={draft.imported.url ? <a href={draft.imported.url} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}><Icon name="externalLink" />Open link</a> : undefined}>Imported calendar event{draft.imported.sourceRemoved ? ' · Removed from its source; your task is kept.' : '. Calendar updates keep your completion and checklist.'}</Callout>}
      <fieldset className="grid gap-2 rounded-2xl bg-muted/60 p-4 ring-1 ring-inset ring-foreground/[0.04]"><legend className="sr-only">Checklist</legend>
        <div className="flex items-center justify-between gap-2"><Eyebrow>Checklist{draft.subtasks?.length ? ` · ${draft.subtasks.filter((entry) => entry.completed).length}/${draft.subtasks.length}` : ''}</Eyebrow>
          <Button size="sm" variant="ghost" icon="plus" disabled={(draft.subtasks?.length ?? 0) >= 100} onClick={() => setDraft({ ...draft, subtasks: [...(draft.subtasks ?? []), { id: crypto.randomUUID(), title: '', completed: false }] })}>Add checklist item</Button></div>
        {(draft.subtasks ?? []).map((item, index) => <div key={item.id} className="flex items-center gap-2">
          <Checkbox className="size-5 rounded-full [&_svg]:size-3.5" checked={item.completed} aria-label={`Complete checklist item ${index + 1}`} onCheckedChange={(checked) => setDraft({ ...draft, subtasks: draft.subtasks!.map(entry => entry.id === item.id ? { ...entry, completed: checked === true } : entry) })} />
          <Input small aria-label={`Checklist item ${index + 1}`} maxLength={300} value={item.title} placeholder="Step" className={cn('h-9', item.completed && 'line-through text-muted-foreground')} onChange={(event) => setDraft({ ...draft, subtasks: draft.subtasks!.map(entry => entry.id === item.id ? { ...entry, title: event.target.value } : entry) })} />
          <Button size="sm" variant="ghost" icon="x" aria-label={`Remove checklist item ${index + 1}`} onClick={() => setDraft({ ...draft, subtasks: draft.subtasks!.filter(entry => entry.id !== item.id) })} />
        </div>)}
        {!draft.subtasks?.length && <Hint>Break the task into steps you can tick off.</Hint>}
      </fieldset>
      <FormGroup title="Repeat and remind">
        {!draft.imported && <Field label="Repeat" htmlFor="task-repeat" hint={!draft.dueDate ? 'Pick a due date first' : 'Completing this task creates the next occurrence after syncing.'}><Select id="task-repeat" disabled={!draft.dueDate} value={draft.recurrence?.frequency ?? ''} onChange={(event) => setDraft({ ...draft, recurrence: event.target.value ? { frequency: event.target.value as NonNullable<Task['recurrence']>['frequency'], interval: draft.recurrence?.interval ?? 1, until: draft.recurrence?.until ?? null, anchorDate: draft.dueDate! } : null })}><option value="">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></Select></Field>}
        {draft.recurrence && <div className="grid gap-3 sm:grid-cols-2"><Field label={`Every (${draft.recurrence.frequency === 'daily' ? 'days' : draft.recurrence.frequency === 'weekly' ? 'weeks' : 'months'})`} htmlFor="task-interval"><Input id="task-interval" type="number" min={1} max={365} required value={draft.recurrence.interval} onChange={(event) => setDraft({ ...draft, recurrence: { ...draft.recurrence!, interval: Number(event.target.value) } })} /></Field><Field label="Repeat until (optional)" htmlFor="task-until"><Input id="task-until" type="date" min={draft.dueDate ?? FIRST_DATE} max={LAST_DATE} value={draft.recurrence.until ?? ''} onChange={(event) => setDraft({ ...draft, recurrence: { ...draft.recurrence!, until: event.target.value || null } })} /></Field></div>}
        <Field label="Reminder" htmlFor="task-reminder" hint={draft.dueDate ? `Reminders use ${reminderZone}.${!draft.dueTime && draft.reminder ? ` ${dateOnlyReminderNote(draft.reminder.minutesBefore)}` : ''} Turn on notifications in Account.` : 'Pick a due date first'}><Select id="task-reminder" disabled={!draft.dueDate} value={draft.reminder ? String(draft.reminder.minutesBefore) : ''} onChange={(event) => setDraft({ ...draft, reminder: event.target.value !== '' ? { minutesBefore: Number(event.target.value), timeZone: newReminderZone } : null })}><option value="">No reminder</option>{REMINDER_CHOICES.map((minutes) => <option key={minutes} value={minutes}>{reminderLabel(minutes)}</option>)}{draft.reminder && !REMINDER_CHOICES.includes(draft.reminder.minutesBefore) && <option value={draft.reminder.minutesBefore}>{reminderLabel(draft.reminder.minutesBefore)}</option>}</Select></Field>
      </FormGroup>
      <Field label="Notes" htmlFor="task-notes"><Textarea id="task-notes" maxLength={10000} value={draft.notes} placeholder="Details, links, page numbers…" onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></Field>
      {!isNew && <div className="flex items-center gap-2.5 rounded-2xl bg-muted/60 px-4 py-3 ring-1 ring-inset ring-foreground/[0.04]"><Checkbox id="task-completed" className="size-5 rounded-full [&_svg]:size-3.5" checked={draft.completed} onCheckedChange={(checked) => setDraft({ ...draft, completed: checked === true })} /><Label htmlFor="task-completed" className="font-semibold">Completed</Label></div>}
      {changed && !pending && <ChangedWhileEditing draft={draft as unknown as Record<string, unknown>} current={current as unknown as Record<string, unknown> | null} fields={taskFields(classes)} onKeep={() => setAcknowledged(serialized)} onLoad={() => { if (current) { setDraft(current); setOriginal(current); setAcknowledged(serialized); } else onClose(); }} />}
      {deleting && onDelete && !deleted && <Callout tone="warning" icon="alert" role="alert" title="Delete this task?" actions={<>
        <Button size="sm" variant="danger" busy={pending} disabled={changed} onClick={() => void run(onDelete)}>Delete task</Button>
        <Button size="sm" autoFocus disabled={pending} onClick={() => setDeleting(false)}>Keep it</Button>
      </>}>{draft.title.trim() ? `“${draft.title.trim()}” will be removed from your tasks.` : 'It will be removed from your tasks.'}</Callout>}
      {error && <Callout tone="danger" role="alert">{error}</Callout>}
    </form>
  </Modal>;
}
