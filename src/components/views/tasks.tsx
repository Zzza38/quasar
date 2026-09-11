'use client';

import { useEffect, useMemo, useState } from 'react';
import { errorMessage } from '@/client/api';
import { taskSchema, type Task } from '@/domain/task';
import { addDays, daysBetween } from '@/lib/format';
import type { AppState, TaskItem } from '../app-state';
import { sortByDue, taskItems } from '../app-state';
import { ChangedWhileEditing, taskFields } from '../conflicts';
import { Button, EmptyState, Field, Input, Select, Sheet, Textarea } from '../ui';
import { QuickAdd, TaskRow } from './today';

const emptyTask: Task = { title: '', dueDate: null, dueTime: null, classId: null, notes: '', completed: false };

export function TasksView({ state }: { state: AppState }) {
  const items = useMemo(() => taskItems(state.snapshot.entities), [state.snapshot.entities]);
  const open = useMemo(() => sortByDue(items.filter((item) => !item.task.completed)), [items]);
  const completed = useMemo(() => items.filter((item) => item.task.completed).sort((left, right) => right.entity.version - left.entity.version), [items]);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [classFilter, setClassFilter] = useState('');
  const editParam = state.params.get('edit');
  useEffect(() => { if (editParam) { setEditing(editParam); state.navigate('tasks'); } }, [editParam, state]);

  const filtered = classFilter ? open.filter((item) => item.task.classId === classFilter) : open;
  const groups: Array<{ title: string; items: TaskItem[] }> = [
    { title: 'Overdue', items: filtered.filter((item) => item.task.dueDate && item.task.dueDate < state.today) },
    { title: 'Today', items: filtered.filter((item) => item.task.dueDate === state.today) },
    { title: 'Tomorrow', items: filtered.filter((item) => item.task.dueDate && daysBetween(state.today, item.task.dueDate) === 1) },
    { title: 'Next 7 days', items: filtered.filter((item) => item.task.dueDate && daysBetween(state.today, item.task.dueDate) > 1 && daysBetween(state.today, item.task.dueDate) <= 7) },
    { title: 'Later', items: filtered.filter((item) => item.task.dueDate && daysBetween(state.today, item.task.dueDate) > 7) },
    { title: 'No due date', items: filtered.filter((item) => !item.task.dueDate) },
  ].filter((group) => group.items.length > 0);
  const current = editing && editing !== 'new' ? items.find((item) => item.id === editing) : undefined;

  return <div className="grid gap-4 fade-in">
    <header className="flex items-end justify-between gap-3 flex-wrap">
      <div><h1>Tasks</h1><p className="text-sm text-text-2">{open.length === 0 ? 'Nothing open.' : `${open.length} open`}{completed.length > 0 ? ` · ${completed.length} done` : ''}</p></div>
      <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>New task</Button>
    </header>
    <QuickAdd onAdd={(title) => state.saveTask(crypto.randomUUID(), { ...emptyTask, title })} placeholder="Quick add: type a task and press Enter" />
    {state.personal.classes.length > 0 && open.length > 0 && <div className="flex gap-1.5 flex-wrap" role="group" aria-label="Filter by class">
      <button type="button" className={`btn btn-sm ${classFilter === '' ? 'btn-primary' : 'btn-secondary'}`} aria-pressed={classFilter === ''} onClick={() => setClassFilter('')}>All</button>
      {state.personal.classes.map((cls) => <button key={cls.id} type="button" className={`btn btn-sm ${classFilter === cls.id ? 'btn-primary' : 'btn-secondary'}`} aria-pressed={classFilter === cls.id} onClick={() => setClassFilter(cls.id)}>{cls.name}</button>)}
    </div>}
    {groups.length === 0 && <section className="card"><EmptyState icon="checkCircle" title={classFilter ? 'No open tasks for this class' : 'All clear'}>{classFilter ? 'Try another class or add a task.' : 'Add homework, forms, practice, anything you need to remember.'}</EmptyState></section>}
    {groups.map((group) => <section key={group.title} className="card card-pad grid gap-1" aria-labelledby={`group-${group.title}`}>
      <h2 id={`group-${group.title}`} className="text-[13px] uppercase tracking-wide text-text-3 font-bold mb-1" style={group.title === 'Overdue' ? { color: 'var(--danger-text)' } : undefined}>{group.title} <span className="font-medium">· {group.items.length}</span></h2>
      <ul className="grid">{group.items.map((item) => <TaskRow key={item.id} item={item} state={state} showDate={group.title !== 'Today' && group.title !== 'Tomorrow'} />)}</ul>
    </section>)}
    {completed.length > 0 && <section className="card card-pad grid gap-1">
      <button type="button" className="flex items-center justify-between w-full text-left" aria-expanded={showCompleted} onClick={() => setShowCompleted(!showCompleted)}>
        <h2 className="text-[13px] uppercase tracking-wide text-text-3 font-bold">Completed · {completed.length}</h2><span className="hint">{showCompleted ? 'Hide' : 'Show'}</span>
      </button>
      {showCompleted && <ul className="grid mt-1">{completed.slice(0, 50).map((item) => <TaskRow key={item.id} item={item} state={state} />)}</ul>}
    </section>}
    <TaskSheet key={editing ?? 'closed'} open={editing !== null} onClose={() => setEditing(null)} initial={editing === 'new' ? emptyTask : current?.task ?? null} current={editing === 'new' ? undefined : current?.task ?? null} classes={state.personal.classes} today={state.today}
      onSave={async (task) => { await state.saveTask(editing === 'new' || !editing ? crypto.randomUUID() : editing, task); setEditing(null); }}
      onDelete={editing && editing !== 'new' ? async () => { await state.saveTask(editing, null); setEditing(null); } : undefined} />
  </div>;
}

