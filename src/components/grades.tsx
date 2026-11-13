'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import { LETTER_CUTOFFS, classGrade, type Calibration, type ClassGrades, type Scenario } from '@/domain/grade-math';
import { anchor, categoryLines, defaultGoal, displayNeeded, formatPercent, goalLabel, goalPercent, gradeCounts, letterFor, openWork, outlook, parseGoalPercent, planCategories, resolvePlan, rulerPosition, rulerWindow,
  type GradeCounts, type GradeGoal, type OpenWork, type PlanTarget, type SavedGoal } from '@/domain/grade-goals';
import type { StudentClass } from '@/domain/schedule';
import { useIsMobile } from '@/hooks/use-mobile';
import { heroBase } from '@/lib/color';
import { classColor, formatDate, formatRoom, pluralize } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AppState } from './app-state';
import { Icon } from './icon';
import { Button, Callout, Chip, EmptyState, Field, Hint, IconButton, Input, Modal, Select } from './primitives';
import { SchoologyConnect, SchoologySettings, useSchoologyConnection } from './schoology-grades';
import { Card } from './ui/card';

/**
 * Classes → Grades, part of the `schoology-connect` beta. One card per Schoology class: the grade Schoology reports,
 * a ruler from that grade to the member's goal, and the score the next piece of work needs. Opening a class shows its
 * gradebook, the goal (a letter or a custom percent) and what-if scores. Grades are read from Schoology and held in
 * memory only; goals are the one thing saved (SchoologyService.setGoal). The math is src/domain/grade-math.ts and
 * src/domain/grade-goals.ts, and runs in the browser.
 */

type Book = RouterOutput['schoology']['gradebook'];
type Goals = Record<string, SavedGoal>;
type Typed = Record<string, string>;

/** Everything the page shows for one class, worked out once per gradebook and goal change. */
export type GradeClass = {
  id: string; title: string; schoologyTitle: string; detail: ClassGrades; gradeText: string | null; color: string; teacher: string | null; room: string | null;
  calibration: Calibration; open: OpenWork[]; uncounted: number; counts: GradeCounts;
  /** The grade Schoology reports, or null when it shows none (or a letter without a percent). */
  now: number | null;
  goal: GradeGoal | null; goalSaved: boolean; target: number | null; plan: PlanTarget | null;
};

export function gradeClasses(book: Book, goals: Goals, classes: readonly StudentClass[]): GradeClass[] {
  return book.classes.map(({ detail, grade, classId }) => {
    const mine = classes.find(entry => entry.id === classId) ?? null;
    const calibration = anchor(detail);
    const { open, uncounted } = openWork(detail, calibration);
    const now = detail.reported;
    const saved = goals[detail.sectionId];
    const goal = now === null ? null : saved?.goal ?? defaultGoal(now);
    return {
      id: detail.sectionId, title: mine?.name ?? detail.title, schoologyTitle: detail.title, detail, gradeText: grade,
      color: classColor(mine?.id ?? `schoology-${detail.sectionId}`, 'class', mine?.color).dot, teacher: mine?.teacher ?? null, room: mine?.room ? formatRoom(mine.room) : null,
      calibration, open, uncounted, counts: gradeCounts(detail, open), now,
      goal, goalSaved: !!saved?.goal, target: goal ? goalPercent(goal) : null, plan: resolvePlan(detail, calibration, open, saved?.plan ?? null),
    };
  });
}

const points = (value: number) => `${Math.round(value * 100) / 100}`;
const parseScore = (text: string) => { const value = Number(text); return text.trim() !== '' && Number.isFinite(value) && value >= 0 ? value : null; };
const scenarioOf = (typed: Typed): Scenario => ({ scores: Object.fromEntries(Object.entries(typed).flatMap(([id, text]) => { const value = parseScore(text); return value === null ? [] : [[id, value]]; })) });
const dueText = (due: string | null, today: string) => due ? `${due < today ? 'Was due' : 'Due'} ${formatDate(due)}` : null;
/** The white initial on a class tile, as on the Classes cards. */
const tile = (color: string) => { const base = heroBase(color); return `linear-gradient(135deg, ${base}, color-mix(in srgb, ${base} 75%, #0b1020))`; };
const FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

function Tile({ cls, small }: { cls: GradeClass; small?: boolean }) {
  return <span aria-hidden="true" className={cn('grid shrink-0 place-items-center font-extrabold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25)]', small ? 'size-8 rounded-[10px] text-[13px]' : 'size-10 rounded-xl text-[15px]')} style={{ background: tile(cls.color) }}>{cls.title.trim().slice(0, 1).toUpperCase()}</span>;
}
function Letter({ percent, small }: { percent: number | null; small?: boolean }) {
  const letter = letterFor(percent);
  return letter ? <span className={cn('inline-grid place-items-center rounded-md bg-secondary font-extrabold text-foreground', small ? 'h-5 min-w-6 px-1.5 text-[11.5px]' : 'h-6 min-w-[30px] px-[7px] text-[12.5px]')}>{letter}</span> : null;
}

/**
 * The goal ruler. Solid ring: the grade in Schoology. Flag: the goal. Dashed ring: a what-if. Percent cutoffs sit
 * above the track and their letters below it.
 */
export function Ruler({ color, now, goal, whatIf = null }: { color: string; now: number; goal: number; whatIf?: number | null }) {
  const { lo, hi, ticks } = rulerWindow([now, goal, whatIf]);
  const at = (value: number) => `${rulerPosition(value, lo, hi)}%`;
  const span = (a: number, b: number): CSSProperties => ({ left: at(Math.min(a, b)), width: `${Math.abs(rulerPosition(a, lo, hi) - rulerPosition(b, lo, hi))}%` });
  return <div role="img" aria-label={`Now ${formatPercent(now)}, goal ${formatPercent(goal)}${whatIf === null ? '' : `, what if ${formatPercent(whatIf)}`}`} className="relative mx-2 h-[68px]" style={{ '--c': color } as CSSProperties}>
    <div className="absolute -inset-x-2 top-9 h-2 rounded-full bg-foreground/[0.08]" />
    <div className="absolute top-9 h-2 rounded-full bg-[color-mix(in_srgb,var(--c)_34%,transparent)]" style={span(now, goal)} />
    {ticks.map(tick => <span key={tick.letter} aria-hidden="true">
      <span data-ruler="percent" className="absolute top-0 -translate-x-1/2 text-[10px] font-semibold whitespace-nowrap text-muted-foreground tabular-nums" style={{ left: at(tick.percent) }}>{tick.percent}%</span>
      <span className="absolute top-8 h-4 w-px bg-foreground/20" style={{ left: at(tick.percent) }} />
      <span data-ruler="letter" className={cn('absolute top-[52px] -translate-x-1/2 text-[11px] font-bold', Math.abs(tick.percent - goal) < 1e-9 ? 'font-extrabold text-foreground' : 'text-muted-foreground')} style={{ left: at(tick.percent) }}>{tick.letter}</span>
    </span>)}
    <span aria-hidden="true" className="absolute top-4 -ml-px text-foreground" style={{ left: at(goal) }}><Icon name="flag" size={14} strokeWidth={2.2} /></span>
    {whatIf !== null && <div aria-hidden="true" className="absolute top-[39px] h-0 border-t-2 border-dashed border-primary/55" style={span(now, whatIf)} />}
    <div aria-hidden="true" className="absolute top-[31px] -ml-[9px] size-[18px] rounded-full border-4 border-[var(--c)] bg-card shadow-card" style={{ left: at(now) }} />
    {whatIf !== null && <div aria-hidden="true" className="absolute top-[30px] -ml-2.5 size-5 rounded-full border-2 border-dashed border-primary" style={{ left: at(whatIf) }} />}
  </div>;
}

