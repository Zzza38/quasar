'use client';

/**
 * App-level composites on top of the shadcn/ui components in ./ui.
 * Views import from here so the shadcn variant vocabulary stays in one place.
 */

import { useId, type ButtonHTMLAttributes, type ComponentProps, type ReactNode } from 'react';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Icon, Spinner, type IconName } from './icon';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Badge } from './ui/badge';
import { Button as ShadButton } from './ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader } from './ui/card';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input as ShadInput } from './ui/input';
import { Label } from './ui/label';
import { NativeSelect } from './ui/native-select';
import { Switch } from './ui/switch';
import { Textarea as ShadTextarea } from './ui/textarea';
import { Toggle as ShadToggle } from './ui/toggle';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';

/* ---------- Buttons ---------- */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft' | 'link';
type Size = 'sm' | 'md' | 'lg';
const VARIANTS = { primary: 'default', secondary: 'outline', ghost: 'ghost', danger: 'destructive', soft: 'soft', link: 'link' } as const;
const VARIANT_CLASSES: Record<Variant, string> = {
  primary: 'shadow-[0_1px_2px_rgb(0_0_0/0.12),inset_0_1px_0_rgb(255_255_255/0.18)] hover:bg-primary/90 font-semibold',
  secondary: 'bg-card shadow-card hover:bg-muted font-semibold',
  ghost: 'font-semibold',
  danger: 'font-semibold',
  soft: 'font-semibold',
  link: '',
};

export function Button({ variant = 'secondary', size = 'md', icon, iconRight, busy, children, type = 'button', disabled, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; icon?: IconName; iconRight?: IconName; busy?: boolean }) {
  const iconOnly = children === undefined || children === null || children === false;
  const shadSize = iconOnly ? (size === 'sm' ? 'icon-sm' : size === 'lg' ? 'icon-lg' : 'icon') : size === 'sm' ? 'sm' : size === 'lg' ? 'lg' : 'default';
  return <ShadButton type={type} variant={VARIANTS[variant]} size={shadSize} disabled={disabled || busy} aria-busy={busy || undefined} className={cn(VARIANT_CLASSES[variant], className)} {...rest}>
    {busy ? <Spinner /> : icon ? <Icon name={icon} /> : null}
    {children}
    {iconRight && !busy ? <Icon name={iconRight} /> : null}
  </ShadButton>;
}

export function IconButton({ label, icon, size = 'md', variant = 'ghost', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: IconName; size?: Size; variant?: Variant }) {
  return <Button variant={variant} size={size} icon={icon} aria-label={label} title={label} {...rest} />;
}

/** Pushes following footer actions to the right. */
export function Spacer() {
  return <span className="flex-1" aria-hidden="true" />;
}

/* ---------- Text helpers ---------- */

export function Hint({ children, className, tone = 'muted', role }: { children: ReactNode; className?: string; tone?: 'muted' | 'danger'; role?: 'alert' | 'status' }) {
  return <p role={role} className={cn('text-xs leading-relaxed', tone === 'danger' ? 'text-destructive' : 'text-muted-foreground', className)}>{children}</p>;
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground', className)}>{children}</span>;
}

/** Page title row used by every view: eyebrow, h1, description and right-aligned actions. */
export function PageHeader({ title, eyebrow, description, actions, aside, className }: { title: ReactNode; eyebrow?: ReactNode; description?: ReactNode; actions?: ReactNode; aside?: ReactNode; className?: string }) {
  return <header className={cn('flex flex-wrap items-end justify-between gap-x-6 gap-y-3', className)}>
    <div className="grid min-w-0 gap-1">
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <h1>{title}</h1>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
      {aside && <div className="mt-1 flex flex-wrap gap-1.5">{aside}</div>}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </header>;
}

