'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { PersonalSchedule, Schedule, StudentClass } from '@/domain/schedule';
import { heroBase } from '@/lib/color';
import { classColor, formatRoom } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AppState } from '../app-state';
import { ClassAssignmentGrid } from '../class-assignment-grid';
import { Icon } from '../icon';
import { Chip, EmptyState, Eyebrow, Hint, IconButton, Section } from '../primitives';
import { PaletteChip, type PaletteEntry } from '../schedule-grid';
import { editSchedule } from '../schedule-lock';
import { Card } from '../ui/card';

/** The white initial on a class avatar: light class colours are darkened just enough for 4.5:1, as on the Now card. */
export const classInitialBackground = (dot: string) => { const base = heroBase(dot); return `linear-gradient(135deg, ${base}, color-mix(in srgb, ${base} 75%, #0b1020))`; };

/** Where a class stands on the timetable: how many rotation days it meets on, or why it does not meet yet. */
export type ClassPlacement = { days: number; placed: boolean };

/**
 * The Classes page as one board (beta `classes-board`): the classes are a list beside the timetable instead of
 * cards above it. A row is the class's handle (drag it onto a block, or tap it and then the block) and its pencil
 * opens the class in place. While the schedule is locked, tapping a row lights the class up in the timetable.
 */
export function ClassesBoard({ state, schedule, school, personal, placement, editing, onEdit, editor, actions, adjustments, notices, onSchoolCorrection, onMounted }: {
  state: AppState; schedule: Schedule; school: Schedule; personal: PersonalSchedule;
  placement: (cls: StudentClass) => ClassPlacement;
  /** The class open for editing, and the form drawn under its row. */
  editing: string | null; onEdit: (id: string | null) => void; editor: (cls: StudentClass) => ReactNode;
  /** Buttons under the list (browse, import), the Adjustments controls, and warnings shown above the timetable. */
  actions: ReactNode; adjustments: ReactNode; notices?: ReactNode;
  onSchoolCorrection: (schedule: Schedule, onSaved?: () => void) => void;
  /** Tells the page the list is on screen, so a class opens here rather than in the dialog. */
  onMounted: (mounted: boolean) => void;
}) {
  useEffect(() => { onMounted(true); return () => onMounted(false); }, [onMounted]);
  const [found, setFound] = useState<string | null>(null);
  const locked = !state.personalValid || !!personal.scheduleLocked;
  const total = schedule.cycleDays.length;
  const open = personal.classes.find((cls) => cls.id === editing) ?? null;
  const lit = open?.id ?? (locked && personal.classes.some((cls) => cls.id === found) ? found : null);
  const meets = (cls: StudentClass) => {
    const { days, placed } = placement(cls);
    return !placed ? 'Not on your timetable yet' : days === 0 ? 'No times set' : total === 1 ? 'On your timetable' : days === total ? 'Meets every day' : `Meets ${days} of ${total} days`;
  };

  const list = (entries: PaletteEntry[]) => <>
    <Card className="gap-0 px-2 py-2 sm:py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 px-2.5 pt-2 pb-1.5"><Eyebrow>Classes</Eyebrow>{personal.classes.length > 0 && <Hint>{locked ? 'Tap one to find it' : 'Drag one onto a block'}</Hint>}</div>
      {personal.classes.length === 0 && <EmptyState icon="book" title="No classes yet">Add the classes you take, then drop each one onto its block in the timetable.</EmptyState>}
      {personal.classes.length > 0 && <ul className="grid gap-0.5" aria-label="Your classes">
        {personal.classes.map((cls) => {
          const entry = entries.find((item) => item.cls?.id === cls.id);
          const { days, placed } = placement(cls);
          const color = classColor(cls.id, 'class', cls.color);
          const isOpen = open?.id === cls.id;
          const pressed = locked ? lit === cls.id && !isOpen : !!entry?.active;
          return <li key={cls.id} className={cn('rounded-xl', isOpen && 'my-1 bg-foreground/[0.04] inset-ring-1 inset-ring-input')}>
            <div className="flex items-center gap-1 pr-1.5">
              <button type="button" aria-pressed={pressed}
                className={cn('board-class flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2.5 py-2 text-left outline-none transition-colors hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring', pressed && 'bg-foreground/[0.06] inset-ring-1 inset-ring-input hover:bg-foreground/[0.06]', entry?.lifted && 'opacity-50')}
                onPointerDown={entry && !locked ? entry.onPointerDown : undefined}
                onClick={(event) => { if (locked || !entry) setFound(found === cls.id ? null : cls.id); else entry.onClick(event); }}>
                <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-[11px] text-sm font-extrabold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25)]" style={{ background: classInitialBackground(color.dot) }}>{cls.name.trim().slice(0, 1).toUpperCase()}</span>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <strong className="line-clamp-2 text-sm leading-tight font-bold tracking-tight break-words"><span className="sr-only">{locked ? 'Find ' : 'Place '}</span>{cls.name}</strong>
                  <span className="truncate text-xs text-muted-foreground">{!locked && entry?.active ? 'Selected. Tap a block.' : cls.room || cls.teacher ? [cls.room && formatRoom(cls.room), cls.teacher].filter(Boolean).join(' · ') : <i>No room or teacher yet</i>}</span>
                </span>
                {!placed ? <Chip tone="warning" icon="alert" className="shrink-0 whitespace-nowrap">Not placed</Chip>
                  : days === 0 ? <Chip tone="warning" className="shrink-0 whitespace-nowrap">No times set</Chip>
                  : total > 1 && <span className="shrink-0 text-xs font-semibold tabular-nums text-muted-foreground" title={meets(cls)}>{days === total ? 'Every day' : `${days} of ${total}`}</span>}
              </button>
              {isOpen ? <IconButton size="sm" icon="chevronDown" label={`Close ${cls.name}`} aria-expanded onClick={() => onEdit(null)} />
                : <IconButton size="sm" icon="edit" label={`Edit ${cls.name}`} aria-expanded={false} onClick={() => editSchedule(state, () => onEdit(cls.id))} />}
            </div>
            {isOpen && editor(cls)}
          </li>;
        })}
      </ul>}
      {/* Lunch, advisory and the like can be placed too; they only matter while the timetable can change. */}
      {!locked && entries.some((entry) => !entry.cls) && <div className="timetable-palette-items board-also" role="group" aria-label="Other periods"><Hint className="mr-1 font-semibold">Also</Hint>{entries.filter((entry) => !entry.cls).map((entry) => <PaletteChip key={entry.period.id} entry={entry} />)}</div>}
      <div className="mt-2 flex flex-wrap gap-1.5 border-t px-2.5 pt-3 pb-1.5">{actions}</div>
    </Card>
    <Section id="adjust-title" title="Adjustments" description="Change one date or one rotation day, for yourself only." className="overflow-visible">{adjustments}</Section>
  </>;

  const note = (entries: PaletteEntry[]) => {
    const shown = personal.classes.find((cls) => cls.id === (lit ?? entries.find((entry) => entry.active)?.cls?.id));
    if (shown) return <><strong>{shown.name}</strong><span>{meets(shown)}</span></>;
    return locked ? <><strong><Icon name="lock" size={13} />Locked</strong><span>Unlock to move classes or change times.</span></>
      : <><strong>Unlocked</strong><span>Drag a class onto a block, or tap it and then the block.</span></>;
  };

  return <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
    {notices}
    <ClassAssignmentGrid schedule={schedule} schoolSchedule={school} personal={personal} save={state.savePersonal} disabled={locked} onSchoolCorrection={onSchoolCorrection} board={{ palette: list, note, highlight: lit }} />
  </div>;
}