/** What the plan leans on, as it reads mid-sentence. */
function planName(cls: GradeClass, plan: PlanTarget): string {
  if (plan.kind === 'newExam') return `a final exam worth ${points(plan.weight)}%`;
  if (plan.kind === 'extra') return `a new ${points(plan.max)}-point ${cls.detail.categories.find(category => category.id === plan.categoryId)?.title ?? ''} assignment`.replace('  ', ' ');
  return cls.open.find(entry => entry.id === plan.id)?.title ?? 'that assignment';
}

/** The actionable line: the score the plan's assignment needs. With what-if scores typed it re-plans around them, and looks different. */
export function PlanLine({ cls, scenario = {}, today, flat }: { cls: GradeClass; scenario?: Scenario; today: string; flat?: boolean }) {
  if (!cls.goal || cls.target === null) return null;
  const view = outlook(cls.detail, cls.calibration, cls.target, cls.plan, scenario);
  if (!view) return null;
  const label = goalLabel(cls.goal), about = cls.calibration.approximate ? 'about ' : '';
  const name = cls.plan ? planName(cls, cls.plan) : '';
  const due = cls.plan?.kind === 'item' ? cls.open.find(entry => entry.id === (cls.plan as { id: string }).id)?.due ?? null : null;
  const hypothetical = view.kind === 'projected' || (view.kind === 'need' && view.trying);
  let tone: 'reach' | 'ok' | 'out' = 'reach', icon: 'target' | 'check' | 'alert' | 'sparkle' = 'target', body: ReactNode;
  if (view.kind === 'projected') {
    body = <>With these scores you’d finish at <strong className="tabular-nums">{formatPercent(view.projected)}</strong>, {view.met ? <>enough for <strong>{label}</strong>.</> : <>short of <strong>{label}</strong>{cls.goal.kind === 'letter' && <> ({cls.target}%)</>}.</>}</>;
  } else if (view.kind === 'no-plan') {
    tone = view.met ? 'ok' : 'reach'; icon = view.met ? 'check' : 'target';
    body = <>{view.met ? <>You’re at <strong>{label}</strong>.</> : <><strong className="tabular-nums">{points(view.away)}</strong> to go for <strong>{label}</strong>.</>} Schoology lists nothing ungraded to plan around yet.</>;
  } else {
    const { result, above } = view;
    const verb = above ? 'stay at' : 'reach';
    if (result.status === 'reachable') {
      const needed = displayNeeded(result.needed, result.max);
      const score = <strong className="tabular-nums">{about}{cls.plan?.kind === 'newExam' ? `${points(needed)}%` : `${points(needed)}/${points(result.max)}`}</strong>;
      tone = above ? 'ok' : 'reach'; icon = above ? 'check' : 'target';
      body = view.trying ? <>With those scores, you’d need {score} or better on <strong>{name}</strong> to {verb} <strong>{label}</strong>.</>
        : <>To {verb} <strong>{label}</strong>, get {score} or better on <strong>{name}</strong>{due && <span className="whitespace-nowrap text-muted-foreground"> · {due < today ? 'was due' : 'due'} {formatDate(due)}</span>}</>;
    } else if (result.status === 'locked') {
      tone = 'ok'; icon = 'check';
      body = <>{view.trying && 'With those scores, '}<strong>{label} is locked in.</strong> Even a zero on {name} keeps you there.</>;
    } else if (result.status === 'out-of-reach') {
      tone = 'out'; icon = 'alert';
      body = <>{view.trying && 'With those scores, '}<strong>{label}</strong> is out of reach on {name} alone. A perfect score gets you to <strong className="tabular-nums">{about}{formatPercent(result.best)}</strong>.</>;
    } else {
      tone = 'out'; icon = 'alert';
      body = <>A score on {name} doesn’t change your grade. Its category may not count.</>;
    }
  }
  if (hypothetical) icon = 'sparkle';
  return <div role={flat ? 'status' : undefined} data-plan-line={hypothetical ? 'what-if' : tone} className={cn('flex items-start gap-2.5 rounded-xl px-3 py-2.5 text-[13px] leading-[1.45]',
    hypothetical ? 'bg-[color-mix(in_srgb,var(--primary)_8%,var(--card))] outline-[1.5px] -outline-offset-[1.5px] outline-dashed outline-primary/55' : flat ? 'bg-card shadow-card' : 'bg-muted max-lg:bg-transparent max-lg:px-0.5 max-lg:py-0')}>
    <Icon name={icon} size={16} className={cn('mt-0.5 shrink-0', hypothetical || tone === 'reach' ? 'text-primary' : tone === 'ok' ? 'text-success' : 'text-warning')} />
    <span className="min-w-0">{body}</span>
  </div>;
}

const goalValue = (goal: GradeGoal) => goal.kind === 'letter' ? goal.letter : 'custom';
/**
 * Letter choices plus "Custom"; picking Custom on a card opens the class, where the percent is typed. Called, not
 * rendered: Select reads its <option> children directly and would not look inside a component.
 */
export const goalOptions = (goal: GradeGoal | null) => <>
  {LETTER_CUTOFFS.map(entry => <option key={entry.letter} value={entry.letter}>{`${entry.letter} · ${entry.percent}%`}</option>)}
  <option value="custom">{goal?.kind === 'percent' ? `Custom · ${goal.percent}%` : 'Custom percentage…'}</option>
</>;

type CardActions = { onOpen: (id: string) => void; onGoal: (id: string, change: { goal?: GradeGoal | null; plan?: PlanTarget | null }, wait?: number) => void; online: boolean };

