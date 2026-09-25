'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import { formatRoom } from '@/lib/format';
import { classSearchScore } from '@/domain/class-match';
import { GRADES, gradeLabel, type Grade, type PersonalSchedule, type StudentClass } from '@/domain/schedule';
import { Button, Callout, Field, Hint, Input, Modal, Panel, Select, Spacer, Textarea } from './primitives';
import { Checkbox } from './ui/checkbox';
import { Toggle } from './ui/toggle';

type Directory = RouterOutput['directory']['list'];
type Entry = Directory['classes'][number];
type Details = Pick<Entry, 'name' | 'teacher' | 'room' | 'grades'>;
/** requestCorrection accepts 10 to 5000 characters; the class reference is prepended to what the student writes. */
const CORRECTION_MIN = 10;
const CORRECTION_MAX = 5000;
const correctionPrefix = (entry: Entry) => `Class directory: ${entry.name} (${entry.id}). `;
const isCopy = (cls: StudentClass, entry: Entry) => cls.directoryId === entry.id || (!cls.directoryId && cls.name.toLowerCase() === entry.name.toLowerCase() && (cls.teacher ?? '').toLowerCase() === (entry.teacher ?? '').toLowerCase() && (cls.room ?? '').toLowerCase() === (entry.room ?? '').toLowerCase());

