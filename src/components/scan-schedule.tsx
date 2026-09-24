'use client';

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import { classSchema, type PersonalSchedule, type Schedule, type StudentClass } from '@/domain/schedule';
import { slugId } from '@/lib/format';
import { Button, Callout, Chip, Field, Hint, IconButton, Input, Modal, Spacer } from './primitives';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';
import { Toggle } from './ui/toggle';

type ScanRow = RouterOutput['scan']['schedule']['rows'][number];
type Draft = ScanRow & { include: boolean };
type Photo = { image: string; mediaType: 'image/jpeg'; preview: string };
const MAX_EDGE = 1600;
/** Matches MAX_SCAN_IMAGES on the server; one scan may carry this many photos. */
const MAX_PHOTOS = 3;

/** Downscales the photo in the browser so uploads stay small and the model gets a clean JPEG. */
export async function prepareImage(file: File): Promise<Photo> {
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('That file is not an image the browser can read.'); });
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not process the photo on this device.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let quality = 0.85;
    let preview = canvas.toDataURL('image/jpeg', quality);
    while (preview.length > 1_400_000 && quality > 0.4) { quality -= 0.15; preview = canvas.toDataURL('image/jpeg', quality); }
    return { image: preview.slice(preview.indexOf(',') + 1), mediaType: 'image/jpeg', preview };
  } finally { bitmap.close(); }
}

/** Turns confirmed rows into saved classes and period assignments, reusing classes the student already has. */
export function applyScan(personal: PersonalSchedule, rows: Draft[]): PersonalSchedule {
  const classes = [...personal.classes];
  const assignments = { ...personal.assignments };
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  for (const row of rows) {
    if (!row.include || !row.name.trim()) continue;
    let existing = classes.find(cls => (row.directoryId && cls.directoryId === row.directoryId) || same(cls.name, row.name));
    if (!existing) {
      const id = row.directoryId && !classes.some(cls => cls.id === row.directoryId) ? row.directoryId : slugId(row.name, classes.map(cls => cls.id), 'class');
      existing = classSchema.parse({ id, name: row.name.trim(), ...(row.directoryId ? { directoryId: row.directoryId } : {}), ...(row.room?.trim() ? { room: row.room.trim() } : {}), ...(row.teacher?.trim() ? { teacher: row.teacher.trim() } : {}) });
      classes.push(existing);
    }
    for (const periodId of row.periodIds) assignments[periodId] = existing.id;
  }
  return { ...personal, classes, assignments };
}