export function GradeCard({ cls, today, onOpen, onGoal, online }: { cls: GradeClass; today: string } & CardActions) {
  const place = [cls.room, cls.teacher].filter(Boolean).join(' · ');
  const counts = cls.counts;
  const tally = <>{counts.missing > 0 ? <span className="font-bold text-destructive">{counts.missing} missing</span> : `${counts.graded} graded`} · {counts.open} coming up</>;
  const next = cls.open[0];
  return <li className="grid grid-cols-[minmax(0,1fr)] content-start gap-3 rounded-2xl border-t-4 bg-card px-4 pt-3.5 pb-3.5 text-sm text-card-foreground shadow-card ring-1 ring-foreground/[0.06] transition-shadow hover:shadow-float lg:pb-3 dark:ring-foreground/[0.09]" style={{ borderTopColor: cls.color }}>
    <button type="button" aria-label={`Open ${cls.title} grades`} className={cn('grid cursor-pointer grid-cols-[minmax(0,1fr)] gap-3 rounded-xl text-left', FOCUS)} onClick={() => onOpen(cls.id)}>
      <span className="flex items-start gap-3">
        <Tile cls={cls} />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <strong className="truncate text-[16px] leading-snug font-bold tracking-tight" title={cls.schoologyTitle}>{cls.title}</strong>
          <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground max-lg:hidden">{place ? <><Icon name="pin" size={12} strokeWidth={2.2} className="shrink-0" /><span className="truncate">{place}</span></> : <span className="truncate">{cls.schoologyTitle === cls.title ? 'From Schoology' : cls.schoologyTitle}</span>}</span>
          <span className="truncate text-xs text-muted-foreground lg:hidden">{cls.teacher && `${cls.teacher} · `}{counts.missing > 0 ? <span className="font-bold text-destructive">{counts.missing} missing</span> : `${counts.open} coming up`}</span>
        </span>
        {cls.now !== null ? <span className="grid shrink-0 justify-items-end gap-1"><span className="text-2xl leading-none font-extrabold tracking-[-0.03em] tabular-nums max-lg:text-[22px]">{formatPercent(cls.now)}</span><Letter percent={cls.now} small /></span>
          : <span className="shrink-0 pt-0.5 text-[13px] font-bold whitespace-nowrap text-muted-foreground">{cls.gradeText ?? 'No grade yet'}</span>}
      </span>
      {cls.now !== null && cls.target !== null && <Ruler color={cls.color} now={cls.now} goal={cls.target} />}
      {cls.now !== null ? <PlanLine cls={cls} today={today} />
        : <span className="text-[12.5px] text-muted-foreground">{cls.gradeText ? 'Schoology shows this grade without a percent, so there’s no goal to plan here.'
          : <>Schoology shows no grade here yet.{next && <> {next.title}{next.due ? ` ${next.due < today ? 'was due' : 'is due'} ${formatDate(next.due)}` : ' is coming up'}.</>} You can set a goal once a grade lands.</>}</span>}
    </button>
    {cls.goal && <div className="flex items-center gap-2 border-t pt-2.5 text-[12.5px] max-lg:hidden">
      <Icon name="flag" size={13} className="shrink-0 text-muted-foreground" />
      <Select small aria-label={`Goal for ${cls.title}`} className="h-[30px] w-auto min-w-[104px] font-bold" disabled={!online} value={goalValue(cls.goal)}
        onChange={(event) => { if (event.target.value === 'custom') onOpen(cls.id); else onGoal(cls.id, { goal: { kind: 'letter', letter: event.target.value } }); }}>
        {goalOptions(cls.goal)}
      </Select>
      <span className="flex-1" />
      <span className="whitespace-nowrap text-muted-foreground">{tally}</span>
    </div>}
  </li>;
}

type DetailActions = {
  typed: Typed; onTyped: (itemId: string, text: string) => void; onClear: () => void;
  onGoal: (change: { goal?: GradeGoal | null; plan?: PlanTarget | null }, wait?: number) => void;
  plusLocked: boolean; online: boolean; goalNote: 'saving' | 'saved' | null;
};

function ClassHead({ cls, withTile }: { cls: GradeClass; withTile: boolean }) {
  const meta = [cls.teacher, cls.room].filter(Boolean);
  return <div className="flex items-center gap-3.5 max-lg:items-start">
    {withTile && <Tile cls={cls} />}
    <div className="grid min-w-0 flex-1 gap-0.5">
      <h2 className="truncate text-[22px] leading-tight font-extrabold tracking-tight max-lg:text-xl" title={cls.schoologyTitle}>{cls.title}</h2>
      <span className="text-[13px] text-muted-foreground">{[...meta, ...(meta.length === 0 && cls.schoologyTitle !== cls.title ? [cls.schoologyTitle] : [])].join(' · ')}<span className="max-lg:hidden">{meta.length > 0 && ' · '}{cls.counts.graded} graded · {cls.counts.open} coming up</span></span>
    </div>
    <div className="grid shrink-0 justify-items-end gap-1">
      {cls.now !== null ? <>
        <span className="text-[34px] leading-none font-extrabold tracking-[-0.035em] tabular-nums max-lg:text-[28px]">{formatPercent(cls.now)}</span>
        <span className="inline-flex items-center gap-1.5 text-[11.5px] whitespace-nowrap text-muted-foreground"><Letter percent={cls.now} small />in Schoology</span>
      </> : <span className="text-[15px] font-bold text-muted-foreground">{cls.gradeText ? `${cls.gradeText} in Schoology` : 'No grade yet'}</span>}
    </div>
  </div>;
}