export function SchoolDirectory({ schoolId, online, personal, onAdd, onClose }: {
  schoolId: string; online: boolean; personal?: PersonalSchedule; onAdd?: (classes: StudentClass[]) => Promise<void>; onClose: () => void;
}) {
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [query, setQuery] = useState('');
  const [grade, setGrade] = useState<Grade | ''>(personal?.grade ?? '');
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<Entry | 'new' | null>(null);
  // The in-place confirmation for a directory removal and the correction form, one entry at a time.
  const [removing, setRemoving] = useState<string | null>(null);
  const [correction, setCorrection] = useState<{ id: string; message: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const refresh = useCallback(async () => { setDirectory(await api.directory.list.query({ schoolId })); }, [schoolId]);
  useEffect(() => {
    if (!online) return;
    let active = true;
    api.directory.list.query({ schoolId }).then(result => { if (active) setDirectory(result); }).catch(err => { if (active) setError(errorMessage(err)); });
    return () => { active = false; };
  }, [schoolId, online]);
  const run = async (action: () => Promise<void>) => {
    setPending(true); setError(''); setNotice('');
    try { await action(); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
  };
  const entries = (directory?.classes ?? []).filter(entry => (!grade || entry.grades.includes(grade)) && (classSearchScore(query, entry.name) !== null || `${entry.name} ${entry.teacher ?? ''} ${entry.room ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())));
  const selectedEntries = (directory?.classes ?? []).filter(entry => selected.includes(entry.id) && !personal?.classes.some(cls => isCopy(cls, entry)));
  return <Modal open onClose={onClose} dirty={selectedEntries.length > 0 || !!correction?.message.trim()} busy={pending} wide title="School class directory" description="Search your school’s classes, select yours, then place them into periods in your class timetable."
    footer={<><Button variant="ghost" onClick={onClose} disabled={pending}>Done</Button><Spacer />{onAdd && <Button variant="primary" busy={pending} disabled={!online || selectedEntries.length === 0 || editing !== null} onClick={() => void run(async () => {
      await onAdd(selectedEntries.map(({ id, name, room, teacher }) => ({ id, directoryId: id, name, room, teacher }))); onClose();
    })}>Add selected classes{selectedEntries.length ? ` (${selectedEntries.length})` : ''}</Button>}</>}>
    <Hint>Adding a class makes a personal copy. Edit it from Classes to change only your schedule. Shared directory edits do not overwrite existing personal copies.</Hint>
    {!online && <Callout>Connect to browse or edit the shared directory. Your saved classes remain available offline.</Callout>}
    {error && <Callout tone="danger" role="alert">{error}</Callout>}
    {notice && <Callout tone="success" role="status">{notice}</Callout>}
    {online && !directory && !error && <Hint role="status">Loading class directory…</Hint>}
    {directory && <>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Search classes" htmlFor="directory-search" className="min-w-[180px] flex-1"><Input id="directory-search" placeholder="Class, teacher, or room" value={query} onChange={event => setQuery(event.target.value)} /></Field>
        <Field label="Grade filter" htmlFor="directory-grade"><Select id="directory-grade" value={grade} onChange={event => setGrade(event.target.value as Grade | '')}><option value="">All grades</option>{GRADES.map(value => <option key={value} value={value}>{gradeLabel(value)}</option>)}</Select></Field>
        <Button size="sm" disabled={!online || pending} onClick={() => void run(refresh)}>Reload directory</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Hint className="flex-1">{directory.canEdit ? 'Members can edit shared classes until the school reaches ten members or support locks editing.' : 'Shared editing is locked. You can change your own copy or ask support for a correction.'}</Hint>
        {directory.canEdit && <Button size="sm" icon="plus" disabled={!online || pending} onClick={() => setEditing('new')}>Add directory class</Button>}
      </div>
      {editing && <DirectoryEditor key={editing === 'new' ? 'new' : `${editing.id}:${editing.version}`} initial={editing === 'new' ? { name: '', teacher: '', room: '', grades: personal?.grade ? [personal.grade] : [...GRADES] } : editing}
        pending={pending || !online} onCancel={() => setEditing(null)} onSave={details => run(async () => {
          await api.directory.save.mutate({ accountId: directory.accountId, schoolId, details, ...(editing === 'new' ? {} : { id: editing.id, expectedVersion: editing.version }) });
          await refresh(); setEditing(null); setNotice('Shared class saved.');
        })} />}
      <ul className="grid gap-2" aria-label="School classes">
        {entries.map(entry => {
          const added = personal?.classes.some(cls => isCopy(cls, entry));
          return <li key={entry.id} className={`flex flex-wrap items-center gap-3 rounded-2xl p-3 ring-1 ring-inset transition-colors ${selected.includes(entry.id) && !added ? 'bg-primary-soft/60 ring-primary/40' : 'bg-muted/60 ring-foreground/[0.04]'}`}>
            {onAdd && <Checkbox className="size-5 shrink-0" aria-label={`Select ${entry.name}`} checked={added || selected.includes(entry.id)} disabled={added || !online || pending} onCheckedChange={checked => setSelected(checked === true ? [...selected, entry.id] : selected.filter(id => id !== entry.id))} />}
            <div className="min-w-0 flex-1 basis-[180px]"><strong className="block text-sm font-bold">{entry.name}</strong><Hint>{[entry.room && formatRoom(entry.room), entry.teacher].filter(Boolean).join(' · ')}</Hint><Hint>{entry.grades.map(gradeLabel).join(', ')}{added ? ' · Added to your classes' : ''}</Hint></div>
            {directory.canEdit ? <div className="flex gap-1"><Button size="sm" disabled={!online || pending} onClick={() => setEditing(entry)}>Edit shared</Button><Button size="sm" variant="ghost" disabled={!online || pending} aria-label={`Remove ${entry.name} from directory`} onClick={() => setRemoving(entry.id)}>Remove</Button></div> : <Button size="sm" disabled={!online || pending || correction?.id === entry.id} onClick={() => { setCorrection({ id: entry.id, message: '' }); setNotice(''); }}>Request correction</Button>}
            {removing === entry.id && <Callout tone="warning" icon="alert" role="alert" className="basis-full" title={`Remove ${entry.name} from the shared directory?`} actions={<>
              <Button size="sm" variant="danger" busy={pending} disabled={!online} onClick={() => void run(async () => {
                await api.directory.remove.mutate({ accountId: directory.accountId, schoolId, id: entry.id, expectedVersion: entry.version });
                await refresh(); setSelected(ids => ids.filter(id => id !== entry.id)); setRemoving(null);
              })}>Remove from directory</Button>
              <Button size="sm" autoFocus disabled={pending} onClick={() => setRemoving(null)}>Keep it</Button>
            </>}>Existing personal copies stay saved.</Callout>}
            {correction?.id === entry.id && <CorrectionForm entry={entry} message={correction.message} pending={pending} online={online}
              onChange={message => setCorrection({ id: entry.id, message })} onCancel={() => setCorrection(null)}
              onSend={message => run(async () => {
                await api.school.requestCorrection.mutate({ accountId: directory.accountId, message: `${correctionPrefix(entry)}${message}` });
                setCorrection(null); setNotice('Correction request sent to support.');
              })} />}
          </li>;
        })}
      </ul>
      {!entries.length && <Hint>{directory.classes.length ? 'No matching classes. Try another search or choose All grades.' : 'No shared classes yet. Add classes to help schoolmates build their schedules.'}</Hint>}
    </>}
  </Modal>;
}

/** What a student without edit rights sends support about one directory class, in place of an unthemed prompt(). */
function CorrectionForm({ entry, message, pending, online, onChange, onSend, onCancel }: {
  entry: Entry; message: string; pending: boolean; online: boolean; onChange: (message: string) => void; onSend: (message: string) => Promise<void>; onCancel: () => void;
}) {
  const text = message.trim();
  const id = `directory-correction-${entry.id}`;
  return <form className="grid basis-full gap-2" onSubmit={event => { event.preventDefault(); if (text.length >= CORRECTION_MIN) void onSend(text); }}>
    <Field label={`What needs correcting in ${entry.name}?`} htmlFor={id} hint="For example the right teacher, room or grades. Support reviews every request.">
      <Textarea id={id} required autoFocus rows={3} minLength={CORRECTION_MIN} maxLength={CORRECTION_MAX - correctionPrefix(entry).length} value={message} disabled={pending} onChange={event => onChange(event.target.value)} />
    </Field>
    <div className="flex gap-2">
      <Button size="sm" variant="primary" type="submit" busy={pending} disabled={!online || text.length < CORRECTION_MIN}>Send to support</Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={onCancel}>Cancel</Button>
    </div>
  </form>;
}

function DirectoryEditor({ initial, pending, onSave, onCancel }: { initial: Details; pending: boolean; onSave: (details: Details) => Promise<void>; onCancel: () => void }) {
  const [draft, setDraft] = useState<Details>({ name: initial.name, teacher: initial.teacher, room: initial.room, grades: initial.grades });
  const panel = useRef<HTMLDivElement>(null);
  // The editor sits above the class list, so bring it into view (and focus it) when an entry is picked further down.
  useEffect(() => {
    panel.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    panel.current?.querySelector<HTMLInputElement>('#directory-name')?.focus({ preventScroll: true });
  }, []);
  return <Panel ref={panel} className="grid gap-3 scroll-mt-4 bg-card p-4 ring-2 ring-primary/40">
    <strong className="text-sm font-bold">Shared class details</strong>
    <Field label="Class name" htmlFor="directory-name"><Input id="directory-name" maxLength={120} value={draft.name} disabled={pending} onChange={event => setDraft({ ...draft, name: event.target.value })} /></Field>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Teacher" htmlFor="directory-teacher"><Input id="directory-teacher" maxLength={120} value={draft.teacher ?? ''} disabled={pending} onChange={event => setDraft({ ...draft, teacher: event.target.value })} /></Field>
      <Field label="Room" htmlFor="directory-room"><Input id="directory-room" maxLength={120} value={draft.room ?? ''} disabled={pending} onChange={event => setDraft({ ...draft, room: event.target.value })} /></Field>
    </div>
    <fieldset disabled={pending}><legend className="mb-2 text-sm">Grades</legend><div className="flex flex-wrap gap-2">{GRADES.map(grade => <Toggle key={grade} pressed={draft.grades.includes(grade)} onPressedChange={on => setDraft({ ...draft, grades: on ? [...draft.grades, grade] : draft.grades.filter(value => value !== grade) })}>{gradeLabel(grade)}</Toggle>)}</div></fieldset>
    <div className="flex gap-2"><Button size="sm" variant="primary" busy={pending} disabled={!draft.name.trim() || !draft.grades.length} onClick={() => void onSave(draft)}>Save shared class</Button><Button size="sm" variant="ghost" disabled={pending} onClick={onCancel}>Cancel edit</Button></div>
  </Panel>;
}
