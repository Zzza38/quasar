'use client';

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import { classSchema, personalScheduleSchema, type PersonalSchedule, type Schedule, type StudentClass } from '@/domain/schedule';
import { directoryCandidates, similarClassName } from '@/domain/class-match';
import { slugId } from '@/lib/format';
import { Button, Callout, Chip, Field, Hint, IconButton, Input, Modal, Spacer } from './primitives';
import { Icon, Spinner } from './icon';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';
import { Toggle } from './ui/toggle';
import { ClassNameInput, useClassDirectory, type DirectoryEntry } from './class-name-input';
import { isPdf, readPdf, MAX_PDF_TEXT } from './pdf-pages';
import { ScheduleSourceGuide } from './schedule-sources';
import { platformNames, type GuideSet } from '@/domain/setup-guides';

type ScanRow = RouterOutput['scan']['schedule']['rows'][number];
type ScanProgress = NonNullable<RouterOutput['scan']['progress']>;
type CloseUp = ScanProgress['closeUps'][number];
type Region = Pick<CloseUp, 'left' | 'top' | 'width' | 'height'>;
/** `scanned` remembers the directory class the scanner guessed, so the link holds only while the name is the one it read. */
type Draft = ScanRow & { include: boolean; scanned?: { name: string; directoryId: string }; correctName?: boolean; expectedVersion?: number; separate?: boolean };
/**
 * `pdf` is the PDF a page was rendered from: `id` is unique per upload (two files can share a name) and keys that PDF's
 * text, so removing its last page also drops its text; `name` is for display.
 */
type Photo = { image: string; mediaType: 'image/jpeg'; preview: string; pdf?: { id: string; name: string } };
const MAX_EDGE = 1600;
/** Matches MAX_SCAN_IMAGES on the server; one scan may carry this many photos. */
const MAX_PHOTOS = 3;
/** How often a running scan asks the server what it is doing. */
const PROGRESS_POLL_MS = 1000;
/** The thumbnail box (aspect-[3/4], object-cover) photos sit in when there are several. */
const THUMB_ASPECT = 3 / 4;

export type ScanStep = { label: string; detail?: string; state: 'done' | 'active' | 'todo' };
/**
 * The steps shown while a scan runs. `progress` is null until the server reports, which is while the pictures upload.
 * The close-up step only appears once the model asks for one.
 */
export function scanSteps(progress: ScanProgress | null, pictures: number): ScanStep[] {
  const closeUps = progress?.closeUps.length ?? 0;
  const zooming = !!progress && (progress.stage === 'zooming' || (progress.stage === 'reading' && progress.round > 0));
  const at = !progress ? 0 : progress.stage === 'checking' ? 3 : zooming ? 2 : 1;
  const state = (step: number): ScanStep['state'] => step < at ? 'done' : step === at ? 'active' : 'todo';
  return [
    { label: pictures === 1 ? 'Sending your picture' : `Sending ${pictures} pictures`, state: state(0) },
    { label: 'Reading the timetable', state: state(1) },
    ...(zooming || closeUps > 0 ? [{ label: 'Looking closer at hard-to-read parts', state: state(2),
      detail: progress?.stage === 'zooming' ? 'Cropping close-ups' : `${closeUps} ${closeUps === 1 ? 'close-up' : 'close-ups'} so far` }] : []),
    { label: "Matching classes to your school's periods", state: state(3) },
  ];
}

/** Where a close-up sits, in words: "Picture 2, top left, sharpened". */
export function describeCloseUp(closeUp: CloseUp, pictures: number): string {
  const across = closeUp.width >= 0.6 ? '' : ['left', 'middle', 'right'][Math.min(2, Math.floor((closeUp.left + closeUp.width / 2) * 3))];
  const down = closeUp.height >= 0.6 ? '' : ['top', 'middle', 'bottom'][Math.min(2, Math.floor((closeUp.top + closeUp.height / 2) * 3))];
  const where = across === 'middle' && down === 'middle' ? 'center' : [down, across].filter(Boolean).join(' ') || 'most of it';
  const extras = [closeUp.enhance ? 'sharpened' : '', closeUp.rotate ? 'turned' : ''].filter(Boolean);
  return [pictures > 1 ? `Picture ${closeUp.photo}` : 'Close-up', where, ...extras].join(', ');
}

/**
 * A close-up's region (fractions of the full picture) as fractions of a thumbnail that shows `image` with object-cover
 * in a box of aspect `box`, which trims the longer side evenly. Without `box` the thumbnail shows the whole picture.
 * Null when the region falls outside what the thumbnail shows.
 */
