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

export function Button({ variant = 'secondary', size = 'md', icon, iconRight, busy, children, type = 'button', disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; icon?: IconName; iconRight?: IconName; busy?: boolean }) {
  const iconOnly = children === undefined || children === null || children === false;
  const shadSize = iconOnly ? (size === 'sm' ? 'icon-sm' : size === 'lg' ? 'icon-lg' : 'icon') : size === 'sm' ? 'sm' : size === 'lg' ? 'lg' : 'default';
  return <ShadButton type={type} variant={VARIANTS[variant]} size={shadSize} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
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
  return <p role={role} className={cn('text-xs', tone === 'danger' ? 'text-destructive' : 'text-muted-foreground', className)}>{children}</p>;
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground', className)}>{children}</span>;
}

/* ---------- Forms ---------- */

export function Field({ label, hint, error, children, className, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string; htmlFor?: string }) {
  return <div className={cn('grid gap-1.5', className)}>
    <Label htmlFor={htmlFor} className="text-muted-foreground">{label}</Label>
    {children}
    {hint && !error ? <Hint>{hint}</Hint> : null}
    {error ? <Hint tone="danger" role="alert">{error}</Hint> : null}
  </div>;
}

export function Input({ className, small, ...rest }: ComponentProps<'input'> & { small?: boolean }) {
  return <ShadInput className={cn(small && 'h-8 text-sm md:text-[13px]', className)} {...rest} />;
}

export function Select({ className, small, children, ...rest }: Omit<ComponentProps<'select'>, 'size'> & { small?: boolean }) {
  return <NativeSelect size={small ? 'sm' : 'default'} className={cn('w-full', className)} {...rest}>{children}</NativeSelect>;
}

export function Textarea({ className, ...rest }: ComponentProps<'textarea'>) {
  return <ShadTextarea className={cn('min-h-24', className)} {...rest} />;
}

export function Toggle({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (value: boolean) => void; label: ReactNode; disabled?: boolean; id?: string }) {
  const generated = useId();
  const switchId = id ?? generated;
  return <div className="flex items-center gap-2.5">
    <Switch id={switchId} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    <Label htmlFor={switchId} className="font-medium leading-snug">{label}</Label>
  </div>;
}

/** Single-choice control. Items are radios inside a labelled group. */
export function Segmented<T extends string>({ value, options, onChange, label, disabled, className }: { value: T; options: Array<{ value: T; label: ReactNode; disabled?: boolean }>; onChange: (value: T) => void; label: string; disabled?: boolean; className?: string }) {
  return <ToggleGroup type="single" value={value} onValueChange={(next) => { if (next) onChange(next as T); }} aria-label={label} disabled={disabled} spacing={1} className={cn('inline-flex w-fit max-w-full flex-wrap rounded-lg bg-muted p-[3px]', className)}>
    {options.map((option) => <ToggleGroupItem key={option.value} value={option.value} disabled={option.disabled} size="sm" className="h-7 rounded-md px-3 text-[13px] font-medium text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm">{option.label}</ToggleGroupItem>)}
  </ToggleGroup>;
}

export function WeekdayPicker({ value, onChange, label, disabled }: { value: number[]; onChange: (value: number[]) => void; label: string; disabled?: boolean }) {
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
    {names.map((name, index) => {
      const day = index + 1;
      const active = value.includes(day);
      return <ShadToggle key={day} variant="outline" size="sm" pressed={active} disabled={disabled} className="min-w-[46px] data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
        onPressedChange={() => onChange(active ? value.filter((entry) => entry !== day) : [...value, day].sort((left, right) => left - right))}>{name}</ShadToggle>;
    })}
  </div>;
}