export function TaskSheet({ open, onClose, initial, current, classes, today, onSave, onDelete }: { open: boolean; onClose: () => void; initial: Task | null; current?: Task | null; classes: Array<{ id: string; name: string }>; today: string; onSave: (task: Task) => Promise<void>; onDelete?: () => Promise<void> }) {
  const [draft, setDraft] = useState<Task>(initial ?? emptyTask);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const serialized = JSON.stringify(current);
  const [acknowledged, setAcknowledged] = useState(serialized);
  const changed = current !== undefined && serialized !== acknowledged;
  const isNew = current === undefined;
  const run = async (action: () => Promise<void>) => { setPending(true); setError(''); try { await action(); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); } };
  if (open && initial === null && !isNew) return <Sheet open onClose={onClose} title="Task not found"><p className="text-sm text-text-2">This task was deleted.</p></Sheet>;
  return <Sheet open={open} onClose={onClose} title={isNew ? 'New task' : 'Edit task'}
    footer={<>{onDelete && <Button variant="danger" disabled={pending || changed} onClick={() => { if (confirm('Delete this task?')) void run(onDelete); }}>Delete</Button>}<span className="spacer" /><Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button><Button variant="primary" form="task-form" type="submit" busy={pending} disabled={changed || !draft.title.trim()}>{isNew ? 'Add task' : 'Save'}</Button></>}>
    <form id="task-form" className="grid gap-4" onSubmit={(event) => { event.preventDefault(); if (!changed) void run(() => onSave(taskSchema.parse({ ...draft, title: draft.title.trim() }))); }}>
      <Field label="Task" htmlFor="task-title"><Input id="task-title" autoFocus required maxLength={300} value={draft.title} placeholder="What needs to get done?" onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Due date" htmlFor="task-date"><Input id="task-date" type="date" value={draft.dueDate ?? ''} onChange={(event) => setDraft({ ...draft, dueDate: event.target.value || null, dueTime: event.target.value ? draft.dueTime : null })} /></Field>
        <Field label="Due time" htmlFor="task-time" hint={!draft.dueDate ? 'Pick a date first' : undefined}><Input id="task-time" type="time" disabled={!draft.dueDate} value={draft.dueTime ?? ''} onChange={(event) => setDraft({ ...draft, dueTime: event.target.value || null })} /></Field>
      </div>
      <div className="flex gap-1.5 flex-wrap -mt-2" role="group" aria-label="Quick due dates">
        {[{ label: 'Today', offset: 0 }, { label: 'Tomorrow', offset: 1 }, { label: 'In 2 days', offset: 2 }, { label: 'Next week', offset: 7 }].map((entry) => {
          const date = addDays(today, entry.offset);
          return <Button key={entry.offset} size="sm" variant={draft.dueDate === date ? 'soft' : 'ghost'} onClick={() => setDraft({ ...draft, dueDate: date })}>{entry.label}</Button>;
        })}
        {draft.dueDate && <Button size="sm" variant="ghost" onClick={() => setDraft({ ...draft, dueDate: null, dueTime: null })}>No date</Button>}
      </div>
      <Field label="Class" htmlFor="task-class"><Select id="task-class" value={draft.classId ?? ''} onChange={(event) => setDraft({ ...draft, classId: event.target.value || null })}><option value="">No class</option>{classes.map((cls) => <option key={cls.id} value={cls.id}>{cls.name}</option>)}{draft.classId && !classes.some((cls) => cls.id === draft.classId) && <option value={draft.classId}>Removed class</option>}</Select></Field>
      <Field label="Notes" htmlFor="task-notes"><Textarea id="task-notes" maxLength={10000} value={draft.notes} placeholder="Details, links, page numbers…" onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></Field>
      {!isNew && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.completed} onChange={(event) => setDraft({ ...draft, completed: event.target.checked })} />Completed</label>}
      {changed && <ChangedWhileEditing draft={draft as unknown as Record<string, unknown>} current={current as unknown as Record<string, unknown> | null} fields={taskFields(classes)} onKeep={() => setAcknowledged(serialized)} onLoad={() => { if (current) { setDraft(current); setAcknowledged(serialized); } else onClose(); }} />}
      {error && <p className="callout callout-danger" role="alert">{error}</p>}
    </form>
  </Sheet>;
}