export function visibleRegion(region: Region, image?: { width: number; height: number }, box?: number): Region | null {
  if (!box) return region;
  if (!image || !image.width || !image.height) return null;
  const ratio = image.width / image.height;
  const shownX = ratio > box ? box / ratio : 1, shownY = ratio > box ? 1 : ratio / box;
  const left = (region.left - (1 - shownX) / 2) / shownX, top = (region.top - (1 - shownY) / 2) / shownY;
  const right = Math.min(1, left + region.width / shownX), bottom = Math.min(1, top + region.height / shownY);
  const shownLeft = Math.max(0, left), shownTop = Math.max(0, top);
  return right > shownLeft && bottom > shownTop ? { left: shownLeft, top: shownTop, width: right - shownLeft, height: bottom - shownTop } : null;
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/**
 * What a running scan is doing: the steps, how long it has taken, each close-up the model asked for, and the model's own
 * summary of its thinking when the provider sends one.
 */
function ScanProgressPanel({ progress, elapsed, pictures }: { progress: ScanProgress | null; elapsed: number; pictures: number }) {
  const steps = scanSteps(progress, pictures);
  const current = steps.find(step => step.state === 'active');
  return <div className="grid gap-3 rounded-2xl bg-muted/60 p-3 ring-1 ring-inset ring-foreground/[0.04]">
    <div className="flex items-center gap-2">
      <span className="text-sm font-semibold">Reading your schedule</span><Spacer />
      <span className="text-sm tabular-nums text-muted-foreground" aria-label={`${elapsed} seconds so far`}>{clock(elapsed)}</span>
    </div>
    <ol className="grid gap-2" aria-label="Scan progress">
      {steps.map(step => <li key={step.label} className={step.state === 'todo' ? 'flex items-start gap-2 text-sm text-muted-foreground' : 'flex items-start gap-2 text-sm'}>
        <span className="mt-0.5 grid size-4 place-items-center">
          {step.state === 'done' ? <Icon name="check" size={16} className="text-primary" /> : step.state === 'active' ? <Spinner size={16} className="text-primary" /> : <span className="size-1.5 rounded-full bg-muted-foreground/50" />}
        </span>
        <span className="grid gap-0.5">
          <span className={step.state === 'active' ? 'font-semibold' : undefined}>{step.label}</span>
          {step.detail && step.state !== 'todo' && <span className="text-xs text-muted-foreground">{step.detail}</span>}
        </span>
      </li>)}
    </ol>
    {progress && progress.closeUps.length > 0 && <ul className="flex flex-wrap gap-1.5" aria-label="Close-ups the scanner took">
      {progress.closeUps.map((closeUp, index) => <li key={index}><Chip tone="neutral" icon="search">{describeCloseUp(closeUp, pictures)}</Chip></li>)}
    </ul>}
    {progress?.thought && <figure className="grid gap-1">
      <figcaption className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground"><Icon name="sparkle" size={12} />What the scanner is thinking</figcaption>
      <blockquote className="text-sm leading-snug text-foreground/80">{progress.thought}</blockquote>
    </figure>}
    <span className="sr-only" role="status">{current ? `${current.label}${current.detail ? `. ${current.detail}` : ''}${progress?.thought ? `. ${progress.thought}` : ''}` : ''}</span>
    <Hint>A scan can take up to two minutes. Most of that is the model reading.</Hint>
  </div>;
}

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

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Wraps a scanned row for review, remembering any directory class the scanner matched it to. */
export function draftRow(row: ScanRow): Draft {
  return { ...row, include: true, ...(row.directoryId ? { scanned: { name: row.name, directoryId: row.directoryId } } : {}) };
}

/**
 * Renames a row under review. The directory link is only the scanner's guess, and a student who retypes
 * the name is usually correcting a wrong match, so the link is dropped until the name is set back.
 */
export function renameRow(row: Draft, name: string): Draft {
  const next: Draft = { ...row, name, correctName: false, expectedVersion: undefined, separate: false };
  if (row.scanned && same(name, row.scanned.name)) next.directoryId = row.scanned.directoryId;
  else delete next.directoryId;
  return next;
}

/**
 * For each row, the periods another included row also claims; a period holds one class, so the later row would win.
 * Rows that applyScan folds into the same class (by name, by directory class, or through a saved class matching
 * one by name and the other by directory) share periods harmlessly, so rows are compared by the class they land on.
 */
export function periodClashes(personal: PersonalSchedule, rows: Draft[]): { periodId: string; name: string }[][] {
  const { targets } = resolveScan(personal, rows);
  return rows.map((row, index) => targets[index] === null ? [] : row.periodIds.flatMap(periodId => rows
    .filter((other, otherIndex) => otherIndex !== index && targets[otherIndex] !== null && targets[otherIndex] !== targets[index] && other.periodIds.includes(periodId))
    .map(other => ({ periodId, name: other.name.trim() }))));
}

/** For each included row, the saved classes it takes a period from: the period's class is not the one the row lands on. */
export function replacedClasses(personal: PersonalSchedule, rows: Draft[]): { periodId: string; name: string }[][] {
  const { targets } = resolveScan(personal, rows);
  return rows.map((row, index) => targets[index] === null ? [] : row.periodIds.flatMap(periodId => {
    const cls = personal.classes.find(entry => entry.id === personal.assignments[periodId]);
    return cls && cls.id !== targets[index] ? [{ periodId, name: cls.name }] : [];
  }));
}

/** The saved class a row will be added to instead of creating a new one. */
const findClass = (classes: StudentClass[], row: Draft) => classes.find(cls => (row.directoryId && cls.directoryId === row.directoryId) || ((!row.directoryId || !cls.directoryId) && same(cls.name, row.name)));

export function scanSuggestions(row: Draft, entries: DirectoryEntry[]): DirectoryEntry[] {
  if (row.directoryId || row.separate || !row.name.trim()) return [];
  const candidates = directoryCandidates(row, entries);
  return [...candidates.matches, ...candidates.similar];
}

/** The row's typed teacher and room, trimmed, leaving out blanks. */
const details = (row: Draft) => ({ ...(row.teacher?.trim() ? { teacher: row.teacher.trim() } : {}), ...(row.room?.trim() ? { room: row.room.trim() } : {}) });

/**
 * When a row will reuse a saved class, the teacher and room that class keeps over what the student typed.
 * applyScan only fills a reused class's blank teacher or room, so a different typed value is not saved.
 */
export function keptDetails(classes: StudentClass[], row: Draft): { name: string; kept: string[] } | null {
  const cls = findClass(classes, row);
  if (!cls) return null;
  const typed = details(row);
  const kept = (['teacher', 'room'] as const).flatMap(field => {
    const saved = cls[field]?.trim();
    return saved && typed[field] && typed[field] !== saved ? [`${field} ${saved}`] : [];
  });
  return kept.length ? { name: cls.name, kept } : null;
}

/** The error to show after preparing picked photos; a single pick keeps prepareImage's own message. */
export function photoError(picked: number, failed: { name: string; message: string }[], added: number): string {
  if (picked === 1 && failed[0]) return failed[0].message;
  const each = failed.map(file => `${file.name || 'A file'}: ${file.message}`).join(' ');
  return `${each}${added === 1 ? ' The other photo was added.' : added > 1 ? ' The other photos were added.' : ''}`;
}

/**
 * Runs the confirmed rows against the student's classes. `targets` holds the class id each row lands on,
 * or null for a row that is left out, so the review hints agree with what saving does.
 */
function resolveScan(personal: PersonalSchedule, rows: Draft[]) {
  const classes = [...personal.classes];
  const assignments = { ...personal.assignments };
  const targets: (string | null)[] = [];
  for (const row of rows) {
    if (!row.include || !row.name.trim()) { targets.push(null); continue; }
    let existing = findClass(classes, row);
    if (!existing) {
      const id = row.directoryId && !classes.some(cls => cls.id === row.directoryId) ? row.directoryId : slugId(row.name, classes.map(cls => cls.id), 'class');
      existing = classSchema.parse({ id, name: row.name.trim(), ...(row.directoryId ? { directoryId: row.directoryId } : {}), ...details(row) });
      classes.push(existing);
    } else {
      // A reused class keeps what the student saved; the scan only fills a teacher or room it is missing.
      const typed = details(row);
      const fill = Object.fromEntries((['teacher', 'room'] as const).filter(field => typed[field] && !existing?.[field]?.trim()).map(field => [field, typed[field]]));
      if (Object.keys(fill).length || (!existing.directoryId && row.directoryId)) {
        const filled = classSchema.parse({ ...existing, ...fill, ...(row.directoryId ? { directoryId: row.directoryId } : {}) });
        classes[classes.indexOf(existing)] = filled;
        existing = filled;
      }
    }
    targets.push(existing.id);
    for (const periodId of row.periodIds) assignments[periodId] = existing.id;
  }
  return { classes, assignments, targets };
}

/** The free periods saving leaves empty: a period an included row also picks stays that row's class. */
export function freedPeriods(rows: Draft[], free: string[]): string[] {
  const claimed = new Set(rows.flatMap(row => row.include && row.name.trim() ? row.periodIds : []));
  return free.filter(periodId => !claimed.has(periodId));
}

/** The saved classes that free periods take off the timetable. */
export function clearedClasses(personal: PersonalSchedule, rows: Draft[], free: string[]): { periodId: string; name: string }[] {
  return freedPeriods(rows, free).flatMap(periodId => {
    const cls = personal.classes.find(entry => entry.id === personal.assignments[periodId]);
    return cls ? [{ periodId, name: cls.name }] : [];
  });
}

/**
 * Turns confirmed rows into saved classes and period assignments, reusing classes the student already has.
 * `free` holds the periods the timetable marks unassigned; they are left empty.
 */
export function applyScan(personal: PersonalSchedule, rows: Draft[], free: string[] = []): PersonalSchedule {
  const { classes, assignments } = resolveScan(personal, rows);
  for (const periodId of freedPeriods(rows, free)) delete assignments[periodId];
  return { ...personal, classes, assignments };
}

/**
 * Import a schedule from a PDF the school portal gives out, a screenshot, or photos of a printed copy. Platform tabs
 * say where each portal keeps its schedule. `onConnectFeed` offers the Veracross calendar subscription as well.
 */
export function ScanScheduleSheet({ open, onClose, accountId, schoolId, online, schedule, personal, disabled, onSave, onConnectFeed, guides }: {
  open: boolean; onClose: () => void; accountId: string; schoolId: string; online: boolean; schedule: Schedule; personal: PersonalSchedule; disabled?: boolean; onSave: (next: PersonalSchedule) => Promise<void>; onConnectFeed?: () => void; guides?: GuideSet;
}) {
  const { directory, error: directoryError, reload } = useClassDirectory(schoolId, open && online);
  const entries = (directory?.classes ?? []).filter(entry => !personal.grade || entry.grades.includes(personal.grade));
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  /** The text layer of each uploaded PDF, by its upload ID (Photo.pdf.id). */
  const [pdfTexts, setPdfTexts] = useState<Record<string, string>>({});
  const [limited, setLimited] = useState(false);
  const [rows, setRows] = useState<Draft[] | null>(null);
  /** The periods the scan found unassigned, and those the student keeps free. */
  const [freeFound, setFreeFound] = useState<string[]>([]);
  const [free, setFree] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  /** Set while a scan runs: `id` is the progress ID it reports under, so a late poll from an earlier scan is ignored. */
  const [scanning, setScanning] = useState<{ id: string; started: number; elapsed: number; progress: ScanProgress | null } | null>(null);
  /** Each picture's pixel size, by preview, to place close-up boxes on a cropped thumbnail. */
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const [error, setError] = useState('');
  const [savedNotice, setSavedNotice] = useState('');
  const clearResult = () => { setRows(null); setFreeFound([]); setFree([]); setNotes([]); };
  useEffect(() => { if (!open) { setPhotos([]); setPdfTexts({}); setSizes({}); setLimited(false); clearResult(); setError(''); setSavedNotice(''); } }, [open]);
  const run = async (action: () => Promise<void>) => { setPending(true); setError(''); try { await action(); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); } };
  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    setLimited(false);
    void run(async () => {
      const prepared: Photo[] = [];
      const texts: Record<string, string> = {};
      const failed: { name: string; message: string }[] = [];
      let room = MAX_PHOTOS - photos.length;
      let skipped = false;
      for (const file of files) {
        if (room <= 0) { skipped = true; break; }
        try {
          if (isPdf(file)) {
            // Each page becomes one of the scan's pictures; the PDF's text goes along so names are read exactly.
            const pdf = await readPdf(file, room);
            if (pdf.pages.length === 0) throw new Error('That PDF has no pages.');
            const source = { id: crypto.randomUUID(), name: file.name };
            prepared.push(...pdf.pages.map(page => ({ ...page, pdf: source })));
            if (pdf.text) texts[source.id] = pdf.text;
            if (pdf.total > pdf.pages.length) skipped = true;
            room -= pdf.pages.length;
          } else { prepared.push(await prepareImage(file)); room -= 1; }
        } catch (err) { failed.push({ name: file.name, message: errorMessage(err) }); }
      }
      setLimited(skipped);
      // Keep whatever was readable; a new set of pictures needs a fresh read, so any earlier result is dropped.
      if (prepared.length) {
        setPhotos(current => [...current, ...prepared].slice(0, MAX_PHOTOS));
        setPdfTexts(current => ({ ...current, ...texts }));
        clearResult();
      }
      if (failed.length) throw new Error(photoError(files.length, failed, prepared.length));
    });
  };
  const remove = (index: number) => {
    const removed = photos[index];
    const next = photos.filter((_, i) => i !== index);
    setPhotos(next);
    if (removed?.pdf && !next.some(photo => photo.pdf?.id === removed.pdf!.id)) setPdfTexts(({ [removed.pdf!.id]: _gone, ...rest }) => rest);
    setLimited(false); clearResult(); setError('');
  };
  const scan = () => run(async () => {
    if (photos.length === 0) return;
    const text = Object.values(pdfTexts).join('\n\n').slice(0, MAX_PDF_TEXT);
    const progressId = crypto.randomUUID();
    const started = Date.now();
    setScanning({ id: progressId, started, elapsed: 0, progress: null });
    // The scan is one long request; this asks the server what it is doing meanwhile. A failed poll just waits for the next.
    let asking = false;
    const poll = setInterval(() => {
      setScanning(current => current?.id === progressId ? { ...current, elapsed: Math.floor((Date.now() - started) / 1000) } : current);
      if (asking) return;
      asking = true;
      api.scan.progress.query({ progressId })
        .then(progress => { if (progress) setScanning(current => current?.id === progressId ? { ...current, progress } : current); }, () => {})
        .finally(() => { asking = false; });
    }, PROGRESS_POLL_MS);
    let result: RouterOutput['scan']['schedule'];
    try {
      result = await api.scan.schedule.mutate({ accountId, images: photos.map(({ image, mediaType }) => ({ image, mediaType })), ...(text ? { text } : {}), progressId });
    } finally {
      clearInterval(poll);
      setScanning(null);
    }
    setRows(result.rows.map(draftRow));
    setFreeFound(result.freePeriodIds);
    setFree(result.freePeriodIds);
    setNotes(result.notes);
  });
  const update = (index: number, patch: Partial<Draft>) => setRows(current => current?.map((row, i) => i === index ? { ...row, ...patch } : row) ?? null);
  const rename = (index: number, name: string) => setRows(current => current?.map((row, i) => i === index ? renameRow(row, name) : row) ?? null);
  const reviewDirectory = () => {
    reload();
    setRows(current => current?.map(row => ({ ...row, directoryId: undefined, scanned: undefined, correctName: false, expectedVersion: undefined, separate: false })) ?? null);
    setError('');
  };
  const ready = rows?.filter(row => row.include && row.name.trim()) ?? [];
  const unresolved = ready.some(row => scanSuggestions(row, entries).length > 0);
  const chooseClass = (index: number, entry: DirectoryEntry) => update(index, {
    name: entry.name, directoryId: entry.id, teacher: entry.teacher ?? '', room: entry.room ?? '',
    scanned: { name: entry.name, directoryId: entry.id }, correctName: false, expectedVersion: undefined, separate: false,
  });
  const freeing = rows ? freedPeriods(rows, free) : [];
  const save = () => run(async () => {
    if (!rows || (!ready.length && !freeing.length) || unresolved || !directory) return;
    personalScheduleSchema.parse(applyScan(personal, rows, free));
    let linked = rows, skipped = 0;
    if (ready.length) {
      const result = await api.directory.importClasses.mutate({ accountId, schoolId, grade: personal.grade,
        rows: ready.map(row => ({ name: row.name.trim(), ...details(row), directoryId: row.directoryId, correctName: row.correctName, expectedVersion: row.expectedVersion, separate: row.separate })),
      });
      let at = 0;
      linked = rows.map(row => {
        if (!row.include || !row.name.trim()) return row;
        const imported = result.rows[at++];
        const keepPersonalSpelling = row.correctName && !result.canEdit;
        return { ...row, ...imported, correctName: keepPersonalSpelling, expectedVersion: keepPersonalSpelling ? row.expectedVersion : undefined, separate: row.separate,
          scanned: !keepPersonalSpelling && imported.directoryId ? { name: imported.name, directoryId: imported.directoryId } : undefined };
      });
      skipped = result.skipped;
      // Keep the reconciled links if the personal save fails, so retrying cannot add another directory copy.
      setRows(linked);
    }
    await onSave(applyScan(personal, linked, free));
    if (skipped) setSavedNotice('Classes added to your timetable. The school directory is locked, so spelling corrections were saved in your personal copy only.');
    else onClose();
  });
  const label = (periodId: string) => schedule.periods.find(period => period.id === periodId)?.label ?? periodId;
  const clashes = rows ? periodClashes(personal, rows) : [];
  const replacements = rows ? replacedClasses(personal, rows) : [];
  const cleared = rows ? clearedClasses(personal, rows, free) : [];
  const claimed = new Set(ready.flatMap(row => row.periodIds));

  if (savedNotice) return <Modal open={open} onClose={onClose} title="Classes added" footer={<Button variant="primary" onClick={onClose}>Done</Button>}><Callout tone="success" role="status">{savedNotice}</Callout></Modal>;

  return <Modal open={open} onClose={onClose} dirty={rows !== null} busy={pending} wide title="Import your schedule" description={`Upload the schedule PDF from ${platformNames('schedule', guides) || 'your school portal'}, a screenshot, or photos of a printed copy. Check what was read, then add the classes to your timetable.`}
    footer={<><Button variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button><Spacer />
      {rows ? <Button variant="primary" icon="plus" busy={pending} disabled={disabled || !online || !directory || unresolved || (ready.length === 0 && freeing.length === 0)} onClick={() => void save()}>{ready.length === 0 && freeing.length > 0 ? `Save ${freeing.length} free ${freeing.length === 1 ? 'period' : 'periods'}` : `Add ${ready.length} ${ready.length === 1 ? 'class' : 'classes'}`}</Button>
        : <Button variant="primary" icon="sparkle" busy={pending} disabled={!online || photos.length === 0} onClick={() => void scan()}>Read schedule</Button>}</>}>
    <input ref={fileRef} type="file" accept="application/pdf,.pdf,image/*" className="sr-only" tabIndex={-1} aria-hidden="true" multiple aria-label="Choose a schedule PDF or picture" onChange={choose} />
    <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" aria-label="Take a timetable photo" onChange={choose} />
    {error && <Callout tone="danger" icon="alert" role="alert" actions={rows ? <Button size="sm" disabled={pending || !online} onClick={reviewDirectory}>Reload directory matches</Button> : undefined}>{error}</Callout>}
    {directoryError && <Callout tone="warning" role="alert" actions={<Button size="sm" disabled={pending || !online} onClick={reviewDirectory}>Reload directory</Button>}>{directoryError}</Callout>}
    {rows && directory && <Hint>{directory.canEdit ? 'Existing directory classes are reused. New included classes are also added to the school directory when you add them to your timetable.' : 'Existing directory classes are reused, and new classes are added to the school directory. Editing shared classes is locked, so spelling corrections stay in your personal copy.'}</Hint>}
    {unresolved && <Hint tone="danger">Confirm the possible directory matches below before adding your classes.</Hint>}
    {disabled && <Callout tone="warning" icon="alert">Retry sync before changing your saved classes.</Callout>}
    {photos.length === 0 && !rows ? <div className="grid gap-4">
      {/* Nothing picked yet: where to get the schedule comes first, then the pickers, so phones see the steps. */}
      <ScheduleSourceGuide guides={guides} onConnectFeed={onConnectFeed} />
      <div className="flex flex-wrap gap-2">
        <Button icon="plus" disabled={pending} onClick={() => fileRef.current?.click()}>Upload PDF or image</Button>
        <Button icon="camera" disabled={pending} onClick={() => cameraRef.current?.click()}>Take a photo</Button>
      </div>
      <Hint>A schedule PDF works best. A screenshot or a straight-on, well-lit photo works too. Files are sent to the scanning service for this scan only and are not stored.</Hint>
    </div> : <div className="grid gap-4 sm:grid-cols-[220px_minmax(0,1fr)]">
      <div className="grid content-start gap-2">
        <ul className={photos.length === 1 ? 'grid gap-2' : 'grid grid-cols-2 gap-2'} aria-label="Timetable photos">
          {photos.map((photo, index) => <li key={index} className="relative">
              <img src={photo.preview} onLoad={event => { const { naturalWidth: width, naturalHeight: height } = event.currentTarget; setSizes(current => current[photo.preview] ? current : { ...current, [photo.preview]: { width, height } }); }} alt={photo.pdf ? `Page ${photos.slice(0, index + 1).filter(entry => entry.pdf?.id === photo.pdf!.id).length} of ${photo.pdf.name}` : index === 0 ? 'Your timetable photo' : `Your timetable photo ${index + 1}`}
                className={photos.length === 1 ? 'w-full rounded-2xl bg-muted object-contain ring-1 ring-foreground/[0.06]' : 'aspect-[3/4] w-full rounded-xl bg-muted object-cover ring-1 ring-foreground/[0.06]'} />
              {scanning?.progress?.closeUps.map((closeUp, number) => {
                if (closeUp.photo !== index + 1) return null;
                const shown = visibleRegion(closeUp, sizes[photo.preview], photos.length === 1 ? undefined : THUMB_ASPECT);
                const latest = number === scanning.progress!.closeUps.length - 1;
                return shown && <span key={number} aria-hidden="true" className={latest ? 'pointer-events-none absolute rounded-sm bg-primary/10 ring-2 ring-primary' : 'pointer-events-none absolute rounded-sm ring-1 ring-primary/60'}
                  style={{ left: `${shown.left * 100}%`, top: `${shown.top * 100}%`, width: `${shown.width * 100}%`, height: `${shown.height * 100}%` }} />;
              })}
              <IconButton label={photo.pdf ? `Remove page ${index + 1}` : `Remove photo ${index + 1}`} icon="x" size="sm" variant="secondary" disabled={pending} className="absolute right-1.5 top-1.5 rounded-full" onClick={() => remove(index)} />
            </li>)}
        </ul>
        {limited && <Callout tone="warning" icon="alert" role="status">Up to three pages or photos are read. Keep the pages that show your classes.</Callout>}
        {photos.length < MAX_PHOTOS && <Button icon="plus" size="sm" disabled={pending} onClick={() => fileRef.current?.click()}>Add another file</Button>}
        {photos.length < MAX_PHOTOS && <Button icon="camera" size="sm" disabled={pending} onClick={() => cameraRef.current?.click()}>Take a photo</Button>}
        <Hint>Files are sent to the scanning service for this scan only and are not stored.</Hint>
      </div>
      <div className="grid content-start gap-3">
        {scanning ? <ScanProgressPanel progress={scanning.progress} elapsed={scanning.elapsed} pictures={photos.length} />
          : !rows && <Hint>Ready. Tap Read schedule.</Hint>}
        {notes.map(note => <Callout key={note} tone="info" icon="info">{note}</Callout>)}
        {rows && rows.length > 0 && <>
          <Hint>{rows.length} {rows.length === 1 ? 'class was' : 'classes were'} found. Fix anything that was misread, pick every period each class meets in, and untick what you do not take.</Hint>
          <ul className="grid gap-3" aria-label="Classes read from the photo">
            {rows.map((row, index) => {
              const replaces = (replacements[index] ?? []).map(entry => `${entry.name} on ${label(entry.periodId)}`);
              const shared = clashes[index] ?? [];
              const reused = row.include && row.name.trim() ? keptDetails(personal.classes, row) : null;
              const suggestions = scanSuggestions(row, entries);
              return <li key={index} className={row.include ? 'grid gap-2 rounded-2xl bg-muted/60 p-3 ring-1 ring-inset ring-foreground/[0.04]' : 'grid gap-2 rounded-2xl p-3 opacity-60 ring-1 ring-inset ring-foreground/[0.06]'}>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-2"><Checkbox id={`scan-include-${index}`} checked={row.include} disabled={pending} onCheckedChange={checked => update(index, { include: checked === true })} /><Label htmlFor={`scan-include-${index}`} className="text-sm font-semibold">Include</Label></div>
                  {row.directoryId && <Chip tone="accent" icon="school">From the school directory</Chip>}
                  {row.periodIds.length === 0 && <Chip tone="warning" icon="alert">{row.periodLabel ? `Could not match “${row.periodLabel}” to a period` : 'No period matched'}</Chip>}
                  {row.days.length > 0 && <Chip tone="neutral">{row.days.join(', ')}</Chip>}
                </div>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.7fr)]">
                  <Field label="Class" htmlFor={`scan-name-${index}`}><ClassNameInput id={`scan-name-${index}`} small maxLength={120} value={row.name} disabled={!row.include || pending} entries={entries} grade={personal.grade} onValueChange={name => rename(index, name)} onChoose={entry => chooseClass(index, entry)} /></Field>
                  <Field label="Teacher" htmlFor={`scan-teacher-${index}`}><Input id={`scan-teacher-${index}`} small maxLength={120} value={row.teacher ?? ''} disabled={!row.include || pending} onChange={event => update(index, { teacher: event.target.value })} /></Field>
                  <Field label="Room" htmlFor={`scan-room-${index}`}><Input id={`scan-room-${index}`} small maxLength={120} value={row.room ?? ''} disabled={!row.include || pending} onChange={event => update(index, { room: event.target.value })} /></Field>
                </div>
                {row.include && suggestions.length > 0 && <Callout tone="warning" title={`Is “${row.name}” already in the directory?`}>
                  <div className="grid gap-3">
                    {suggestions.map(entry => <div key={entry.id} className="grid gap-1.5">
                      <span><strong>{entry.name}</strong>{[entry.teacher, entry.room].filter(Boolean).length > 0 ? ` · ${[entry.teacher, entry.room].filter(Boolean).join(' · ')}` : ''}</span>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" disabled={pending} onClick={() => chooseClass(index, entry)}>Use “{entry.name}”</Button>
                        {similarClassName(row.name, entry.name) && row.name !== entry.name && <Button size="sm" disabled={pending} onClick={() => update(index, { directoryId: entry.id, correctName: true, expectedVersion: entry.version, scanned: undefined, separate: false })}>{directory?.canEdit ? `Same class, correct to “${row.name}”` : 'Same class, keep my spelling'}</Button>}
                      </div>
                    </div>)}
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => update(index, { separate: true })}>Different class</Button>
                  </div>
                </Callout>}
                {row.correctName && <Hint>{directory?.canEdit ? `You confirmed the same class. The directory name will change to “${row.name}” when you add your classes.` : 'Your spelling will be saved in your personal copy. The directory name is locked.'}</Hint>}
                <Field label="Periods" hint={row.periodIds.length === 0 ? 'Not placed yet. Tap every period this class meets in.' : undefined}>
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Periods for ${row.name || 'this class'}`}>
                    {schedule.periods.map(period => {
                      const on = row.periodIds.includes(period.id);
                      return <Toggle key={period.id} variant="outline" size="sm" pressed={on} disabled={!row.include || pending} className="min-w-[44px] rounded-full bg-card px-3 font-semibold data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                        onPressedChange={() => update(index, { periodIds: on ? row.periodIds.filter(id => id !== period.id) : schedule.periods.filter(entry => entry.id === period.id || row.periodIds.includes(entry.id)).map(entry => entry.id) })}>{period.label}</Toggle>;
                    })}
                  </div>
                </Field>
                {reused && <Hint>Adds to your saved {reused.name}, which keeps its {reused.kept.join(' and ')}. Change those in Classes.</Hint>}
                {replaces.length > 0 && <Hint tone="danger">Replaces {replaces.join(', ')}.</Hint>}
                {shared.length > 0 && <Hint tone="danger">Also picked for {shared.map(clash => `${clash.name} on ${label(clash.periodId)}`).join(', ')}. Only one class fits in a period, so keep it on one row.</Hint>}
              </li>;
            })}
          </ul>
        </>}
        {rows && freeFound.length > 0 && <div className="grid gap-2 rounded-2xl bg-muted/60 p-3 ring-1 ring-inset ring-foreground/[0.04]">
          <Field label="Free periods" hint="Your timetable shows these as unassigned or free, so they stay empty. Tap one off if you do have a class there.">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Free periods">
              {schedule.periods.filter(period => freeFound.includes(period.id)).map(period => {
                const taken = claimed.has(period.id);
                const on = !taken && free.includes(period.id);
                return <Toggle key={period.id} variant="outline" size="sm" pressed={on} disabled={taken || pending} title={taken ? 'A class above is picked for this period' : undefined}
                  className="min-w-[44px] rounded-full bg-card px-3 font-semibold data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                  onPressedChange={() => setFree(current => on ? current.filter(id => id !== period.id) : [...current, period.id])}>{period.label}</Toggle>;
              })}
            </div>
          </Field>
          {cleared.length > 0 && <Hint tone="danger">Clears {cleared.map(entry => `${entry.name} from ${label(entry.periodId)}`).join(', ')}.</Hint>}
        </div>}
      </div>
    </div>}
  </Modal>;
}