function Categories({ cls, scenario }: { cls: GradeClass; scenario: Scenario }) {
  const lines = categoryLines(cls.detail, cls.calibration, scenario);
  if (lines.length === 0) return null;
  const trying = Object.keys(scenario.scores ?? {}).length > 0;
  return <ul aria-label="Categories" className={cn('grid gap-2', lines.length === 1 ? 'grid-cols-1' : lines.length === 2 ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3')}>
    {lines.map(line => <li key={line.id} className="grid content-start gap-1.5 rounded-xl bg-muted px-3 py-2.5">
      <span className="flex justify-between gap-2 text-[12.5px] font-bold"><span className="min-w-0 truncate" title={line.title}>{line.title}</span>{line.weight > 0 && <span className="font-semibold text-muted-foreground tabular-nums">{points(line.weight)}%</span>}</span>
      <span className="text-lg leading-tight font-extrabold tracking-[-0.02em] tabular-nums">{line.now === null ? <span className="text-sm font-bold text-muted-foreground">No grade</span> : formatPercent(line.now)}</span>
      <span className="h-[5px] overflow-hidden rounded-full bg-foreground/[0.08]"><span className="block h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, line.now ?? 0))}%`, background: cls.color }} /></span>
      {trying && <span className="inline-flex min-h-4 items-center gap-1 text-[11.5px] font-bold whitespace-nowrap text-primary tabular-nums">{line.whatIf !== null && <><Icon name="sparkle" size={11} />{formatPercent(line.whatIf)} what if</>}</span>}
    </li>)}
  </ul>;
}

function Row({ title, sub, children, strong }: { title: string; sub: ReactNode; children: ReactNode; strong?: boolean }) {
  return <li className="flex items-center gap-2.5 border-t px-0.5 py-2.5">
    <span className="grid min-w-0 flex-1 leading-[1.3]"><span className={cn('truncate text-[13.5px]', strong ? 'font-bold' : 'font-semibold')} title={title}>{title}</span><span className="truncate text-xs text-muted-foreground">{sub}</span></span>
    <span className="flex shrink-0 items-center gap-2.5">{children}</span>
  </li>;
}

function ComingUp({ cls, scenario, today, typed, onTyped, plusLocked }: { cls: GradeClass; scenario: Scenario; today: string } & Pick<DetailActions, 'typed' | 'onTyped' | 'plusLocked'>) {
  const categories = new Map(cls.detail.categories.map(category => [category.id, category.title]));
  const planId = cls.plan?.kind === 'item' ? cls.plan.id : null;
  const view = cls.target !== null && planId ? outlook(cls.detail, cls.calibration, cls.target, cls.plan, scenario) : null;
  const chip = view?.kind === 'need' && view.result.status === 'reachable' && cls.goal ? `${points(displayNeeded(view.result.needed, view.result.max))}+ for ${goalLabel(cls.goal)}` : null;
  return <div>
    <div className="flex flex-wrap items-center gap-1.5 px-0.5 pt-1.5 pb-2 text-xs font-extrabold"><Icon name="sparkle" size={13} className="text-primary" />Coming up{cls.open.length > 0 && !plusLocked && <span className="font-semibold text-muted-foreground">· type a score to try it</span>}{plusLocked && <Chip tone="neutral">What-ifs are Plus</Chip>}</div>
    {cls.open.length === 0 ? <p className="border-t px-0.5 pt-2.5 text-[13px] text-muted-foreground">Schoology lists nothing ungraded that counts toward this grade.</p>
      : <ul aria-label="Coming up">{cls.open.map(entry => {
        const sub = [entry.examWeight !== null ? `Exam · ${points(entry.examWeight)}% of the course` : categories.get(entry.categoryId ?? '') ?? null, dueText(entry.due, today)].filter(Boolean).join(' · ');
        const value = typed[entry.id] ?? '';
        return <Row key={entry.id} title={entry.title} sub={sub} strong>
          {entry.id === planId && chip && value === '' && <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-bold whitespace-nowrap text-primary ring-1 ring-primary/35 tabular-nums max-lg:hidden"><Icon name="target" size={12} />{chip}</span>}
          {!plusLocked && <span className="inline-flex items-center gap-1.5">
            <Input small inputMode="decimal" autoComplete="off" aria-label={`Score for ${entry.title}`} value={value} onChange={(event) => onTyped(entry.id, event.target.value)}
              aria-invalid={value.trim() !== '' && parseScore(value) === null ? true : undefined}
              className={cn('w-[60px] text-center tabular-nums', parseScore(value) !== null && 'border-primary ring-2 ring-primary/25')} />
            <span className="min-w-[34px] text-xs text-muted-foreground tabular-nums">/ {points(entry.max)}</span>
          </span>}
          {plusLocked && <span className="text-xs text-muted-foreground tabular-nums">/ {points(entry.max)}</span>}
        </Row>;
      })}</ul>}
    {cls.uncounted > 0 && <p className="border-t px-0.5 pt-2 text-xs text-muted-foreground">{cls.uncounted} more ungraded {cls.uncounted === 1 ? 'item' : 'items'} can’t change this grade (worth no points, or in a category that doesn’t count).</p>}
  </div>;
}

function Graded({ cls, limit }: { cls: GradeClass; limit: number }) {
  const [all, setAll] = useState(false);
  const categories = new Map(cls.detail.categories.map(category => [category.id, category.title]));
  const rows = [
    ...cls.detail.items.filter(item => item.earned !== null || item.exception !== null || item.pending).map(item => ({ key: item.id, title: item.title, due: item.due, sub: categories.get(item.categoryId) ?? null, item })),
    ...cls.detail.exams.filter(exam => exam.earned !== null).map(exam => ({ key: `exam-${exam.id}`, title: exam.title, due: null as string | null, sub: `Exam · ${points(exam.weight)}% of the course`, item: { earned: exam.earned, max: exam.max, exception: null, pending: false } })),
  ].sort((a, b) => (b.due ?? '').localeCompare(a.due ?? ''));
  if (rows.length === 0) return null;
  const shown = all ? rows : rows.slice(0, limit);
  return <div>
    <div className="px-0.5 pt-1.5 pb-2 text-xs font-extrabold">Graded</div>
    <ul aria-label="Graded">{shown.map(({ key, title, due, sub, item }) => <Row key={key} title={title} sub={[sub, due && formatDate(due)].filter(Boolean).join(' · ')}>
      {item.exception === 'missing' ? <Chip tone="danger">Missing · 0/{points(item.max)}</Chip>
        : item.exception === 'incomplete' ? <Chip tone="warning">Incomplete · 0/{points(item.max)}</Chip>
        : item.exception === 'excused' ? <Chip tone="neutral">Excused</Chip>
        : item.pending || item.earned === null ? <Chip tone="outline">Waiting for a grade</Chip>
        : <><span className="text-[13.5px] tabular-nums"><strong>{points(item.earned)}</strong><span className="text-muted-foreground">/{points(item.max)}</span></span>
          {item.max > 0 && <span className="w-[38px] text-right text-[12.5px] text-muted-foreground tabular-nums">{Math.round(100 * item.earned / item.max)}%</span>}</>}
    </Row>)}</ul>
    {rows.length > limit && <div className="border-t pt-2"><Button size="sm" variant="ghost" iconRight={all ? undefined : 'chevronDown'} aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${rows.length}`}</Button></div>}
  </div>;
}

/** Goal type (letter or custom percent), the ruler, the needed score, and what the plan leans on. */
function GoalBox({ cls, scenario, projected, today, onGoal, online, goalNote }: { cls: GradeClass; scenario: Scenario; projected: number | null; today: string } & Pick<DetailActions, 'onGoal' | 'online' | 'goalNote'>) {
  const goal = cls.goal!, target = cls.target!, now = cls.now!;
  const [draft, setDraft] = useState(goal.kind === 'percent' ? String(goal.percent) : '');
  const [extraMax, setExtraMax] = useState(cls.plan?.kind === 'extra' ? String(cls.plan.max) : '100');
  const [weight, setWeight] = useState(cls.plan?.kind === 'newExam' ? String(cls.plan.weight) : '20');
  const draftInvalid = goal.kind === 'percent' && parseGoalPercent(draft) === null;
  const categories = planCategories(cls.detail);
  const id = `goal-${cls.id}`;
  const setKind = (kind: string) => {
    if (kind === 'percent') { setDraft(String(target)); onGoal({ goal: { kind: 'percent', percent: target } }); }
    else onGoal({ goal: { kind: 'letter', letter: letterFor(target) ?? LETTER_CUTOFFS.at(-1)!.letter } });
  };
  const planValue = cls.plan?.kind === 'item' ? `item:${cls.plan.id}` : cls.plan?.kind === 'extra' ? 'new' : cls.plan?.kind === 'newExam' ? 'final' : '';
  const setPlan = (value: string) => {
    if (value === 'new') onGoal({ plan: { kind: 'extra', categoryId: categories[0].id, max: parseScore(extraMax) || 100 } });
    else if (value === 'final') onGoal({ plan: { kind: 'newExam', weight: Math.min(parseScore(weight) || 20, 100) } });
    else onGoal({ plan: { kind: 'item', id: value.slice(5) } });
  };
  const canPlan = cls.open.length > 0 || categories.length > 0 || cls.detail.exams.length === 0;
  return <section aria-label="Goal" className="grid gap-3 rounded-[14px] bg-muted p-3.5 max-lg:p-3">
    <div className="flex items-center gap-2 text-[13.5px] font-extrabold">
      <Icon name="flag" size={15} />Goal
      <span role="status" className="text-xs font-semibold text-muted-foreground">{goalNote === 'saving' ? 'Saving…' : goalNote === 'saved' ? 'Saved' : ''}</span>
      <span className="flex-1" />
      <span className="inline-flex h-[30px] items-center rounded-[10px] border bg-card px-2.5 text-[12.5px] font-bold whitespace-nowrap tabular-nums dark:border-input">{goal.kind === 'percent' ? `Custom · ${goal.percent}%` : `${goal.letter} · ${target}%`}</span>
    </div>
    <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-2.5">
      <Field label="Goal type" htmlFor={`${id}-type`} className="min-w-0">
        <Select id={`${id}-type`} className="min-w-0 [&_[data-slot=select-value]]:min-w-0" small disabled={!online} value={goal.kind} onChange={(event) => setKind(event.target.value)}>
          <option value="letter">Letter grade</option>
          <option value="percent">Custom percentage</option>
        </Select>
      </Field>
      {goal.kind === 'letter' ? <Field label="Letter" htmlFor={`${id}-letter`} className="min-w-0">
        <Select id={`${id}-letter`} small disabled={!online} value={goal.letter} onChange={(event) => onGoal({ goal: { kind: 'letter', letter: event.target.value } })}>
          {LETTER_CUTOFFS.map(entry => <option key={entry.letter} value={entry.letter}>{`${entry.letter} · ${entry.percent}%`}</option>)}
        </Select>
      </Field> : <Field label="Target percentage" htmlFor={`${id}-percent`} className="min-w-0" error={draftInvalid ? 'Type a number from 0 to 100.' : undefined}>
        <span className="flex min-w-0 items-center gap-1.5">
          <Input id={`${id}-percent`} small inputMode="decimal" autoComplete="off" disabled={!online} value={draft} className="min-w-0 tabular-nums"
            onChange={(event) => { setDraft(event.target.value); const percent = parseGoalPercent(event.target.value); if (percent !== null) onGoal({ goal: { kind: 'percent', percent } }, 600); }} />
          <span className="text-xs text-muted-foreground">%</span>
        </span>
      </Field>}
    </div>
    {!cls.goalSaved && <div className="flex flex-wrap items-center gap-2"><Hint className="min-w-0 flex-1 basis-40">This starts at the letter you have now. Nothing is saved until you choose.</Hint><Button size="sm" disabled={!online} onClick={() => onGoal({ goal })}>Set as my goal</Button></div>}
    <Ruler color={cls.color} now={now} goal={target} whatIf={projected} />
    <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><i className="size-[11px] rounded-full border-[3px] bg-card" style={{ borderColor: cls.color }} />Now <strong className="text-foreground tabular-nums">{formatPercent(now)}</strong></span>
      {projected !== null && <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><i className="size-[11px] rounded-full border-[1.5px] border-dashed border-primary" />What if <strong className="text-foreground tabular-nums">{formatPercent(projected)}</strong></span>}
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><Icon name="flag" size={12} />Goal <strong className="text-foreground tabular-nums">{goal.kind === 'percent' ? `${goal.percent}%` : `${target}%`}</strong></span>
    </div>
    <PlanLine cls={cls} scenario={scenario} today={today} flat />
    {cls.calibration.approximate && <Hint>Schoology weighs this class in a way it doesn’t share, so the needed scores and what-ifs here are close estimates.</Hint>}
    {canPlan && <div className="grid gap-2">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2.5">
        <label htmlFor={`${id}-plan`} className="text-xs text-muted-foreground">Plan around</label>
        <Select id={`${id}-plan`} small disabled={!online} value={planValue} onChange={(event) => setPlan(event.target.value)}>
          {cls.open.map(entry => <option key={entry.id} value={`item:${entry.id}`}>{entry.title}</option>)}
          {categories.length > 0 && <option value="new">A new assignment…</option>}
          {cls.detail.exams.length === 0 && <option value="final">The final exam…</option>}
        </Select>
      </div>
      {cls.plan?.kind === 'extra' && <div className="grid grid-cols-2 gap-2.5">
        <Field label="Category" htmlFor={`${id}-category`}>
          <Select id={`${id}-category`} small disabled={!online} value={cls.plan.categoryId} onChange={(event) => onGoal({ plan: { kind: 'extra', categoryId: event.target.value, max: parseScore(extraMax) || 100 } })}>
            {categories.map(entry => <option key={entry.id} value={entry.id}>{`${entry.title}${entry.weight > 0 ? ` (${points(entry.weight)}%)` : ''}`}</option>)}
          </Select>
        </Field>
        <Field label="Worth (points)" htmlFor={`${id}-max`}>
          <Input id={`${id}-max`} small inputMode="decimal" autoComplete="off" disabled={!online} value={extraMax} className="tabular-nums"
            onChange={(event) => { setExtraMax(event.target.value); const max = parseScore(event.target.value); if (max && max <= 100_000 && cls.plan?.kind === 'extra') onGoal({ plan: { ...cls.plan, max } }, 600); }} />
        </Field>
      </div>}
      {cls.plan?.kind === 'newExam' && <Field label="The final is worth (% of the course)" htmlFor={`${id}-weight`}>
        <Input id={`${id}-weight`} small inputMode="decimal" autoComplete="off" disabled={!online} value={weight} className="tabular-nums"
          onChange={(event) => { setWeight(event.target.value); const value = parseScore(event.target.value); if (value && value <= 100) onGoal({ plan: { kind: 'newExam', weight: value } }, 600); }} />
      </Field>}
    </div>}
  </section>;
}

/** Where the typed scores finish, against the goal. Dashed and tinted wherever it shows, so it never passes for a real grade. */
function whatIfResult(cls: GradeClass, projected: number) {
  const delta = projected - cls.now!, met = projected >= cls.target! - 1e-9, label = goalLabel(cls.goal!);
  return { delta, met, verdict: met ? `Reaches your goal of ${label}` : `${points(cls.target! - projected)} short of ${label}`, deltaText: `${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)}` };
}
const WHAT_IF = 'bg-[color-mix(in_srgb,var(--primary)_8%,var(--card))] outline-[1.5px] -outline-offset-[1.5px] outline-dashed outline-primary/55';

function WhatIfBox({ cls, projected, onClear, plusLocked }: { cls: GradeClass; projected: number | null; onClear: () => void; plusLocked: boolean }) {
  if (plusLocked) return <section aria-label="What if" className={cn('grid gap-2.5 rounded-[14px] p-3.5', WHAT_IF)}>
    <div className="flex items-center gap-2 text-[13.5px] font-extrabold"><Icon name="sparkle" size={15} className="text-primary" />What if<span className="flex-1" /><Chip tone="neutral">Plus</Chip></div>
    <p className="text-[12.5px] text-muted-foreground">Trying out scores is part of Quasar AI Plus.</p>
  </section>;
  if (projected === null) return <section aria-label="What if" className={cn('grid gap-2.5 rounded-[14px] p-3.5', WHAT_IF)}>
    <div className="flex items-center gap-2 text-[13.5px] font-extrabold"><Icon name="sparkle" size={15} className="text-primary" />What if</div>
    <p className="text-[12.5px] text-muted-foreground">{cls.open.length > 0 ? 'Type a score next to anything coming up to see where you’d land. Nothing is sent to Schoology.' : 'When Schoology lists ungraded work here, you can type scores to see where you’d land.'}</p>
  </section>;
  const result = whatIfResult(cls, projected);
  return <section aria-label="What if" className={cn('grid gap-2.5 rounded-[14px] p-3.5', WHAT_IF)}>
    <div className="flex items-center gap-2 text-[13.5px] font-extrabold"><Icon name="sparkle" size={15} className="text-primary" />What if<span className="flex-1" /><Button size="sm" variant="ghost" onClick={onClear}>Clear</Button></div>
    <div className="flex items-center gap-2"><span className="text-[26px] leading-none font-extrabold tracking-[-0.03em] tabular-nums">{formatPercent(projected)}</span><Letter percent={projected} /><Chip tone={result.delta >= 0 ? 'success' : 'warning'} className="tabular-nums">{result.deltaText}</Chip></div>
    <div role="status" className={cn('flex items-center gap-1.5 text-[13px] font-bold', result.met && 'text-success')}><Icon name={result.met ? 'check' : 'target'} size={15} className={result.met ? undefined : 'text-primary'} />{result.verdict}</div>
    <p className="text-[12.5px] text-muted-foreground">Your Schoology grade is still {formatPercent(cls.now)}. Nothing here is sent to Schoology.</p>
  </section>;
}

function MissingCallout({ cls }: { cls: GradeClass }) {
  const missing = cls.detail.items.filter(item => item.exception === 'missing');
  if (missing.length === 0) return null;
  return <div role="note" className="flex items-start gap-2.5 rounded-xl bg-destructive/10 px-3 py-2.5 text-[13px] text-destructive">
    <Icon name="alert" size={15} className="mt-0.5 shrink-0" />
    <span><strong className="text-foreground">{missing[0].title}{missing.length > 1 ? ` and ${missing.length - 1} more are` : ' is'} missing.</strong> Schoology counts {missing.length > 1 ? 'them' : 'it'} as 0.</span>
  </div>;
}

/** One class: its gradebook, the goal and the what-ifs. `sheet` is the phone order (goal first, in one column). */
export function ClassDetail({ cls, sheet, today, ...actions }: { cls: GradeClass; sheet?: boolean; today: string } & DetailActions) {
  const scenario = useMemo(() => scenarioOf(actions.typed), [actions.typed]);
  const trying = Object.keys(scenario.scores ?? {}).length > 0;
  const projected = trying && cls.now !== null ? classGrade(cls.detail, cls.calibration, scenario) : null;
  const goalBox = cls.goal ? <GoalBox key={cls.id} cls={cls} scenario={scenario} projected={projected} today={today} onGoal={actions.onGoal} online={actions.online} goalNote={actions.goalNote} />
    : <Hint>{cls.gradeText ? 'Schoology shows this grade without a percent, so there’s no goal to plan here.' : 'Schoology shows no grade here yet. You can set a goal once a grade lands.'}</Hint>;
  const comingUp = <ComingUp cls={cls} scenario={scenario} today={today} typed={actions.typed} onTyped={actions.onTyped} plusLocked={actions.plusLocked || cls.now === null} />;
  if (sheet) return <div className="grid grid-cols-[minmax(0,1fr)] gap-3.5">
    <ClassHead cls={cls} withTile={false} />
    <MissingCallout cls={cls} />
    {goalBox}
    {comingUp}
    <Categories cls={cls} scenario={scenario} />
    <Graded cls={cls} limit={4} />
  </div>;
  return <section aria-label={`${cls.title} grades`} className="grid grid-cols-[minmax(0,1fr)] gap-[18px] rounded-2xl bg-card px-6 pt-[22px] pb-5 text-sm shadow-card ring-1 ring-foreground/[0.06] dark:ring-foreground/[0.09]">
    <ClassHead cls={cls} withTile />
    <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-[22px] xl:grid-cols-[minmax(0,1fr)_316px]">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4"><MissingCallout cls={cls} /><Categories cls={cls} scenario={scenario} />{comingUp}<Graded cls={cls} limit={6} /></div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
        {goalBox}
        {cls.now !== null && <WhatIfBox cls={cls} projected={projected} onClear={actions.onClear} plusLocked={actions.plusLocked} />}
      </div>
    </div>
  </section>;
}

/** The phone sheet's footer: the what-if result stays in view while the scores are typed above it. */
function WhatIfBar({ cls, typed, onClear }: { cls: GradeClass; typed: Typed; onClear: () => void }) {
  const scenario = scenarioOf(typed);
  if (cls.now === null || Object.keys(scenario.scores ?? {}).length === 0) return null;
  const projected = classGrade(cls.detail, cls.calibration, scenario);
  if (projected === null) return null;
  const result = whatIfResult(cls, projected);
  return <div role="status" aria-label="What if" className={cn('flex w-full items-center gap-2.5 rounded-2xl py-2.5 pr-2.5 pl-3.5', WHAT_IF)}>
    <span className="grid leading-tight"><span className="inline-flex items-center gap-1 text-[11.5px] font-extrabold text-primary"><Icon name="sparkle" size={12} />What if</span>
      <strong className="inline-flex items-center gap-1.5 text-[19px] tracking-[-0.02em] tabular-nums">{formatPercent(projected)}<Letter percent={projected} small /></strong></span>
    <Chip tone={result.delta >= 0 ? 'success' : 'warning'} className="tabular-nums">{result.deltaText}</Chip>
    <span className="flex-1" />
    <span className="max-w-[9rem] text-right text-xs leading-tight font-bold">{result.verdict}</span>
    <Button size="sm" variant="ghost" onClick={onClear}>Clear</Button>
  </div>;
}

function Rail({ classes, selected, onSelect, onBack }: { classes: GradeClass[]; selected: string; onSelect: (id: string) => void; onBack: () => void }) {
  return <nav aria-label="Classes with grades" className="grid content-start gap-0.5 rounded-2xl bg-card p-2 shadow-card ring-1 ring-foreground/[0.06] dark:ring-foreground/[0.09]">
    <div className="flex items-center justify-between pt-1.5 pr-2 pb-2.5 pl-1">
      <button type="button" className={cn('inline-flex cursor-pointer items-center gap-0.5 rounded-lg text-[13px] font-bold text-primary', FOCUS)} onClick={onBack}><Icon name="chevronLeft" size={16} />All classes</button>
      <span className="text-xs text-muted-foreground">{pluralize(classes.length, 'class', 'classes')}</span>
    </div>
    {classes.map(cls => {
      const met = cls.now !== null && cls.target !== null && cls.now >= cls.target - 1e-9;
      return <button key={cls.id} type="button" aria-current={cls.id === selected ? 'true' : undefined} onClick={() => onSelect(cls.id)}
        className={cn('flex cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-left', FOCUS, cls.id === selected ? 'bg-primary-soft ring-1 ring-primary/20' : 'hover:bg-muted')}>
        <Tile cls={cls} small />
        <span className="grid min-w-0 flex-1 leading-[1.3]">
          <strong className="truncate text-[13.5px]">{cls.title}</strong>
          {cls.goal && cls.target !== null && cls.now !== null ? <span className="inline-flex items-center gap-1 text-xs whitespace-nowrap text-muted-foreground">
            {/* Only a goal the member chose is reported as met or not. */}
            {cls.goalSaved ? <><Icon name={met ? 'check' : 'flag'} size={12} className={met ? 'text-success' : undefined} />{goalLabel(cls.goal)} · {met ? 'at goal' : `${points(Math.round((cls.target - cls.now) * 10) / 10)} to go`}</> : 'No goal set'}
            {cls.counts.missing > 0 && <i className="size-[7px] shrink-0 rounded-full bg-destructive" title={`${cls.counts.missing} missing`} />}
          </span> : <span className="text-xs text-muted-foreground">{cls.gradeText ?? 'Nothing graded yet'}</span>}
        </span>
        {cls.now !== null && <span className="grid shrink-0 text-right leading-tight"><strong className="text-[14.5px] tracking-[-0.02em] tabular-nums">{formatPercent(cls.now)}</strong><span className="text-xs text-muted-foreground">{letterFor(cls.now) ?? ''}</span></span>}
      </button>;
    })}
  </nav>;
}

type BoardProps = {
  classes: GradeClass[]; selected: string | null; today: string; mobile: boolean; online: boolean; plusLocked: boolean;
  typed: Record<string, Typed>; goalNote: 'saving' | 'saved' | null;
  onSelect: (id: string | null) => void; onTyped: (sectionId: string, itemId: string, text: string) => void; onClear: (sectionId: string) => void;
  onGoal: CardActions['onGoal'];
};

/** The cards, and the selected class: beside a switcher rail on wide screens, in a sheet over the cards on phones. */
export function GradesBoard({ classes, selected, today, mobile, online, plusLocked, typed, goalNote, onSelect, onTyped, onClear, onGoal }: BoardProps) {
  const current = classes.find(cls => cls.id === selected) ?? null;
  const actions = current ? { typed: typed[current.id] ?? {}, onTyped: (itemId: string, text: string) => onTyped(current.id, itemId, text), onClear: () => onClear(current.id),
    onGoal: (change: Parameters<DetailActions['onGoal']>[0], wait?: number) => onGoal(current.id, change, wait), plusLocked, online, goalNote } : null;
  const cards = <ul className="grid items-start gap-3.5 sm:grid-cols-2 lg:grid-cols-3" aria-label="Grades by class">
    {classes.map(cls => <GradeCard key={cls.id} cls={cls} today={today} onOpen={onSelect} onGoal={onGoal} online={online} />)}
  </ul>;
  if (!current || !actions) return cards;
  if (mobile) return <>
    {cards}
    <Modal open onClose={() => onSelect(null)} footer={current.now !== null && Object.keys(scenarioOf(actions.typed).scores ?? {}).length > 0 ? <WhatIfBar cls={current} typed={actions.typed} onClear={actions.onClear} /> : undefined}
      title={<span className="flex flex-wrap items-center gap-2" role="group" aria-label="Switch class">
        {classes.map(cls => <button key={cls.id} type="button" aria-label={cls.title} aria-pressed={cls.id === current.id} onClick={() => onSelect(cls.id)}
          className={cn('cursor-pointer rounded-[10px]', FOCUS, cls.id === current.id ? 'ring-2 ring-foreground ring-offset-2 ring-offset-card' : 'opacity-50')}><Tile cls={cls} small /></button>)}
      </span>}>
      <ClassDetail key={current.id} cls={current} sheet today={today} {...actions} />
    </Modal>
  </>;
  return <div className="grid items-start gap-4 lg:grid-cols-[272px_minmax(0,1fr)]">
    <Rail classes={classes} selected={current.id} onSelect={onSelect} onBack={() => onSelect(null)} />
    <ClassDetail key={current.id} cls={current} today={today} {...actions} />
  </div>;
}

/** Gradebooks this tab already read, by account, so switching tabs or pages doesn't reread Schoology. Memory only. */
const memory = new Map<string, { book: Book; at: number }>();
const FRESH_MS = 5 * 60_000;

export function GradesTab({ state, tabs }: { state: AppState; tabs: ReactNode }) {
  const accountId = state.context.user.id;
  const mobile = useIsMobile();
  const [book, setBook] = useState<Book | null>(() => memory.get(accountId)?.book ?? null);
  const [goals, setGoals] = useState<Goals>(() => memory.get(accountId)?.book.goals ?? {});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [goalError, setGoalError] = useState('');
  const [goalNote, setGoalNote] = useState<'saving' | 'saved' | null>(null);
  const [typed, setTyped] = useState<Record<string, Typed>>({});
  const [settings, setSettings] = useState(false);
  // Goals as shown (saved plus edits on their way to the server), the last ones the server confirmed, and edits not yet sent.
  const shown = useRef(goals), confirmed = useRef(goals);
  const unsent = useRef(new Map<string, SavedGoal>()), timers = useRef(new Map<string, number>());
  const show = (next: Goals) => { shown.current = next; setGoals(next); };
  const loadRef = useRef<(force?: boolean) => Promise<void>>(async () => undefined);
  const connection = useSchoologyConnection(state, () => void loadRef.current(true));
  const reloadStatus = connection.reload;

  const load = useCallback(async (force = false) => {
    setLoading(true); setError('');
    try {
      const next = await api.schoology.gradebook.mutate({ accountId, force });
      memory.set(accountId, { book: next, at: Date.now() });
      confirmed.current = next.goals;
      setBook(next);
      show({ ...next.goals, ...Object.fromEntries(unsent.current) });
    } catch (err) { setError(errorMessage(err)); void reloadStatus(); }
    setLoading(false);
  }, [accountId, reloadStatus]);
  useEffect(() => { loadRef.current = load; }, [load]);

  const isConnected = connection.connected !== null, statusKnown = connection.status !== null;
  useEffect(() => {
    if (!statusKnown || connection.connecting) return;
    if (!isConnected) { memory.delete(accountId); setBook(null); return; }
    const cached = memory.get(accountId);
    if (state.online && (!cached || Date.now() - cached.at >= FRESH_MS)) void load();
  }, [statusKnown, isConnected, connection.connecting, accountId, state.online, load]);

  const flush = useCallback(async (sectionId: string) => {
    window.clearTimeout(timers.current.get(sectionId)); timers.current.delete(sectionId);
    const value = unsent.current.get(sectionId);
    if (!value) return;
    setGoalNote('saving'); setGoalError('');
    try {
      const saved = await api.schoology.setGoal.mutate({ accountId, sectionId, goal: value.goal, plan: value.plan });
      confirmed.current = { ...confirmed.current, [sectionId]: { goal: saved.goal, plan: saved.plan } };
      const cached = memory.get(accountId);
      if (cached) memory.set(accountId, { ...cached, book: { ...cached.book, goals: confirmed.current } });
      if (unsent.current.get(sectionId) === value) { unsent.current.delete(sectionId); setGoalNote('saved'); }
    } catch (err) {
      if (unsent.current.get(sectionId) !== value) return;
      // Back to what the server has, so the page never shows a goal that didn't save.
      unsent.current.delete(sectionId);
      const { [sectionId]: _dropped, ...rest } = shown.current;
      show(confirmed.current[sectionId] ? { ...rest, [sectionId]: confirmed.current[sectionId] } : rest);
      setGoalNote(null); setGoalError(errorMessage(err));
    }
  }, [accountId]);
  const changeGoal = useCallback<CardActions['onGoal']>((sectionId, change, wait = 0) => {
    const next = { ...(shown.current[sectionId] ?? { goal: null, plan: null }), ...change };
    unsent.current.set(sectionId, next);
    show({ ...shown.current, [sectionId]: next });
    window.clearTimeout(timers.current.get(sectionId));
    timers.current.set(sectionId, window.setTimeout(() => void flush(sectionId), wait));
  }, [flush]);
  // Leaving the tab sends anything still waiting on its typing pause.
  useEffect(() => { const pending = timers.current; return () => { for (const sectionId of [...pending.keys()]) void flush(sectionId); }; }, [flush]);
  useEffect(() => { if (goalNote !== 'saved') return; const timer = window.setTimeout(() => setGoalNote(null), 2500); return () => window.clearTimeout(timer); }, [goalNote]);

  const classes = useMemo(() => book ? gradeClasses(book, goals, state.personal.classes) : [], [book, goals, state.personal.classes]);
  const wanted = state.params.get('class');
  const selected = classes.some(cls => cls.id === wanted) ? wanted : null;
  const select = (id: string | null) => state.navigate('classes', id ? { tab: 'grades', class: id } : { tab: 'grades' }, { replace: mobile || (id !== null && selected !== null) });
  const refresh = async () => {
    await load(true);
    try { if ((await api.schoology.sync.mutate({ accountId, force: true })).changed > 0) await state.refresh(); } catch { /* the grades error, if any, is shown */ }
    void reloadStatus();
  };

  const withGoal = classes.filter(cls => cls.goalSaved && cls.now !== null && cls.target !== null);
  const met = withGoal.filter(cls => cls.now! >= cls.target! - 1e-9).length;
  const missing = classes.reduce((sum, cls) => sum + cls.counts.missing, 0);
  const summary = () => {
    const parts: ReactNode[] = [];
    if (withGoal.length > 0) parts.push(<span key="goals"><strong className="text-foreground">{met} of {withGoal.length}</strong> {withGoal.length === 1 ? 'goal' : 'goals'} met</span>);
    if (missing > 0) parts.push(<span key="missing" className="font-bold text-destructive">{missing} missing</span>);
    return parts.flatMap((part, index) => index === 0 ? [part] : [' · ', part]);
  };
  const plusLocked = connection.status?.beta === true && connection.status.plusLocked;
  const busy = loading || connection.pending !== null;

  let body: ReactNode;
  if (connection.connecting) body = <Card><p role="status" className="px-5 text-sm text-muted-foreground">Connecting to Schoology…</p></Card>;
  else if (!statusKnown && !book) body = connection.statusFailed || !state.online
    ? <Callout tone="warning" icon="cloudOff" role="status" actions={state.online ? <Button size="sm" onClick={() => void reloadStatus()}>Try again</Button> : undefined}>{state.online ? 'Couldn’t check your Schoology connection.' : 'Go online to load your grades.'}</Callout>
    : <Skeleton />;
  else if (statusKnown && !isConnected) body = <Card><EmptyState icon="book" title="See your grades here" action={<SchoologyConnect state={state} connection={connection} />}>
    Connect your Schoology account to see each class’s grade, set a goal, and find out what your next assignment needs. Schoology asks you to approve Quasar first.</EmptyState></Card>;
  else if (!book) body = error ? null : state.online ? <Skeleton /> : <Callout tone="warning" icon="cloudOff" role="status">Go online to load your grades.</Callout>;
  else if (classes.length === 0) body = <Card><EmptyState icon="book" title="No graded classes yet">Schoology didn’t list any classes with grades. Check back after your first grade is posted.</EmptyState></Card>;
  else body = <GradesBoard classes={classes} selected={selected} today={state.today} mobile={mobile} online={state.online} plusLocked={plusLocked} typed={typed} goalNote={goalNote}
    onSelect={select} onGoal={changeGoal}
    onTyped={(sectionId, itemId, text) => setTyped(current => ({ ...current, [sectionId]: { ...current[sectionId], [itemId]: text } }))}
    onClear={(sectionId) => setTyped(current => ({ ...current, [sectionId]: {} }))} />;

  return <>
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
      {tabs}
      <span className="text-[13px] text-muted-foreground max-lg:hidden">{summary()}</span>
      <span className="flex-1" />
      {isConnected && <span className="flex items-center gap-2">
        <Button size="sm" icon="refresh" aria-label="Refresh grades" title="Refresh grades" busy={loading} disabled={!state.online || busy} onClick={() => void refresh()} />
        <IconButton size="sm" variant="secondary" icon="settings" label="Schoology settings" onClick={() => setSettings(true)} />
      </span>}
    </div>
    {book && summary().length > 0 && <p className="-mt-2 text-[13px] text-muted-foreground lg:hidden">{summary()}</p>}
    {connection.error && !settings && <Callout tone="danger" icon="alert" role="alert">{connection.error}</Callout>}
    {error && <Callout tone="danger" icon="alert" role="alert" actions={<Button size="sm" disabled={!state.online || busy} onClick={() => void load(true)}>Try again</Button>}>{error}{book && ' Showing the grades from the last check.'}</Callout>}
    {goalError && <Callout tone="danger" icon="alert" role="alert">Your goal didn’t save. {goalError}</Callout>}
    {body}
    <Modal open={settings} onClose={() => setSettings(false)} title="Schoology settings" busy={connection.pending !== null}>
      <SchoologySettings state={state} connection={connection} open={settings} />
    </Modal>
  </>;
}

function Skeleton() {
  return <div role="status" aria-label="Reading your grades from Schoology" className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
    {[0, 1, 2].map(index => <div key={index} className="grid h-[212px] animate-pulse content-start gap-4 rounded-2xl border-t-4 border-foreground/10 bg-card px-4 pt-3.5 shadow-card ring-1 ring-foreground/[0.06]">
      <div className="flex gap-3"><div className="size-10 rounded-xl bg-muted" /><div className="grid flex-1 content-center gap-2"><div className="h-3.5 w-2/3 rounded bg-muted" /><div className="h-2.5 w-1/3 rounded bg-muted" /></div><div className="h-6 w-16 rounded bg-muted" /></div>
      <div className="h-2 rounded-full bg-muted" /><div className="h-12 rounded-xl bg-muted" />
    </div>)}
    <span className="sr-only">Reading your grades from Schoology…</span>
  </div>;
}