/** Seven-day (or any) row of selectable dates with a small caption per day. */
export function WeekStrip({ days, selected, today, onSelect }: { days: Array<{ date: string; caption: string; closed?: boolean; label: string }>; selected: string; today: string; onSelect: (date: string) => void }) {
  return <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
    {days.map((day) => {
      const active = day.date === selected;
      return <button key={day.date} type="button" aria-pressed={active} aria-label={day.label} onClick={() => onSelect(day.date)}
        className={cn('grid justify-items-center gap-0.5 rounded-lg border border-transparent px-0.5 py-2 text-xs text-muted-foreground transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50', active ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted')}>
        <span>{formatDate(day.date, { weekday: 'short' }).slice(0, 3)}</span>
        <strong className={cn('text-[15px] font-semibold', active ? 'text-primary-foreground' : day.closed ? 'font-medium text-muted-foreground' : day.date === today ? 'text-primary' : 'text-foreground')}>{Number(day.date.slice(8))}</strong>
        <small className={cn('max-w-full truncate text-[10.5px]', active ? 'text-primary-foreground/90' : 'text-muted-foreground')}>{day.caption}</small>
      </button>;
    })}
  </div>;
}

/* ---------- Status and messaging ---------- */

type ChipTone = 'neutral' | 'accent' | 'now' | 'success' | 'danger' | 'warning';
const CHIP_TONES: Record<ChipTone, string> = {
  neutral: 'bg-secondary text-secondary-foreground',
  accent: 'bg-primary-soft text-primary-soft-foreground',
  now: 'bg-now-soft text-now-foreground',
  success: 'bg-success-soft text-success',
  danger: 'bg-destructive/10 text-destructive',
  warning: 'bg-warning-soft text-warning',
};

export function Chip({ tone = 'neutral', icon, children, className }: { tone?: ChipTone; icon?: IconName; children: ReactNode; className?: string }) {
  return <Badge variant="secondary" className={cn('h-auto min-h-5 whitespace-normal py-0.5 font-semibold', CHIP_TONES[tone], className)}>{icon && <Icon name={icon} size={12} strokeWidth={2.2} />}{children}</Badge>;
}

type CalloutTone = 'warning' | 'danger' | 'success' | 'info' | 'neutral';
const CALLOUT_TONES: Record<CalloutTone, string> = {
  warning: 'border-warning/20 bg-warning-soft text-warning',
  danger: 'border-destructive/20 bg-destructive/10 text-destructive',
  success: 'border-success/20 bg-success-soft text-success',
  info: 'border-primary/20 bg-primary-soft text-primary-soft-foreground',
  neutral: 'bg-muted text-muted-foreground',
};

export function Callout({ tone = 'neutral', icon, title, children, actions, role, className }: { tone?: CalloutTone; icon?: IconName; title?: ReactNode; children?: ReactNode; actions?: ReactNode; role?: 'alert' | 'status'; className?: string }) {
  return <Alert role={role} className={cn('px-3.5 py-3', CALLOUT_TONES[tone], className)}>
    {icon && <Icon name={icon} size={16} />}
    {title && <AlertTitle className="font-semibold">{title}</AlertTitle>}
    {children && <AlertDescription className="text-current/90 [&_p]:text-current">{children}</AlertDescription>}
    {actions && <div className="mt-2 flex flex-wrap gap-2 group-has-[>svg]/alert:col-start-2">{actions}</div>}
  </Alert>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <Callout tone="danger" role="alert">{children}</Callout>;
}

export function EmptyState({ icon, title, children, action }: { icon: IconName; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return <div className="grid justify-items-center gap-2 px-4 py-8 text-center">
    <span className="mb-1 grid size-12 place-items-center rounded-2xl bg-primary-soft text-primary-soft-foreground"><Icon name={icon} size={22} /></span>
    <h3 className="text-[15px]">{title}</h3>
    {children && <p className="max-w-[34ch] text-sm text-muted-foreground">{children}</p>}
    {action && <div className="mt-2">{action}</div>}
  </div>;
}

export function ColorDot({ color, size = 10 }: { color: string; size?: number }) {
  return <span aria-hidden="true" className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: color }} />;
}

/* ---------- Surfaces ---------- */

/** A card with a heading row. `id` is placed on the heading for aria-labelledby. */
export function Section({ title, id, description, action, children, className, contentClassName, eyebrow, ...rest }: Omit<ComponentProps<'div'>, 'title'> & { title: ReactNode; id?: string; description?: ReactNode; action?: ReactNode; eyebrow?: ReactNode; contentClassName?: string }) {
  return <Card className={cn('gap-3', className)} aria-labelledby={id} {...rest}>
    <CardHeader>
      <div className="grid min-w-0 gap-1">
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <h2 id={id} className="text-base font-semibold leading-snug">{title}</h2>
        {description && <CardDescription>{description}</CardDescription>}
      </div>
      {action && <CardAction className="flex flex-wrap gap-2">{action}</CardAction>}
    </CardHeader>
    <CardContent className={cn('grid gap-3', contentClassName)}>{children}</CardContent>
  </Card>;
}

export function SectionHeader({ title, description, action, eyebrow }: { title: ReactNode; description?: ReactNode; action?: ReactNode; eyebrow?: ReactNode }) {
  return <div className="flex flex-wrap items-start justify-between gap-3">
    <div className="min-w-0 grid gap-1">
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <h2 className="text-base font-semibold leading-snug">{title}</h2>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
    {action}
  </div>;
}

/** Muted inset panel inside a card. */
export function Panel({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cn('rounded-lg bg-muted p-4', className)} {...rest} />;
}

/* ---------- Modal (Dialog) ---------- */

export function Modal({ open, onClose, title, description, children, footer, wide, fullWidth }: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; fullWidth?: boolean }) {
  return <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogContent showCloseButton={false}
      className={cn('flex max-h-[min(88dvh,900px)] flex-col gap-0 overflow-hidden p-0 text-foreground', wide ? 'sm:max-w-[960px]' : 'sm:max-w-[560px]', fullWidth && 'max-h-[94dvh] max-w-[calc(100vw-1rem)] sm:max-w-[min(1800px,calc(100vw-2rem))]')}>
      <DialogHeader className="flex-row items-start justify-between gap-3 border-b px-5 py-4 text-left">
        <div className="min-w-0 grid gap-1">
          <DialogTitle className="text-[17px] leading-snug">{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : <DialogDescription className="sr-only">Dialog</DialogDescription>}
        </div>
        <DialogClose asChild><ShadButton variant="ghost" size="icon-sm" aria-label="Close" title="Close"><Icon name="x" /></ShadButton></DialogClose>
      </DialogHeader>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-4 overflow-y-auto px-5 py-4">{children}</div>
      {footer && <DialogFooter className="mx-0 mb-0 flex-row flex-wrap items-center gap-2 border-t bg-muted/50 px-5 py-3 sm:justify-start">{footer}</DialogFooter>}
    </DialogContent>
  </Dialog>;
}
