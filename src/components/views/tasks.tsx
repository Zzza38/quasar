'use client';

import { useEffect, useMemo, useState } from 'react';
import { errorMessage } from '@/client/api';
import { taskSchema, type Task } from '@/domain/task';
import { addDays, daysBetween } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AppState, TaskItem } from '../app-state';
import { sortByDue, taskItems } from '../app-state';
import { ChangedWhileEditing, taskFields } from '../conflicts';
import { Icon } from '../icon';
import { Button, Callout, EmptyState, Field, Hint, Input, Modal, Select, Spacer, Textarea } from '../primitives';
import { buttonVariants } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Label } from '../ui/label';
import { Toggle } from '../ui/toggle';
import { QuickAdd, TaskRow } from './today';

const emptyTask: Task = { title: '', dueDate: null, dueTime: null, classId: null, notes: '', completed: false };

export function TasksView({ state }: { state: AppState }) {
  const items = useMemo(() => taskItems(state.snapshot.entities), [state.snapshot.entities]);
  const open = useMemo(() => sortByDue(items.filter((item) => !item.task.completed)), [items]);
  const completed = useMemo(() => items.filter((item) => item.task.completed).sort((left, right) => right.entity.version - left.entity.version), [items]);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [classFilter, setClassFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [sort, setSort] = useState('due');
  const editParam = state.params.get('edit');
  useEffect(() => { if (editParam) { setEditing(editParam); state.navigate('tasks'); } }, [editParam, state]);

  const filtered = open.filter((item) => (!classFilter || item.task.classId === classFilter) && (!priorityFilter || (item.task.priority ?? 'normal') === priorityFilter));
  if (sort === 'priority') { const rank = { high: 0, normal: 1, low: 2 }; filtered.sort((a, b) => rank[a.task.priority ?? 'normal'] - rank[b.task.priority ?? 'normal']); }
  const groups: Array<{ title: string; items: TaskItem[] }> = [
    { title: 'Overdue', items: filtered.filter((item) => item.task.dueDate && item.task.dueDate < state.today) },
    { title: 'Today', items: filtered.filter((item) => item.task.dueDate === state.today) },
    { title: 'Tomorrow', items: filtered.filter((item) => item.task.dueDate && daysBetween(state.today, item.task.dueDate) === 1) },
    { title: 'Next 7 days', items: filtered.filter((item) => item.task.dueDate && daysBetween(state.today, item.task.dueDate) > 1 && daysBetween(state.today, item.task.dueDate) <= 7) },
    { title: 'Later', items: filtered.filter((item) => item.task.dueDate && daysBetween(state.today, item.task.dueDate) > 7) },
    { title: 'No due date', items: filtered.filter((item) => !item.task.dueDate) },
  ].filter((group) => group.items.length > 0);
  const current = editing && editing !== 'new' ? items.find((item) => item.id === editing) : undefined;
  const filterToggle = 'h-8 rounded-full border border-border px-3 text-[13px] data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground';

  return <div className="grid gap-4 animate-in fade-in-0 duration-200">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div><h1>Tasks</h1><p className="text-sm text-muted-foreground">{open.length === 0 ? 'Nothing open.' : `${open.length} open`}{completed.length > 0 ? ` · ${completed.length} done` : ''}</p></div>
      <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>New task</Button>
    </header>
    <QuickAdd onAdd={(title) => state.saveTask(crypto.randomUUID(), { ...emptyTask, title })} placeholder="Quick add: type a task and press Enter" />
    {state.personal.classes.length > 0 && open.length > 0 && <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by class">
      <Toggle pressed={classFilter === ''} onPressedChange={() => setClassFilter('')} className={filterToggle}>All</Toggle>
      {state.personal.classes.map((cls) => <Toggle key={cls.id} pressed={classFilter === cls.id} onPressedChange={() => setClassFilter(classFilter === cls.id ? '' : cls.id)} className={filterToggle}>{cls.name}</Toggle>)}
    </div>}
    <div className="flex flex-wrap gap-3">
      <Field label="Priority" htmlFor="priority-filter"><Select id="priority-filter" small value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)}><option value="">All priorities</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></Select></Field>
      <Field label="Sort within each group" htmlFor="task-sort"><Select id="task-sort" small value={sort} onChange={(event) => setSort(event.target.value)}><option value="due">Due time</option><option value="priority">Priority</option></Select></Field>
    </div>
    {groups.length === 0 && <Card><EmptyState icon="checkCircle" title={classFilter || priorityFilter ? 'No matching open tasks' : 'All clear'}>{classFilter || priorityFilter ? 'Try another filter or add a task.' : 'Add homework, forms, practice, anything you need to remember.'}</EmptyState></Card>}
    {groups.map((group) => <Card key={group.title} className="gap-1 py-3" aria-labelledby={`group-${group.title}`}>
      <CardContent className="grid gap-1 px-2">
        <h2 id={`group-${group.title}`} className={cn('px-2.5 text-[13px] font-bold uppercase tracking-wide text-muted-foreground', group.title === 'Overdue' && 'text-destructive')}>{group.title} <span className="font-medium">· {group.items.length}</span></h2>
        <ul className="grid">{group.items.map((item) => <TaskRow key={item.id} item={item} state={state} showDate={group.title !== 'Today' && group.title !== 'Tomorrow'} />)}</ul>
      </CardContent>
    </Card>)}
    {completed.length > 0 && <Card className="gap-1 py-3">
      <CardContent className="grid gap-1 px-2">
        <button type="button" className="flex w-full items-center justify-between rounded-lg px-2.5 py-1 text-left hover:bg-muted" aria-expanded={showCompleted} onClick={() => setShowCompleted(!showCompleted)}>
          <h2 className="text-[13px] font-bold uppercase tracking-wide text-muted-foreground">Completed · {completed.length}</h2><Hint>{showCompleted ? 'Hide' : 'Show'}</Hint>
        </button>
        {showCompleted && <ul className="mt-1 grid">{completed.slice(0, 50).map((item) => <TaskRow key={item.id} item={item} state={state} />)}</ul>}
      </CardContent>
    </Card>}
    <TaskSheet key={editing ?? 'closed'} open={editing !== null} onClose={() => setEditing(null)} initial={editing === 'new' ? emptyTask : current?.task ?? null} current={editing === 'new' ? undefined : current?.task ?? null} classes={state.personal.classes} today={state.today} timeZone={state.timeZone}
      onSave={async (task) => { await state.saveTask(editing === 'new' || !editing ? crypto.randomUUID() : editing, task); setEditing(null); }}
      onDelete={editing && editing !== 'new' ? async () => { await state.saveTask(editing, null); setEditing(null); } : undefined} />
  </div>;
}