export function ScanScheduleSheet({ open, onClose, accountId, schedule, personal, disabled, onSave }: {
  open: boolean; onClose: () => void; accountId: string; schedule: Schedule; personal: PersonalSchedule; disabled?: boolean; onSave: (next: PersonalSchedule) => Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [limited, setLimited] = useState(false);
  const [rows, setRows] = useState<Draft[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!open) { setPhotos([]); setLimited(false); setRows(null); setNotes([]); setError(''); } }, [open]);
  const run = async (action: () => Promise<void>) => { setPending(true); setError(''); try { await action(); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); } };
  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    const accepted = files.slice(0, Math.max(0, MAX_PHOTOS - photos.length));
    setLimited(accepted.length < files.length);
    if (accepted.length === 0) return;
    void run(async () => {
      const prepared: Photo[] = [];
      try { for (const file of accepted) prepared.push(await prepareImage(file)); } finally {
        // Keep whatever was readable; a new set of photos needs a fresh read, so any earlier result is dropped.
        if (prepared.length) { setPhotos(current => [...current, ...prepared].slice(0, MAX_PHOTOS)); setRows(null); setNotes([]); }
      }
    });
  };
  const remove = (index: number) => { setPhotos(current => current.filter((_, i) => i !== index)); setLimited(false); setRows(null); setNotes([]); setError(''); };
  const scan = () => run(async () => {
    if (photos.length === 0) return;
    const result = await api.scan.schedule.mutate({ accountId, images: photos.map(({ image, mediaType }) => ({ image, mediaType })) });
    setRows(result.rows.map(row => ({ ...row, include: true })));
    setNotes(result.notes);
  });
  const update = (index: number, patch: Partial<Draft>) => setRows(current => current?.map((row, i) => i === index ? { ...row, ...patch } : row) ?? null);
  const ready = rows?.filter(row => row.include && row.name.trim()) ?? [];
  const label = (periodId: string) => schedule.periods.find(period => period.id === periodId)?.label ?? periodId;
  const replaced = (row: Draft) => row.periodIds.flatMap(periodId => { const cls = personal.classes.find(entry => entry.id === personal.assignments[periodId]); return cls && cls.name.trim().toLowerCase() !== row.name.trim().toLowerCase() ? [`${cls.name} on ${label(periodId)}`] : []; });

  return <Modal open={open} onClose={onClose} dirty={rows !== null} busy={pending} wide title="Scan your timetable" description="Take up to three photos of a printed or on-screen schedule, for example both halves of a wide timetable. Check what was read, then add the classes to your timetable."
    footer={<><Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button><Spacer />
      {rows ? <Button variant="primary" icon="plus" busy={pending} disabled={disabled || ready.length === 0} onClick={() => void run(async () => { await onSave(applyScan(personal, rows)); onClose(); })}>Add {ready.length} {ready.length === 1 ? 'class' : 'classes'}</Button>
        : <Button variant="primary" icon="sparkle" busy={pending} disabled={photos.length === 0} onClick={() => void scan()}>Read schedule</Button>}</>}>
    <input ref={fileRef} type="file" accept="image/*" capture="environment" className="sr-only" multiple aria-label="Choose a timetable photo" onChange={choose} />
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    {disabled && <Callout tone="warning" icon="alert">Retry sync before changing your saved classes.</Callout>}
    <div className="grid gap-4 sm:grid-cols-[220px_minmax(0,1fr)]">
      <div className="grid content-start gap-2">
        {photos.length > 0
          ? <ul className={photos.length === 1 ? 'grid gap-2' : 'grid grid-cols-2 gap-2'} aria-label="Timetable photos">
            {photos.map((photo, index) => <li key={index} className="relative">
              <img src={photo.preview} alt={index === 0 ? 'Your timetable photo' : `Your timetable photo ${index + 1}`}
                className={photos.length === 1 ? 'w-full rounded-2xl bg-muted object-contain ring-1 ring-foreground/[0.06]' : 'aspect-[3/4] w-full rounded-xl bg-muted object-cover ring-1 ring-foreground/[0.06]'} />
              <IconButton label={`Remove photo ${index + 1}`} icon="x" size="sm" variant="secondary" disabled={pending} className="absolute right-1.5 top-1.5 rounded-full" onClick={() => remove(index)} />
            </li>)}
          </ul>
          : <div className="grid aspect-[3/4] place-items-center rounded-2xl border border-dashed border-foreground/15 bg-muted/50 p-4 text-center text-xs text-muted-foreground">Straight-on, well lit, whole timetable in frame. A wide timetable can take up to three photos.</div>}
        {limited && <Callout tone="warning" icon="alert" role="status">You can add up to three photos.</Callout>}
        {photos.length < MAX_PHOTOS && <Button icon="camera" size="sm" disabled={pending} onClick={() => fileRef.current?.click()}>{photos.length === 0 ? 'Take or choose a photo' : 'Add another photo'}</Button>}
        <Hint>Photos are sent to the scanning service once and are not stored.</Hint>
      </div>
      <div className="grid content-start gap-3">
        {!rows && <Hint>{photos.length > 0 ? 'Ready. Tap Read schedule.' : 'Add a photo to begin.'}</Hint>}
        {notes.map(note => <Callout key={note} tone="info" icon="info">{note}</Callout>)}
        {rows && rows.length > 0 && <>
          <Hint>{rows.length} {rows.length === 1 ? 'class was' : 'classes were'} found. Fix anything that was misread, pick every period each class meets in, and untick what you do not take.</Hint>
          <ul className="grid gap-3" aria-label="Classes read from the photo">
            {rows.map((row, index) => {
              const replaces = row.include ? replaced(row) : [];
              return <li key={index} className={row.include ? 'grid gap-2 rounded-2xl bg-muted/60 p-3 ring-1 ring-inset ring-foreground/[0.04]' : 'grid gap-2 rounded-2xl p-3 opacity-60 ring-1 ring-inset ring-foreground/[0.06]'}>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-2"><Checkbox id={`scan-include-${index}`} checked={row.include} onCheckedChange={checked => update(index, { include: checked === true })} /><Label htmlFor={`scan-include-${index}`} className="text-sm font-semibold">Include</Label></div>
                  {row.directoryId && <Chip tone="accent" icon="school">From the school directory</Chip>}
                  {row.periodIds.length === 0 && <Chip tone="warning" icon="alert">{row.periodLabel ? `Could not match “${row.periodLabel}” to a period` : 'No period matched'}</Chip>}
                  {row.days.length > 0 && <Chip tone="neutral">{row.days.join(', ')}</Chip>}
                </div>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.7fr)]">
                  <Field label="Class" htmlFor={`scan-name-${index}`}><Input id={`scan-name-${index}`} small maxLength={120} value={row.name} disabled={!row.include} onChange={event => update(index, { name: event.target.value })} /></Field>
                  <Field label="Teacher" htmlFor={`scan-teacher-${index}`}><Input id={`scan-teacher-${index}`} small maxLength={120} value={row.teacher ?? ''} disabled={!row.include} onChange={event => update(index, { teacher: event.target.value })} /></Field>
                  <Field label="Room" htmlFor={`scan-room-${index}`}><Input id={`scan-room-${index}`} small maxLength={120} value={row.room ?? ''} disabled={!row.include} onChange={event => update(index, { room: event.target.value })} /></Field>
                </div>
                <Field label="Periods" hint={row.periodIds.length === 0 ? 'Not placed yet. Tap every period this class meets in.' : undefined}>
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Periods for ${row.name || 'this class'}`}>
                    {schedule.periods.map(period => {
                      const on = row.periodIds.includes(period.id);
                      return <Toggle key={period.id} variant="outline" size="sm" pressed={on} disabled={!row.include} className="min-w-[44px] rounded-full bg-card px-3 font-semibold data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                        onPressedChange={() => update(index, { periodIds: on ? row.periodIds.filter(id => id !== period.id) : schedule.periods.filter(entry => entry.id === period.id || row.periodIds.includes(entry.id)).map(entry => entry.id) })}>{period.label}</Toggle>;
                    })}
                  </div>
                </Field>
                {replaces.length > 0 && <Hint tone="danger">Replaces {replaces.join(', ')}.</Hint>}
              </li>;
            })}
          </ul>
        </>}
      </div>
    </div>
  </Modal>;
}
