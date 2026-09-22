'use client';

import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/client/api';
import { scheduledPeriodIds } from '@/domain/period-status';
import { classSchema, type PersonalSchedule, type Schedule, type StudentClass } from '@/domain/schedule';
import { classColor, slugId } from '@/lib/format';
import { Frame, STEP_CLASSES } from './onboarding';
import { Icon } from './icon';
import { Button, Callout, Chip, Field, Hint, IconButton, Input, Panel, Spacer } from './primitives';
import { SchoolDirectory } from './school-directory';
import { ScanScheduleSheet } from './scan-schedule';
import { Toggle } from './ui/toggle';

/**
 * The last setup step: the student adds the classes they take and taps the periods each one
 * meets in, so Today is populated before they ever see it. Everything here saves to the same
 * personal schedule the Classes view edits, so nothing is lost by skipping.
 */
export function ClassesStep({ userId, schoolId, schedule, personal, online, disabled, onSave, onDone, footer }: {
  userId: string; schoolId: string; schedule: Schedule; personal: PersonalSchedule; online: boolean; disabled?: boolean;
  onSave: (next: PersonalSchedule) => Promise<void>; onDone: () => void; footer: React.ReactNode;
}) {
  const [name, setName] = useState('');
  const [room, setRoom] = useState('');
  const [teacher, setTeacher] = useState('');
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [scanEnabled, setScanEnabled] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!online) return;
    let active = true;
    api.scan.status.query().then((result) => { if (active) setScanEnabled(result.enabled); }).catch(() => {});
    return () => { active = false; };
  }, [online]);
  const scheduled = scheduledPeriodIds(schedule);
  const periods = schedule.periods.filter((period) => period.kind === 'class' && scheduled.has(period.id));
  const run = async (next: PersonalSchedule) => {
    setPending(true); setError('');
    try { await onSave(next); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
  };
  const addClass = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const id = slugId(trimmed, personal.classes.map((cls) => cls.id), 'class');
    const cls = classSchema.parse({ id, name: trimmed, ...(room.trim() ? { room: room.trim() } : {}), ...(teacher.trim() ? { teacher: teacher.trim() } : {}) });
    await run({ ...personal, classes: [...personal.classes, cls] });
    setName(''); setRoom(''); setTeacher('');
  };
  const toggle = (cls: StudentClass, periodId: string) => {
    const assignments = { ...personal.assignments };
    if (assignments[periodId] === cls.id) delete assignments[periodId]; else assignments[periodId] = cls.id;
    void run({ ...personal, assignments });
  };
  const unplaced = personal.classes.filter((cls) => !Object.values(personal.assignments).includes(cls.id));
  const count = personal.classes.length;

  return <Frame step={STEP_CLASSES} wide title="Add your classes" description="Then tap the periods each class meets in. Today fills itself in from there." footer={footer}>
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    {disabled && <Callout tone="warning" icon="alert">Your saved schedule could not be read. Retry sync before adding classes.</Callout>}
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
      <form className="grid gap-2 rounded-2xl bg-muted/60 p-3 ring-1 ring-inset ring-foreground/[0.04] sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.7fr)_auto] sm:items-end" onSubmit={(event) => { event.preventDefault(); void addClass(); }}>
        <Field label="Class" htmlFor="setup-class-name"><Input id="setup-class-name" autoFocus maxLength={120} placeholder="Algebra II" value={name} disabled={pending || disabled} onChange={(event) => setName(event.target.value)} /></Field>
        <Field label="Teacher" htmlFor="setup-class-teacher"><Input id="setup-class-teacher" maxLength={120} placeholder="Ms. Ortiz" value={teacher} disabled={pending || disabled} onChange={(event) => setTeacher(event.target.value)} /></Field>
        <Field label="Room" htmlFor="setup-class-room"><Input id="setup-class-room" maxLength={120} placeholder="204" value={room} disabled={pending || disabled} onChange={(event) => setRoom(event.target.value)} /></Field>
        <Button type="submit" variant="primary" icon="plus" busy={pending} disabled={!name.trim() || disabled}>Add</Button>
      </form>
      <div className="grid content-end gap-2">
        <Button icon="search" disabled={!online || disabled} title={!online ? 'Connect to browse the directory.' : undefined} onClick={() => setDirectoryOpen(true)}>Pick from schoolmates’ classes</Button>
        {scanEnabled && <Button icon="camera" disabled={!online || disabled} onClick={() => setScanOpen(true)}>Scan a photo of my timetable</Button>}
      </div>
    </div>

    {count === 0 && <Panel className="grid gap-1 text-sm text-muted-foreground">
      <strong className="text-foreground">Start with one class.</strong>
      Type its name above, or pick from what schoolmates already added. You can add the rest now or later from the Classes page.
    </Panel>}

    {count > 0 && <ul className="grid gap-2" aria-label="Your classes">
      {personal.classes.map((cls) => {
        const color = classColor(cls.id, 'class', cls.color);
        const mine = periods.filter((period) => personal.assignments[period.id] === cls.id);
        return <li key={cls.id} className="grid gap-2 rounded-2xl bg-card p-3 ring-1 ring-foreground/[0.06]">
          <div className="flex flex-wrap items-center gap-3">
            <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-xl text-[14px] font-extrabold text-white" style={{ background: `linear-gradient(135deg, ${color.dot}, color-mix(in srgb, ${color.dot} 75%, #0b1020))` }}>{cls.name.trim().slice(0, 1).toUpperCase()}</span>
            <div className="min-w-0 flex-1"><strong className="block truncate text-[15px] font-bold">{cls.name}</strong><Hint>{[cls.teacher, cls.room && `Room ${cls.room}`].filter(Boolean).join(' · ') || 'No room or teacher yet'}</Hint></div>
            {mine.length === 0 ? <Chip tone="warning" icon="alert">Tap its periods</Chip> : <Chip tone="success" icon="check">{mine.length === 1 ? mine[0].label : `${mine.length} periods`}</Chip>}
            <IconButton size="sm" icon="trash" label={`Remove ${cls.name}`} disabled={pending || disabled} onClick={() => void run({ ...personal, classes: personal.classes.filter((entry) => entry.id !== cls.id), assignments: Object.fromEntries(Object.entries(personal.assignments).filter(([, classId]) => classId !== cls.id)) })} />
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Periods for ${cls.name}`}>
            {periods.map((period) => {
              const on = personal.assignments[period.id] === cls.id;
              const other = !on && personal.assignments[period.id] ? personal.classes.find((entry) => entry.id === personal.assignments[period.id]) : null;
              return <Toggle key={period.id} variant="outline" size="sm" pressed={on} disabled={pending || disabled} title={other ? `Currently ${other.name}` : undefined}
                className="min-w-[44px] rounded-full bg-card px-3 font-semibold data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                onPressedChange={() => toggle(cls, period.id)}>{period.label}{other ? <span className="ml-1 text-[10px] opacity-60">· {other.name.slice(0, 8)}</span> : null}</Toggle>;
            })}
          </div>
        </li>;
      })}
    </ul>}

    <div className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" onClick={onDone} disabled={pending}>Skip for now</Button>
      <Spacer />
      <div className="grid justify-items-end gap-1">
        <Button variant="primary" size="lg" iconRight="arrowRight" disabled={count === 0 || pending} onClick={onDone}>Next: homework</Button>
        {count > 0 && unplaced.length > 0 && <Hint role="status"><Icon name="info" size={12} className="mr-1 inline" />{unplaced.length === 1 ? `${unplaced[0].name} has` : `${unplaced.length} classes have`} no period yet. That is fine, you can place them later.</Hint>}
      </div>
    </div>

    {directoryOpen && <SchoolDirectory schoolId={schoolId} online={online} personal={personal} onClose={() => setDirectoryOpen(false)} onAdd={async (classes) => {
      if (disabled) throw new Error('Retry sync before changing your saved classes.');
      const added = classes.filter((cls) => !personal.classes.some((existing) => existing.id === cls.id || existing.directoryId === cls.directoryId));
      await onSave({ ...personal, classes: [...personal.classes, ...added] });
    }} />}
    <ScanScheduleSheet open={scanOpen} onClose={() => setScanOpen(false)} accountId={userId} schedule={schedule} personal={personal} disabled={disabled} onSave={onSave} />
  </Frame>;
}
