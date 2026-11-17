import type { ReactNode } from 'react';
import type { ParentSummary } from '@/server/parent-summary';
import { daysBetween, formatDate, formatDateTime, formatTime, formatTimeZone, instantParts } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Icon } from './icon';

/**
 * The weekly parent summary as the parent sees it (src/server/parent-summary.ts). Rendered on the server for
 * /summary/[token], and in Account → AI as the student's preview, so both are the same markup. No hooks, so it
 * works on either side. It only draws the sections present in `summary`; the server leaves out the rest.
 */

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const CHIP = 'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-semibold';
const CHIPS = {
  done: 'bg-emerald-500/10 text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-300',
  overdue: 'bg-amber-500/12 text-amber-900 dark:bg-amber-400/10 dark:text-amber-200',
  open: 'bg-foreground/[0.06] text-muted-foreground',
} as const;

function Section({ title, heading, count, children }: { title: string; heading: 'h2' | 'h3'; count?: number; children: ReactNode }) {
  const Heading = heading;
  return <section className="grid gap-2.5 rounded-2xl bg-card p-4 ring-1 ring-inset ring-foreground/[0.06] sm:p-5" aria-label={title}>
    <Heading className="flex items-baseline justify-between gap-3 text-[15px] font-bold">{title}{count !== undefined && <span className="text-[13px] font-semibold text-muted-foreground">{count}</span>}</Heading>
    {children}
  </section>;
}

function Row({ title, meta, chip }: { title: string; meta: string; chip?: ReactNode }) {
  return <li className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
    <div className="grid min-w-0 gap-0.5">
      <span className="break-words text-[14px] font-semibold leading-snug">{title}</span>
      <span className="text-[12.5px] text-muted-foreground">{meta}</span>
    </div>
    {chip}
  </li>;
}

const Empty = ({ children }: { children: ReactNode }) => <p className="text-[13.5px] text-muted-foreground">{children}</p>;
const More = ({ count }: { count: number }) => count > 0 ? <p className="text-[12.5px] text-muted-foreground">And {count} more.</p> : null;
const List = ({ children, label }: { children: ReactNode; label: string }) => <ul className="grid divide-y divide-foreground/[0.06]" aria-label={label}>{children}</ul>;

export function ParentSummaryView({ summary, preview = false }: { summary: ParentSummary; preview?: boolean }) {
  const { firstName: name, dueThisWeek, overdue, assessments, completed } = summary;
  const heading = preview ? 'h3' : 'h2';
  const Title = preview ? 'h2' : 'h1';
  const updated = instantParts(summary.generatedAt, summary.timeZone);
  const when = (date: string) => {
    const days = daysBetween(summary.today, date);
    return days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  };
  const nothing = !dueThisWeek && !overdue && !assessments && !completed;
  return <div className="grid gap-4">
    <header className="grid gap-1">
      <Title className={cn('font-bold tracking-tight', preview ? 'text-xl' : 'text-[26px] leading-tight sm:text-3xl')}>{name}’s week</Title>
      <p className="text-[13.5px] text-muted-foreground">Week of {formatDate(summary.weekStart, { weekday: 'short' })}. Times are {formatTimeZone(summary.timeZone)}.</p>
    </header>

    {dueThisWeek && <Section title="Due this week" heading={heading} count={dueThisWeek.tasks.length + dueThisWeek.more}>
      {dueThisWeek.tasks.length === 0 ? <Empty>Nothing is due this week.</Empty> : <List label="Due this week">
        {dueThisWeek.tasks.map((task, index) => <Row key={index} title={task.title} meta={`${task.className ?? 'No class'} · ${formatDateTime(task.dueDate, task.dueTime)}`}
          chip={task.done ? <span className={cn(CHIP, CHIPS.done)}><Icon name="check" size={12} strokeWidth={2.5} />Done</span>
            : task.overdue ? <span className={cn(CHIP, CHIPS.overdue)}>Overdue</span>
            : <span className={cn(CHIP, CHIPS.open)}>Not done yet</span>} />)}
      </List>}
      <More count={dueThisWeek.more} />
    </Section>}

    {overdue && <Section title="Overdue" heading={heading}>
      <Empty>{overdue.count === 0 ? 'Nothing is overdue.' : `${plural(overdue.count, 'assignment')} past due and not done yet.`}</Empty>
    </Section>}

    {assessments && <Section title="Upcoming tests and quizzes" heading={heading} count={assessments.tasks.length + assessments.more}>
      {assessments.tasks.length === 0 ? <Empty>No tests or quizzes in the next three weeks.</Empty> : <List label="Upcoming tests and quizzes">
        {assessments.tasks.map((task, index) => <Row key={index} title={task.title} meta={`${task.className ?? 'No class'} · ${formatDateTime(task.dueDate, task.dueTime)}, ${when(task.dueDate)}`}
          chip={<span className={cn(CHIP, CHIPS.open)}>{task.kind === 'quiz' ? 'Quiz' : 'Test'}</span>} />)}
      </List>}
      <More count={assessments.more} />
    </Section>}

    {completed && <Section title="Completed this week" heading={heading} count={completed.tasks.length + completed.more}>
      {completed.tasks.length === 0 ? <Empty>Nothing checked off yet this week.</Empty> : <List label="Completed this week">
        {completed.tasks.map((task, index) => <Row key={index} title={task.title} meta={`${task.className ?? 'No class'} · done ${formatDate(task.completedOn, { weekday: 'short' })}`}
          chip={<span className={cn(CHIP, CHIPS.done)}><Icon name="check" size={12} strokeWidth={2.5} />Done</span>} />)}
      </List>}
      <More count={completed.more} />
    </Section>}

    {nothing && <Empty>{name} isn’t sharing anything on this page right now.</Empty>}

    <p className="text-[12.5px] leading-relaxed text-muted-foreground">
      {name} chose what this page shows and can turn the link off at any time. Updated {formatDate(updated.date, { weekday: 'short' })} at {formatTime(updated.time)}.
    </p>
  </div>;
}
