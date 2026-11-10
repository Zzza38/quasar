'use client';

import { useEffect, useState } from 'react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import { AI_BETA } from '@/domain/ai';
import { FIRST_DATE, LAST_DATE } from '@/domain/schedule';
import { taskSchema, type Task } from '@/domain/task';
import { formatDate, formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { taskItems, type AppState, type TaskItem } from './app-state';
import { AiPhotoStrip, PlusTag, quotaLine, useAiPhotos, useAiStatus } from './ai-photos';
import { useBeta } from './betas';
import { Icon } from './icon';
import { Button, Callout, Chip, Field, Hint, Input, Modal, Select, Spacer } from './primitives';
import { Checkbox } from './ui/checkbox';

/**
 * Photo to tasks (Quasar AI Plus, ai-tasks beta; src/server/photo-tasks.ts): "From a photo" on Tasks reads up to three
 * photos or PDF pages into task rows. The student checks every row (title, date, class, untick) before anything is
 * saved, and saving goes through state.saveTask like a task they typed.
 */
type Read = RouterOutput['photoTasks']['read']['tasks'][number];
export type PhotoDraft = Read & { include: boolean; existing: string | null };

/** Titles compared the way a student would: case, spacing and punctuation don't matter. */
const titleKey = (title: string) => title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The existing task a read row repeats (same title and due date), so the review can flag it and leave it unticked. */
export function existingMatch(row: Pick<Read, 'title' | 'dueDate'>, items: TaskItem[]): TaskItem | null {
  const key = titleKey(row.title);
  return items.find(item => titleKey(item.task.title) === key && item.task.dueDate === row.dueDate) ?? null;
}

export function draftRows(rows: Read[], items: TaskItem[]): PhotoDraft[] {
  return rows.map(row => { const match = existingMatch(row, items); return { ...row, include: !match, existing: match?.task.title ?? null }; });
}

/** The task a reviewed row saves as. A test is high priority, everything else normal, so auto-sort doesn't ask the AI again. */
export function draftTask(row: PhotoDraft): Task {
  return taskSchema.parse({ title: row.title.trim(), dueDate: row.dueDate, dueTime: row.dueDate ? row.dueTime : null, classId: row.classId, notes: row.notes, completed: false, priority: row.kind === 'test' ? 'high' : 'normal' });
}

export function PhotoTasksButton({ state }: { state: AppState }) {
  const beta = useBeta(AI_BETA);
  const { status, reload } = useAiStatus(beta);
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState('');
  if (!beta || (status?.beta && !status.available)) return null;
  return <>
    <Button icon="camera" onClick={() => { setDone(''); setOpen(true); }}>From a photo<PlusTag status={status} /></Button>
    {open && <PhotoTasksSheet state={state} status={status} onClose={(added) => { setOpen(false); void reload(); if (added) setDone(`Added ${added} ${added === 1 ? 'task' : 'tasks'} from your photo.`); }} />}
    {done && <span className="sr-only" role="status">{done}</span>}
  </>;
}

function PhotoTasksSheet({ state, status, onClose }: { state: AppState; status: ReturnType<typeof useAiStatus>['status']; onClose: (added: number) => void }) {
  const accountId = state.context.user.id;
  const picker = useAiPhotos('photos of your assignments');
  const [rows, setRows] = useState<PhotoDraft[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [reading, setReading] = useState<{ started: number; elapsed: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!reading) return;
    const timer = setInterval(() => setReading(current => current && { ...current, elapsed: Math.floor((Date.now() - current.started) / 1000) }), 1000);
    return () => clearInterval(timer);
  }, [reading]);
  // New pictures need a fresh read.
  const photoKey = picker.photos.map(photo => photo.preview.length).join(',');
  useEffect(() => { setRows(null); setNotes([]); }, [photoKey]);
  const read = async () => {
    setError(''); setReading({ started: Date.now(), elapsed: 0 });
    try {
      const result = await api.photoTasks.read.mutate({ accountId, images: picker.images, ...(picker.pdfText ? { text: picker.pdfText } : {}) });
      setRows(draftRows(result.tasks, taskItems(state.snapshot.entities)));
      setNotes(result.notes);
    } catch (err) { setError(errorMessage(err)); }
    finally { setReading(null); }
  };
  const update = (index: number, patch: Partial<PhotoDraft>) => setRows(current => current?.map((row, i) => i === index ? { ...row, ...patch } : row) ?? null);
  const ready = rows?.filter(row => row.include && row.title.trim()) ?? [];
  const save = async () => {
    setSaving(true); setError('');
    let added = 0;
    try {
      for (const row of ready) { await state.saveTask(crypto.randomUUID(), draftTask(row)); added += 1; }
      onClose(added);
    } catch (err) {
      // Rows already saved are unticked, so trying again doesn't add them twice.
      setRows(current => current?.map(row => ready.slice(0, added).includes(row) ? { ...row, include: false, existing: row.title } : row) ?? null);
      setError(errorMessage(err)); setSaving(false);
    }
  };
  const busy = !!reading || saving;
  const classes = state.personal.classes;
  return <Modal open onClose={() => onClose(0)} busy={busy} dirty={rows !== null && ready.length > 0} wide title="Tasks from a photo"
    description={`A whiteboard, syllabus, assignment sheet or planner page. You check every task before it’s added. ${quotaLine(status, 'photo', 'photo imports')}`}
    footer={<><Button variant="ghost" disabled={busy} onClick={() => onClose(0)}>Cancel</Button><Spacer />
      {rows ? <Button variant="primary" icon="plus" busy={saving} disabled={busy || ready.length === 0 || !state.online} onClick={() => void save()}>Add {ready.length} {ready.length === 1 ? 'task' : 'tasks'}</Button>
        : <Button variant="primary" icon="sparkle" busy={!!reading} disabled={busy || picker.photos.length === 0 || picker.preparing || !state.online} onClick={() => void read()}>Read tasks</Button>}</>}>
    {picker.inputs}
    {!state.online && <Callout tone="warning" icon="cloudOff">Connect to the internet to read photos.</Callout>}
    <AiPhotoStrip picker={picker} disabled={busy} what="the assignments" />
    <Hint>Photos go to the AI for this read only and aren’t stored.</Hint>
    {reading && <div className="flex items-center gap-2.5 rounded-2xl bg-muted/60 px-3.5 py-3 text-sm ring-1 ring-inset ring-foreground/[0.04]" role="status">
      <Icon name="spinner" className="animate-spin text-primary" />Reading your {picker.photos.length === 1 ? 'photo' : 'photos'}…<Spacer /><span className="tabular-nums text-muted-foreground">{reading.elapsed}s</span>
    </div>}
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    {notes.map(note => <Callout key={note} tone="info" icon="info">{note}</Callout>)}
    {rows && rows.length > 0 && <>
      <Hint>Found {rows.length} {rows.length === 1 ? 'task' : 'tasks'}. Fix anything misread and untick what you don’t need. A class is only filled in when the photo names it.</Hint>
      <ul className="grid gap-2.5" aria-label="Tasks read from the photo">
        {rows.map((row, index) => {
          const id = `photo-task-${index}`;
          const known = row.classId && classes.some(entry => entry.id === row.classId);
          return <li key={index} className={cn('grid gap-2.5 rounded-2xl p-3 ring-1 ring-inset', row.include ? 'bg-muted/60 ring-foreground/[0.04]' : 'ring-foreground/[0.06] opacity-70')}>
            <div className="flex items-start gap-2.5">
              <Checkbox id={`${id}-include`} aria-label={`Add “${row.title || 'this task'}”`} className="mt-2.5 size-5 rounded-full [&_svg]:size-3.5" checked={row.include} disabled={saving} onCheckedChange={checked => update(index, { include: checked === true })} />
              <div className="grid min-w-0 flex-1 gap-2">
                <Input small aria-label={`Task ${index + 1} title`} maxLength={300} value={row.title} disabled={!row.include || saving} className="font-semibold" onChange={event => update(index, { title: event.target.value })} />
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
                  <Field label="Due" htmlFor={`${id}-date`}><Input id={`${id}-date`} small type="date" min={FIRST_DATE} max={LAST_DATE} value={row.dueDate ?? ''} disabled={!row.include || saving} onChange={event => update(index, { dueDate: event.target.value || null })} /></Field>
                  <Field label="Class" htmlFor={`${id}-class`}><Select id={`${id}-class`} small value={known ? row.classId! : ''} disabled={!row.include || saving} onChange={event => update(index, { classId: event.target.value || null })}>
                    <option value="">No class</option>{classes.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                  </Select></Field>
                </div>
                {(row.kind !== 'none' || (row.dueDate && row.dueTime) || row.existing) && <div className="flex flex-wrap gap-1.5">
                  {row.kind !== 'none' && <Chip tone="accent">{row.kind === 'test' ? 'Test' : 'Quiz'}</Chip>}
                  {row.dueDate && row.dueTime && <Chip icon="clock">{formatTime(row.dueTime)}</Chip>}
                  {row.existing && <Chip tone="warning" icon="layers">Already in your tasks</Chip>}
                </div>}
                {row.notes && <Hint className="line-clamp-3">{row.notes}</Hint>}
                {row.existing && row.include && <Hint>You have “{row.existing}”{row.dueDate ? ` due ${formatDate(row.dueDate, { weekday: 'short' })}` : ''}. Adding this makes a second copy.</Hint>}
              </div>
            </div>
          </li>;
        })}
      </ul>
    </>}
  </Modal>;
}