/** Compact number-first tile for summary rows. */
export function StatTile({ label, value, icon, tone = 'neutral', onClick, className }: { label: ReactNode; value: ReactNode; icon?: IconName; tone?: 'neutral' | 'accent' | 'now' | 'danger' | 'success'; onClick?: () => void; className?: string }) {
  const tones = {
    neutral: 'bg-secondary text-secondary-foreground',
    accent: 'bg-primary-soft text-primary-soft-foreground',
    now: 'bg-now-soft text-now-foreground',
    danger: 'bg-destructive/10 text-destructive',
    success: 'bg-success-soft text-success',
  } as const;
  const body = <>
    {icon && <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl', tones[tone])}><Icon name={icon} size={17} strokeWidth={2.2} /></span>}
    <span className="grid min-w-0 gap-0">
      <strong className="display-number truncate text-[20px] font-extrabold leading-tight">{value}</strong>
      <span className="truncate text-xs font-medium text-muted-foreground">{label}</span>
    </span>
  </>;
  const classes = cn('flex items-center gap-3 rounded-2xl bg-card px-4 py-3 text-left shadow-card ring-1 ring-foreground/[0.06] dark:ring-foreground/[0.09]', onClick && 'transition-[transform,box-shadow] hover:-translate-y-px hover:shadow-float outline-none focus-visible:ring-3 focus-visible:ring-ring/50', className);
  return onClick ? <button type="button" className={classes} onClick={onClick}>{body}</button> : <div className={classes}>{body}</div>;
}

/* ---------- Forms ---------- */

export function Field({ label, hint, error, children, className, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string; htmlFor?: string }) {
  return <div className={cn('grid gap-1.5', className)}>
    <Label htmlFor={htmlFor} className="text-[13px] font-semibold text-foreground/80">{label}</Label>
    {children}
    {hint && !error ? <Hint>{hint}</Hint> : null}
    {error ? <Hint tone="danger" role="alert">{error}</Hint> : null}
  </div>;
}

export function Input({ className, small, ...rest }: ComponentProps<'input'> & { small?: boolean }) {
  return <ShadInput className={cn('h-10 rounded-xl bg-card px-3 shadow-[inset_0_1px_2px_rgb(0_0_0/0.03)] placeholder:text-muted-foreground/80 dark:bg-input/20', small && 'h-8 rounded-lg px-2.5 text-sm md:text-[13px]', className)} {...rest} />;
}

export function Select({ className, small, children, ...rest }: Omit<ComponentProps<'select'>, 'size'> & { small?: boolean }) {
  return <NativeSelect size={small ? 'sm' : 'default'} className={cn('w-full', className)} {...rest}>{children}</NativeSelect>;
}

export function Textarea({ className, ...rest }: ComponentProps<'textarea'>) {
  return <ShadTextarea className={cn('min-h-24 rounded-xl bg-card px-3 py-2.5 dark:bg-input/20', className)} {...rest} />;
}

export function Toggle({ checked, onChange, label, disabled, id, description }: { checked: boolean; onChange: (value: boolean) => void; label: ReactNode; disabled?: boolean; id?: string; description?: ReactNode }) {
  const generated = useId();
  const switchId = id ?? generated;
  return <div className="flex items-start gap-3">
    <Switch id={switchId} checked={checked} onCheckedChange={onChange} disabled={disabled} className="mt-0.5" />
    <div className="grid gap-0.5">
      <Label htmlFor={switchId} className="font-medium leading-snug">{label}</Label>
      {description && <Hint>{description}</Hint>}
    </div>
  </div>;
}

/** Single-choice control. Items are radios inside a labelled group. */
export function Segmented<T extends string>({ value, options, onChange, label, disabled, className, size = 'md' }: { value: T; options: Array<{ value: T; label: ReactNode; disabled?: boolean }>; onChange: (value: T) => void; label: string; disabled?: boolean; className?: string; size?: 'sm' | 'md' }) {
  return <ToggleGroup type="single" value={value} onValueChange={(next) => { if (next) onChange(next as T); }} aria-label={label} disabled={disabled} spacing={1} className={cn('inline-flex w-fit max-w-full flex-wrap rounded-xl bg-muted p-1 ring-1 ring-inset ring-foreground/[0.04]', className)}>
    {options.map((option) => <ToggleGroupItem key={option.value} value={option.value} disabled={option.disabled} size="sm" className={cn('rounded-lg px-3 text-[13px] font-semibold text-muted-foreground transition-all hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_1px_rgb(0_0_0/0.03)] dark:data-[state=on]:bg-secondary', size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8')}>{option.label}</ToggleGroupItem>)}
  </ToggleGroup>;
}

export function WeekdayPicker({ value, onChange, label, disabled }: { value: number[]; onChange: (value: number[]) => void; label: string; disabled?: boolean }) {
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
    {names.map((name, index) => {
      const day = index + 1;
      const active = value.includes(day);
      return <ShadToggle key={day} variant="outline" size="sm" pressed={active} disabled={disabled} className="min-w-[48px] rounded-full bg-card font-semibold data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
        onPressedChange={() => onChange(active ? value.filter((entry) => entry !== day) : [...value, day].sort((left, right) => left - right))}>{name}</ShadToggle>;
    })}
  </div>;
}

/** Seven-day (or any) row of selectable dates with a small caption per day. */
export function WeekStrip({ days, selected, today, onSelect }: { days: Array<{ date: string; caption: string; closed?: boolean; label: string }>; selected: string; today: string; onSelect: (date: string) => void }) {
  return <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
    {days.map((day) => {
      const active = day.date === selected;
      const isToday = day.date === today;
      return <button key={day.date} type="button" aria-pressed={active} aria-label={day.label} onClick={() => onSelect(day.date)}
        className={cn('group/day grid justify-items-center gap-1 rounded-2xl px-0.5 py-2.5 text-xs outline-none transition-[background-color,box-shadow,transform] focus-visible:ring-3 focus-visible:ring-ring/50',
          active ? 'bg-primary text-primary-foreground shadow-[0_6px_16px_-6px_color-mix(in_srgb,var(--primary)_70%,transparent)]' : 'text-muted-foreground hover:bg-muted', day.closed && !active && 'opacity-60')}>
        <span className={cn('text-[10.5px] font-bold uppercase tracking-wide', active ? 'text-primary-foreground/80' : 'text-muted-foreground')}>{formatDate(day.date, { weekday: 'short' }).slice(0, 3)}</span>
        <span className={cn('grid size-8 place-items-center rounded-full text-[15px] font-extrabold tabular-nums', active ? 'bg-white/15 text-primary-foreground' : isToday ? 'bg-primary-soft text-primary-soft-foreground ring-1 ring-primary/40' : 'text-foreground')}>{Number(day.date.slice(8))}</span>
        <small className={cn('max-w-full truncate text-[10.5px] font-semibold', active ? 'text-primary-foreground/85' : 'text-muted-foreground')}>{day.caption}</small>
      </button>;
    })}
  </div>;
}

/* ---------- Status and messaging ---------- */

type ChipTone = 'neutral' | 'accent' | 'now' | 'success' | 'danger' | 'warning' | 'outline';
const CHIP_TONES: Record<ChipTone, string> = {
  neutral: 'bg-secondary text-secondary-foreground',
  accent: 'bg-primary-soft text-primary-soft-foreground',
  now: 'bg-now-soft text-now-foreground',
  success: 'bg-success-soft text-success',
  danger: 'bg-destructive/10 text-destructive',
  warning: 'bg-warning-soft text-warning',
  outline: 'bg-transparent text-muted-foreground ring-1 ring-inset ring-border',
};

export function Chip({ tone = 'neutral', icon, children, className }: { tone?: ChipTone; icon?: IconName; children: ReactNode; className?: string }) {
  return <Badge variant="secondary" className={cn('h-auto min-h-6 gap-1.5 whitespace-normal rounded-full px-2.5 py-0.5 text-[11.5px] font-bold', CHIP_TONES[tone], className)}>{icon && <Icon name={icon} size={12} strokeWidth={2.4} />}{children}</Badge>;
}

type CalloutTone = 'warning' | 'danger' | 'success' | 'info' | 'neutral';
const CALLOUT_TONES: Record<CalloutTone, string> = {
  warning: 'border-warning/25 bg-warning-soft text-warning',
  danger: 'border-destructive/25 bg-destructive/10 text-destructive',
  success: 'border-success/25 bg-success-soft text-success',
  info: 'border-primary/25 bg-primary-soft text-primary-soft-foreground',
  neutral: 'border-transparent bg-muted text-foreground/85',
};

export function Callout({ tone = 'neutral', icon, title, children, actions, role, className }: { tone?: CalloutTone; icon?: IconName; title?: ReactNode; children?: ReactNode; actions?: ReactNode; role?: 'alert' | 'status'; className?: string }) {
  return <Alert role={role} className={cn('rounded-2xl px-4 py-3.5', CALLOUT_TONES[tone], className)}>
    {icon && <Icon name={icon} size={16} strokeWidth={2.2} />}
    {title && <AlertTitle className="font-bold">{title}</AlertTitle>}
    {children && <AlertDescription className="text-current/90 [&_p]:text-current">{children}</AlertDescription>}
    {actions && <div className="mt-2.5 flex flex-wrap gap-2 group-has-[>svg]/alert:col-start-2">{actions}</div>}
  </Alert>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <Callout tone="danger" role="alert">{children}</Callout>;
}

export function EmptyState({ icon, title, children, action }: { icon: IconName; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return <div className="grid justify-items-center gap-2 px-4 py-10 text-center">
    <span className="relative mb-2 grid size-16 place-items-center rounded-[22px] bg-primary-soft text-primary-soft-foreground shadow-[inset_0_-2px_0_rgb(0_0_0/0.05)]">
      <span aria-hidden="true" className="absolute inset-0 rounded-[22px] bg-[radial-gradient(circle_at_30%_20%,rgb(255_255_255/0.6),transparent_60%)]" />
      <Icon name={icon} size={26} strokeWidth={2} className="relative" />
    </span>
    <h3 className="text-[16px] font-bold">{title}</h3>
    {children && <p className="max-w-[36ch] text-sm text-muted-foreground">{children}</p>}
    {action && <div className="mt-2">{action}</div>}
  </div>;
}

export function ColorDot({ color, size = 10 }: { color: string; size?: number }) {
  return <span aria-hidden="true" className="inline-block shrink-0 rounded-full ring-1 ring-inset ring-black/10" style={{ width: size, height: size, background: color }} />;
}

/* ---------- Surfaces ---------- */

/** A card with a heading row. `id` is placed on the heading for aria-labelledby. */
export function Section({ title, id, description, action, children, className, contentClassName, eyebrow, icon, ...rest }: Omit<ComponentProps<'div'>, 'title'> & { title: ReactNode; id?: string; description?: ReactNode; action?: ReactNode; eyebrow?: ReactNode; icon?: IconName; contentClassName?: string }) {
  return <Card className={cn('gap-4', className)} aria-labelledby={id} {...rest}>
    <CardHeader className="gap-x-3 gap-y-3 max-sm:flex max-sm:flex-wrap max-sm:items-start">
      <div className="flex min-w-0 items-start gap-3">
        {icon && <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-soft-foreground"><Icon name={icon} size={16} strokeWidth={2.2} /></span>}
        <div className="grid min-w-0 gap-0.5">
          {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
          <h2 id={id} className="text-[15.5px] font-bold leading-snug tracking-tight">{title}</h2>
          {description && <CardDescription className="text-[13px]">{description}</CardDescription>}
        </div>
      </div>
      {action && <CardAction className="flex flex-wrap gap-2 max-sm:w-full max-sm:justify-end">{action}</CardAction>}
    </CardHeader>
    <CardContent className={cn('grid gap-3', contentClassName)}>{children}</CardContent>
  </Card>;
}

export function SectionHeader({ title, description, action, eyebrow }: { title: ReactNode; description?: ReactNode; action?: ReactNode; eyebrow?: ReactNode }) {
  return <div className="flex flex-wrap items-start justify-between gap-3">
    <div className="min-w-0 grid gap-1">
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <h2 className="text-[15.5px] font-bold leading-snug tracking-tight">{title}</h2>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
    {action}
  </div>;
}

/** Muted inset panel inside a card. */
export function Panel({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cn('rounded-xl bg-muted/80 p-4 ring-1 ring-inset ring-foreground/[0.03]', className)} {...rest} />;
}

/* ---------- Modal (Dialog) ---------- */

export function Modal({ open, onClose, title, description, children, footer, wide, fullWidth }: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; fullWidth?: boolean }) {
  return <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogContent showCloseButton={false}
      className={cn('flex max-h-[min(88dvh,940px)] flex-col gap-0 overflow-hidden rounded-3xl bg-card p-0 text-foreground shadow-pop ring-foreground/[0.08]',
        // Phones: rise from the bottom edge like a sheet.
        'max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:max-h-[92dvh] max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none max-sm:data-open:slide-in-from-bottom-6 max-sm:data-open:zoom-in-100 max-sm:data-closed:zoom-out-100 max-sm:data-closed:slide-out-to-bottom-6',
        wide ? 'sm:max-w-[960px]' : 'sm:max-w-[580px]', fullWidth && 'max-h-[94dvh] sm:max-w-[min(1800px,calc(100vw-2rem))]')}>
      <DialogHeader className="flex-row items-start justify-between gap-3 border-b px-5 py-4 text-left sm:px-6">
        <div className="min-w-0 grid gap-1">
          <DialogTitle className="text-[18px] font-bold leading-snug tracking-tight">{title}</DialogTitle>
          {description ? <DialogDescription className="text-[13px]">{description}</DialogDescription> : <DialogDescription className="sr-only">Dialog</DialogDescription>}
        </div>
        <DialogClose asChild><ShadButton variant="ghost" size="icon-sm" aria-label="Close" title="Close" className="rounded-full bg-muted text-muted-foreground hover:text-foreground"><Icon name="x" /></ShadButton></DialogClose>
      </DialogHeader>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-4 overflow-y-auto px-5 py-5 sm:px-6">{children}</div>
      {footer && <DialogFooter className="mx-0 mb-0 flex-row flex-wrap items-center gap-2 border-t bg-muted/60 px-5 py-3.5 sm:justify-start sm:px-6">{footer}</DialogFooter>}
    </DialogContent>
  </Dialog>;
}