export function TaskSheet({ open, onClose, initial, current, classes, today, timeZone, onSave, onDelete }: { open: boolean; onClose: () => void; initial: Task | null; current?: Task | null; classes: Array<{ id: string; name: string }>; today: string; timeZone: string; onSave: (task: Task) => Promise<void>; onDelete?: () => Promise<void> }) {
  const [draft, setDraft] = useState<Task>(initial ?? emptyTask);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const serialized = JSON.stringify(current);
  const [acknowledged, setAcknowledged] = useState(serialized);
  const changed = current !== undefined && serialized !== acknowledged;
  const isNew = current === undefined;
  const run = async (action: () => Promise<void>) => { setPending(true); setError(''); try { await action(); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); } };
  if (open && initial === null && !isNew) return <Modal open onClose={onClose} title="Task not found"><p className="text-sm text-muted-foreground">This task was deleted.</p></Modal>;
  return <Modal open={open} onClose={onClose} title={isNew ? 'New task' : 'Edit task'}
    footer={<>{onDelete && <Button variant="danger" disabled={pending || changed} onClick={() => { if (confirm('Delete this task?')) void run(onDelete); }}>Delete</Button>}<Spacer /><Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button><Button variant="primary" form="task-form" type="submit" busy={pending} disabled={changed || !draft.title.trim()}>{isNew ? 'Add task' : 'Save'}</Button></>}>
    <form id="task-form" className="grid gap-4" onSubmit={(event) => { event.preventDefault(); if (!changed) void run(() => onSave(taskSchema.parse({ ...draft, title: draft.title.trim() }))); }}>
      <Field label="Task" htmlFor="task-title"><Input id="task-title" autoFocus required maxLength={300} value={draft.title} placeholder="What needs to get done?" onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Due date" htmlFor="task-date"><Input id="task-date" type="date" value={draft.dueDate ?? ''} onChange={(event) => setDraft({ ...draft, dueDate: event.target.value || null, dueTime: event.target.value ? draft.dueTime : null, recurrence: event.target.value ? (draft.recurrence ? { ...draft.recurrence, anchorDate: event.target.value } : draft.recurrence) : null, reminder: event.target.value ? draft.reminder : null })} /></Field>
        <Field label="Due time" htmlFor="task-time" hint={!draft.dueDate ? 'Pick a date first' : undefined}><Input id="task-time" type="time" disabled={!draft.dueDate} value={draft.dueTime ?? ''} onChange={(event) => setDraft({ ...draft, dueTime: event.target.value || null })} /></Field>
      </div>
      <div className="-mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Quick due dates">
        {[{ label: 'Today', offset: 0 }, { label: 'Tomorrow', offset: 1 }, { label: 'In 2 days', offset: 2 }, { label: 'Next week', offset: 7 }].map((entry) => {
          const date = addDays(today, entry.offset);
          return <Button key={entry.offset} size="sm" variant={draft.dueDate === date ? 'soft' : 'ghost'} onClick={() => setDraft({ ...draft, dueDate: date, ...(draft.recurrence ? { recurrence: { ...draft.recurrence, anchorDate: date } } : {}) })}>{entry.label}</Button>;
        })}
        {draft.dueDate && <Button size="sm" variant="ghost" onClick={() => setDraft({ ...draft, dueDate: null, dueTime: null, recurrence: null, reminder: null })}>No date</Button>}
      </div>
      <Field label="Class" htmlFor="task-class"><Select id="task-class" value={draft.classId ?? ''} onChange={(event) => setDraft({ ...draft, classId: event.target.value || null })}><option value="">No class</option>{classes.map((cls) => <option key={cls.id} value={cls.id}>{cls.name}</option>)}{draft.classId && !classes.some((cls) => cls.id === draft.classId) && <option value={draft.classId}>Removed class</option>}</Select></Field>
      {draft.imported && <Callout tone="neutral" icon="calendar" actions={draft.imported.url ? <a href={draft.imported.url} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}><Icon name="externalLink" />Open link</a> : undefined}>Imported calendar event{draft.imported.sourceRemoved ? ' · Removed from its source; your task is kept.' : '. Calendar updates keep your completion and checklist.'}</Callout>}
      <Field label="Priority" htmlFor="task-priority"><Select id="task-priority" value={draft.priority ?? 'normal'} onChange={(event) => setDraft({ ...draft, priority: event.target.value as Task['priority'] })}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></Select></Field>
      <fieldset className="grid gap-2"><legend className="mb-2 text-sm font-medium text-muted-foreground">Checklist</legend>
        {(draft.subtasks ?? []).map((item, index) => <div key={item.id} className="flex items-center gap-2">
          <Checkbox className="size-5 rounded-md [&_svg]:size-4" checked={item.completed} aria-label={`Complete checklist item ${index + 1}`} onCheckedChange={(checked) => setDraft({ ...draft, subtasks: draft.subtasks!.map(entry => entry.id === item.id ? { ...entry, completed: checked === true } : entry) })} />
          <Input aria-label={`Checklist item ${index + 1}`} required maxLength={300} value={item.title} onChange={(event) => setDraft({ ...draft, subtasks: draft.subtasks!.map(entry => entry.id === item.id ? { ...entry, title: event.target.value } : entry) })} />
          <Button size="sm" variant="ghost" aria-label={`Remove checklist item ${index + 1}`} onClick={() => setDraft({ ...draft, subtasks: draft.subtasks!.filter(entry => entry.id !== item.id) })}>Remove</Button>
        </div>)}
        <div><Button size="sm" variant="ghost" icon="plus" disabled={(draft.subtasks?.length ?? 0) >= 100} onClick={() => setDraft({ ...draft, subtasks: [...(draft.subtasks ?? []), { id: crypto.randomUUID(), title: '', completed: false }] })}>Add checklist item</Button></div>
      </fieldset>
      {!draft.imported && <Field label="Repeat" htmlFor="task-repeat" hint={!draft.dueDate ? 'Pick a due date first' : 'Completing this task creates the next occurrence after syncing.'}><Select id="task-repeat" disabled={!draft.dueDate} value={draft.recurrence?.frequency ?? ''} onChange={(event) => setDraft({ ...draft, recurrence: event.target.value ? { frequency: event.target.value as NonNullable<Task['recurrence']>['frequency'], interval: draft.recurrence?.interval ?? 1, until: draft.recurrence?.until ?? null, anchorDate: draft.dueDate! } : null })}><option value="">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></Select></Field>}
      {draft.recurrence && <div className="grid gap-4 sm:grid-cols-2"><Field label={`Every (${draft.recurrence.frequency === 'daily' ? 'days' : draft.recurrence.frequency === 'weekly' ? 'weeks' : 'months'})`} htmlFor="task-interval"><Input id="task-interval" type="number" min={1} max={365} required value={draft.recurrence.interval} onChange={(event) => setDraft({ ...draft, recurrence: { ...draft.recurrence!, interval: Number(event.target.value) } })} /></Field><Field label="Repeat until (optional)" htmlFor="task-until"><Input id="task-until" type="date" min={draft.dueDate ?? undefined} value={draft.recurrence.until ?? ''} onChange={(event) => setDraft({ ...draft, recurrence: { ...draft.recurrence!, until: event.target.value || null } })} /></Field></div>}
      <Field label="Reminder" htmlFor="task-reminder" hint={draft.dueDate ? `Uses ${draft.reminder?.timeZone ?? timeZone}${!draft.dueTime ? ' at 9:00 AM for date-only tasks' : ''}. Enable browser notifications in Account.` : 'Pick a due date first'}><Select id="task-reminder" disabled={!draft.dueDate} value={draft.reminder ? String(draft.reminder.minutesBefore) : ''} onChange={(event) => setDraft({ ...draft, reminder: event.target.value !== '' ? { minutesBefore: Number(event.target.value), timeZone } : null })}><option value="">No reminder</option><option value="0">At due time</option><option value="10">10 minutes before</option><option value="30">30 minutes before</option><option value="60">1 hour before</option><option value="1440">1 day before</option>{draft.reminder && ![0, 10, 30, 60, 1440].includes(draft.reminder.minutesBefore) && <option value={draft.reminder.minutesBefore}>{draft.reminder.minutesBefore} minutes before</option>}</Select></Field>
      <Field label="Notes" htmlFor="task-notes"><Textarea id="task-notes" maxLength={10000} value={draft.notes} placeholder="Details, links, page numbers…" onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></Field>
      {!isNew && <div className="flex items-center gap-2"><Checkbox id="task-completed" className="size-5 rounded-md [&_svg]:size-4" checked={draft.completed} onCheckedChange={(checked) => setDraft({ ...draft, completed: checked === true })} /><Label htmlFor="task-completed">Completed</Label></div>}
      {changed && <ChangedWhileEditing draft={draft as unknown as Record<string, unknown>} current={current as unknown as Record<string, unknown> | null} fields={taskFields(classes)} onKeep={() => setAcknowledged(serialized)} onLoad={() => { if (current) { setDraft(current); setAcknowledged(serialized); } else onClose(); }} />}
      {error && <Callout tone="danger" role="alert">{error}</Callout>}
    </form>
  </Modal>;
}
