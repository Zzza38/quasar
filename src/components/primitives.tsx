'use client';

/**
 * App-level composites on top of the shadcn/ui components in ./ui.
 * Views import from here so the shadcn variant vocabulary stays in one place.
 */

import { Children, createContext, Fragment, isValidElement, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ComponentProps, type CSSProperties, type ReactElement, type ReactNode } from 'react';
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
import { Select as ShadSelect, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Switch } from './ui/switch';
import { Textarea as ShadTextarea } from './ui/textarea';
import { Toggle as ShadToggle } from './ui/toggle';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui';
import { Command, CommandInput, CommandItem, CommandList } from './ui/command';

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

export function Button({ variant = 'secondary', size = 'md', icon, iconRight, busy, children, type = 'button', disabled, className, ...rest }: ComponentProps<'button'> & { variant?: Variant; size?: Size; icon?: IconName; iconRight?: IconName; busy?: boolean }) {
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

export function Hint({ children, className, tone = 'muted', role, id }: { children: ReactNode; className?: string; tone?: 'muted' | 'danger'; role?: 'alert' | 'status'; id?: string }) {
  return <p id={id} role={role} className={cn('text-xs leading-relaxed', tone === 'danger' ? 'text-destructive' : 'text-muted-foreground', className)}>{children}</p>;
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
  const classes = cn('flex items-center gap-3 rounded-2xl bg-card px-4 py-3 text-left shadow-card ring-1 ring-foreground/[0.06] dark:ring-foreground/[0.09]', onClick && 'transition-[transform,box-shadow] hover:-translate-y-px hover:shadow-float outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background', className);
  return onClick ? <button type="button" className={classes} onClick={onClick}>{body}</button> : <div className={classes}>{body}</div>;
}

/* ---------- Forms ---------- */

/**
 * What a Field tells the control it labels: the control's id, the id of the hint or error text shown under it,
 * and whether the control's value is invalid (an error about a failed save is not about the value).
 */
export type FieldLink = { controlId: string; hintId?: string; errorId?: string; invalid?: boolean };
const FieldContext = createContext<(FieldLink & { registerControl?: (id: string) => void }) | null>(null);

/**
 * Ids Field gives its visible hint and error text. Only one is shown at a time, like the markup below.
 * An error marks the control invalid unless `invalid` is false.
 */
export function fieldLink(htmlFor: string | undefined, hint: ReactNode, error: ReactNode, invalid = Boolean(error)): FieldLink | null {
  if (!htmlFor) return null;
  if (error) return { controlId: htmlFor, errorId: `${htmlFor}-error`, invalid };
  if (hint) return { controlId: htmlFor, hintId: `${htmlFor}-hint` };
  return { controlId: htmlFor };
}

type AriaDescription = { 'aria-describedby'?: string; 'aria-invalid'?: ComponentProps<'input'>['aria-invalid'] };

/**
 * ARIA a control inside a Field should carry: its own aria-describedby plus the Field's hint or error, and
 * aria-invalid when the Field shows a validation error. Applies only to the control the Field's label points at, so
 * other controls nested in the same Field are left alone; explicit props from the caller still win.
 */
export function fieldAria(link: FieldLink | null, id: string | undefined, own: AriaDescription): AriaDescription {
  if (!link || !id || id !== link.controlId) return own;
  const linked = link.errorId ?? link.hintId;
  const describedBy = [own['aria-describedby'], linked].filter(Boolean).join(' ') || undefined;
  return { 'aria-describedby': describedBy, 'aria-invalid': own['aria-invalid'] ?? (link.errorId && link.invalid ? true : undefined) };
}

function useFieldAria(id: string | undefined, own: AriaDescription) {
  return fieldAria(useContext(FieldContext), id, own);
}

/** `invalid={false}` shows `error` without marking the control invalid, for failures such as a save that did not go through. */
export function Field({ label, hint, error, invalid, children, className, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; invalid?: boolean; children: ReactNode; className?: string; htmlFor?: string }) {
  const link = fieldLink(htmlFor, hint, error, invalid);
  const [generatedId, registerControl] = useState<string>();
  return <div className={cn('grid gap-1.5', className)}>
    <Label htmlFor={generatedId ?? htmlFor} className="text-[13px] font-semibold text-foreground/80">{label}</Label>
    <FieldContext.Provider value={link ? { ...link, registerControl } : null}>{children}</FieldContext.Provider>
    {hint && !error ? <Hint id={link?.hintId}>{hint}</Hint> : null}
    {error ? <Hint id={link?.errorId} tone="danger" role="alert">{error}</Hint> : null}
  </div>;
}

export function Input({ className, small, ...rest }: ComponentProps<'input'> & { small?: boolean }) {
  const aria = useFieldAria(rest.id, { 'aria-describedby': rest['aria-describedby'], 'aria-invalid': rest['aria-invalid'] });
  return <ShadInput className={cn('h-10 rounded-xl bg-card px-3 shadow-[inset_0_1px_2px_rgb(0_0_0/0.03)] placeholder:text-muted-foreground/80 dark:bg-input/20', small && 'h-8 rounded-lg px-2.5 text-base md:text-[13px]', className)} {...rest} {...aria} />;
}

/** An editable shadcn command combobox. Suggestions never replace text until chosen. */
export function Autocomplete({ options, onSelect, value, onValueChange, small, className, ...props }: Omit<ComponentProps<typeof CommandInput>, 'value' | 'onValueChange'> & {
  value: string; onValueChange: (value: string) => void; onSelect: (value: string) => void; small?: boolean;
  options: { value: string; label: string; description?: string }[];
}) {
  const [open, setOpen] = useState(false);
  const expanded = open && !props.disabled && options.length > 0;
  const field = useContext(FieldContext);
  const registerControl = field?.controlId === props.id ? field?.registerControl : undefined;
  // cmdk owns the input id and uses it to keep focus while results change.
  // Link the visible Field label to that generated id instead of replacing it.
  const inputRef = useCallback((node: HTMLInputElement | null) => {
    if (node) registerControl?.(node.id);
  }, [registerControl]);
  const aria = useFieldAria(props.id, { 'aria-describedby': props['aria-describedby'], 'aria-invalid': props['aria-invalid'] });
  return <Command shouldFilter={false} data-autocomplete-open={expanded} className={cn('relative size-auto overflow-visible bg-transparent p-0 [&_[data-slot=command-input-wrapper]]:p-0 [&_[data-slot=input-group]]:h-11! [&_[data-slot=input-group]]:rounded-xl! [&_[data-slot=input-group]]:border-control-border [&_[data-slot=input-group]]:bg-card [&_[data-slot=input-group]]:px-3 [&_[data-slot=input-group]]:focus-within:ring-2 [&_[data-slot=input-group]]:focus-within:ring-ring [&_[data-slot=input-group-addon]]:hidden', small && '[&_[data-slot=input-group]]:h-8!')}
    onKeyDownCapture={event => {
      if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !expanded && options.length) { event.preventDefault(); setOpen(true); }
      if (event.key === 'Enter' && !expanded) event.stopPropagation();
    }}>
    <CommandInput asChild {...props} id={undefined} {...aria} value={value} onValueChange={next => { setOpen(true); onValueChange(next); }}
      onFocus={event => { setOpen(true); props.onFocus?.(event); }} onBlur={event => { setOpen(false); props.onBlur?.(event); }}
      className={cn('min-w-0 text-base', className)}>
      <Input ref={inputRef} aria-labelledby={props['aria-labelledby']} aria-label={props['aria-label']} aria-expanded={expanded}
        className="h-full! rounded-none! border-0! bg-transparent! px-0! shadow-none! focus-visible:ring-0!" />
    </CommandInput>
    <CommandList hidden={!expanded} className={cn('absolute inset-x-0 top-full z-50 mt-1 max-h-56 rounded-xl border border-border bg-popover p-1 shadow-lg', !expanded && 'hidden')}>
      {expanded && options.map(option => <CommandItem key={option.value} value={option.value} onMouseDown={event => event.preventDefault()}
        onSelect={() => { onSelect(option.value); setOpen(false); }} className="min-h-11 cursor-pointer">
        <span className="grid min-w-0 gap-0.5"><span className="font-semibold">{option.label}</span>{option.description && <span className="text-xs text-muted-foreground">{option.description}</span>}</span>
      </CommandItem>)}
    </CommandList>
  </Command>;
}

/**
 * shadcn/ui Select with the native `<select>` authoring API: pass `<option>` children and read
 * `event.target.value` in `onChange`. Options are rendered as SelectItems so the dropdown is the
 * themed popover, never the OS-drawn list. An option with `value=""` that is `disabled` becomes the
 * placeholder; an enabled `value=""` option is selectable ("All grades", "No class", …).
 */
type OptionProps = { value?: string | number | readonly string[]; disabled?: boolean; children?: ReactNode };
type SelectChangeEvent = { target: { value: string }; currentTarget: { value: string } };
type SelectProps = Omit<ComponentProps<'select'>, 'size' | 'value' | 'defaultValue' | 'onChange'> & {
  small?: boolean;
  value?: string;
  onChange?: (event: SelectChangeEvent) => void | Promise<void>;
};
const EMPTY = '__empty__';

function collectOptions(children: ReactNode, into: { value: string; disabled: boolean; label: ReactNode }[] = []) {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === Fragment) { collectOptions((child as ReactElement<{ children?: ReactNode }>).props.children, into); return; }
    if (child.type !== 'option') return;
    const props = (child as ReactElement<OptionProps>).props;
    const value = props.value === undefined ? textOf(props.children) : String(props.value);
    into.push({ value, disabled: Boolean(props.disabled), label: props.children });
  });
  return into;
}
const textOf = (node: ReactNode): string => Array.isArray(node) ? node.map(textOf).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : '';

/**
 * How `<option>` values map to Radix item values and back. Radix item values cannot be '', so an enabled
 * `value=""` option is stored as EMPTY. `decode` returns null for anything that is not one of the items:
 * inside a <form>, Radix's hidden native select reports '' when the value changes in the same render that
 * adds its option, and passing that on would clear the field.
 */
export function selectModel(children: ReactNode) {
  const options = collectOptions(children);
  const placeholder = options.find((option) => option.value === '' && option.disabled);
  const items = options.filter((option) => option !== placeholder);
  const encode = (raw: string) => (raw === '' ? (placeholder && !items.some((item) => item.value === '') ? '' : EMPTY) : raw);
  const decode = (raw: string): string | null => (items.some((item) => encode(item.value) === raw) ? (raw === EMPTY ? '' : raw) : null);
  return { placeholder, items, encode, decode };
}

export function Select({ className, small, children, value, onChange, id, name, disabled, required, autoFocus, 'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledby, 'aria-describedby': ariaDescribedby, 'aria-invalid': ariaInvalid }: SelectProps) {
  const { placeholder, items, encode, decode } = selectModel(children);
  const current = value === undefined ? undefined : encode(value);
  const aria = useFieldAria(id, { 'aria-describedby': ariaDescribedby, 'aria-invalid': ariaInvalid });
  return <ShadSelect value={current} name={name} disabled={disabled} required={required} onValueChange={(next) => { const decoded = decode(next); if (decoded !== null) void onChange?.({ target: { value: decoded }, currentTarget: { value: decoded } }); }}>
    <SelectTrigger id={id} size={small ? 'sm' : 'default'} autoFocus={autoFocus} aria-label={ariaLabel} aria-labelledby={ariaLabelledby} aria-describedby={aria['aria-describedby']} aria-invalid={aria['aria-invalid']}
      className={cn('w-full rounded-xl bg-card pl-3 shadow-[inset_0_1px_2px_rgb(0_0_0/0.03)] dark:bg-input/20 data-[size=sm]:rounded-lg data-[size=sm]:pl-2.5 data-[size=sm]:text-[13px]', className)}>
      <SelectValue placeholder={placeholder?.label} />
    </SelectTrigger>
    <SelectContent position="popper" align="start" className="max-h-[min(20rem,var(--radix-select-content-available-height))]">
      {items.map((item) => <SelectItem key={item.value} value={encode(item.value)} disabled={item.disabled}>{item.label}</SelectItem>)}
    </SelectContent>
  </ShadSelect>;
}

export function Textarea({ className, ...rest }: ComponentProps<'textarea'>) {
  const aria = useFieldAria(rest.id, { 'aria-describedby': rest['aria-describedby'], 'aria-invalid': rest['aria-invalid'] });
  return <ShadTextarea className={cn('min-h-24 rounded-xl bg-card px-3 py-2.5 dark:bg-input/20', className)} {...rest} {...aria} />;
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

/**
 * Single choice among larger custom items (option cards, color swatches). Built on the Radix single ToggleGroup
 * that Segmented uses, but unstyled: the group is a radiogroup with one Tab stop, and the arrow keys, Home and End
 * move between its ChoiceItems. Tapping the chosen item again keeps it chosen.
 */
export function ChoiceGroup<T extends string>({ value, onChange, label, children, className }: { value: T | null; onChange: (value: T) => void; label: string; children: ReactNode; className?: string }) {
  return <ToggleGroupPrimitive.Root type="single" value={value ?? ''} onValueChange={(next) => { if (next) onChange(next as T); }} aria-label={label} className={className}>{children}</ToggleGroupPrimitive.Root>;
}

/** One radio in a ChoiceGroup. It carries `data-state="on"` when chosen, for styling. */
export function ChoiceItem({ value, className, children, ...rest }: { value: string; className?: string; children?: ReactNode; 'aria-label'?: string; title?: string; style?: CSSProperties }) {
  return <ToggleGroupPrimitive.Item value={value} className={className} {...rest}>{children}</ToggleGroupPrimitive.Item>;
}

/** Large selectable option card, a radio inside a ChoiceGroup. */
export function OptionCard({ value, title, description, className, icon }: { value: string; title: ReactNode; description: ReactNode; className?: string; icon?: 'layers' | 'edit' | 'check' | 'users' }) {
  return <ChoiceItem value={value}
    className={cn('group/option flex gap-3 rounded-2xl bg-card px-4 py-3.5 text-left ring-1 ring-foreground/[0.08] transition-[background-color,box-shadow] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-[state=on]:bg-primary-soft data-[state=on]:ring-2 data-[state=on]:ring-primary data-[state=on]:hover:bg-primary-soft', className)}>
    <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border-2 border-control-border transition-colors group-data-[state=on]/option:border-primary group-data-[state=on]/option:bg-primary group-data-[state=on]/option:text-primary-foreground"><Icon name="check" size={12} strokeWidth={3} className="invisible group-data-[state=on]/option:visible" /></span>
    <span className="grid gap-1">
      <strong className="flex items-center gap-2 text-sm font-bold">{icon && <Icon name={icon} size={14} className="text-muted-foreground" />}{title}</strong>
      <Hint className="group-data-[state=on]/option:text-primary-soft-foreground/80">{description}</Hint>
    </span>
  </ChoiceItem>;
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
export function WeekStrip({ days, selected, today, onSelect }: { days: Array<{ date: string; caption: string; closed?: boolean; label: string; dot?: boolean }>; selected: string; today: string; onSelect: (date: string) => void }) {
  return <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
    {days.map((day) => {
      const active = day.date === selected;
      const isToday = day.date === today;
      return <button key={day.date} type="button" aria-pressed={active} aria-current={isToday ? 'date' : undefined} aria-label={day.label} onClick={() => onSelect(day.date)}
        className={cn('group/day grid justify-items-center gap-1 rounded-2xl px-0.5 py-2.5 text-xs outline-none transition-[background-color,box-shadow,transform] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          active ? 'bg-primary text-primary-foreground shadow-[0_6px_16px_-6px_color-mix(in_srgb,var(--primary)_70%,transparent)]' : 'text-muted-foreground hover:bg-muted', day.closed && !active && 'opacity-60')}>
        <span className={cn('text-[10.5px] font-bold uppercase tracking-wide', active ? 'text-primary-foreground/80' : 'text-muted-foreground')}>{formatDate(day.date, { weekday: 'short' }).slice(0, 3)}</span>
        <span className={cn('grid size-8 place-items-center rounded-full text-[15px] font-extrabold tabular-nums', active ? 'text-primary-foreground' : isToday ? 'bg-primary-soft text-primary-soft-foreground ring-1 ring-primary/40' : 'text-foreground')}>{Number(day.date.slice(8))}</span>
        <small className={cn('max-w-full truncate text-[10.5px] font-semibold', active ? 'text-primary-foreground/85' : 'text-muted-foreground')}>{day.caption}</small>
        <span aria-hidden="true" className={cn('size-1 rounded-full', day.dot ? (active ? 'bg-primary-foreground' : 'bg-primary') : 'bg-transparent')} />
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

/** A card with a heading row. `id` is placed on the heading, and the card becomes a region named by it. */
export function Section({ title, id, description, action, children, className, contentClassName, eyebrow, icon, ...rest }: Omit<ComponentProps<'div'>, 'title'> & { title: ReactNode; id?: string; description?: ReactNode; action?: ReactNode; eyebrow?: ReactNode; icon?: IconName; contentClassName?: string }) {
  return <Card className={cn('gap-4', className)} role={id ? 'region' : undefined} aria-labelledby={id} {...rest}>
    <CardHeader className="gap-x-3 gap-y-3 max-sm:flex max-sm:flex-wrap max-sm:items-start">
      <div className="flex min-w-0 items-start gap-3">
        {icon && <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-soft-foreground"><Icon name={icon} size={16} strokeWidth={2.2} /></span>}
        <div className="grid min-w-0 gap-0.5">
          {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
          <h2 id={id} className="text-[15.5px] font-bold leading-snug tracking-tight">{title}</h2>
          {description && <CardDescription className="text-[13px]">{description}</CardDescription>}
        </div>
      </div>
      {action && <CardAction className="flex flex-wrap gap-2 max-sm:ml-auto">{action}</CardAction>}
    </CardHeader>
    <CardContent className={cn('grid gap-3', contentClassName)}>{children}</CardContent>
  </Card>;
}

/** Muted inset panel inside a card. */
export function Panel({ className, ...rest }: ComponentProps<'div'>) {
  return <div className={cn('rounded-xl bg-muted/80 p-4 ring-1 ring-inset ring-foreground/[0.03]', className)} {...rest} />;
}

/* ---------- Modal (Dialog) ---------- */

/**
 * Overlay taps, Escape and the header X all arrive as onOpenChange(false), so one guard covers them.
 * `busy` keeps the dialog open while a save is in flight; `dirty` asks inside the dialog before discarding
 * a draft (never the browser's unthemed confirm()), and further close requests wait for that answer.
 */
export function Modal({ open, onClose, title, description, children, footer, wide, fullWidth, dirty, busy }: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; fullWidth?: boolean; dirty?: boolean; busy?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  // Where focus was when the prompt opened (usually the field being edited), so it can go back there.
  const returnFocus = useRef<HTMLElement | null>(null);
  // A prompt left over from an earlier opening, or for a draft that is no longer dirty, is dropped.
  if (confirming && (!open || !dirty)) setConfirming(false);
  // Once the prompt goes away with the dialog still open, focus returns to that element. Without this,
  // unmounting the focused 'Keep editing' button leaves Radix to focus the dialog container instead.
  // The frame lets Radix's own focus handling run first.
  useEffect(() => {
    if (confirming) return;
    const target = returnFocus.current;
    returnFocus.current = null;
    if (!open || !target?.isConnected) return;
    const frame = requestAnimationFrame(() => { if (target.isConnected) target.focus(); });
    return () => cancelAnimationFrame(frame);
  }, [confirming, open]);
  const requestClose = () => {
    if (busy) return;
    if (dirty) {
      if (!confirming) {
        const active = document.activeElement;
        returnFocus.current = active instanceof HTMLElement && active !== document.body ? active : null;
      }
      setConfirming(true);
      return;
    }
    onClose();
  };
  const discard = () => { returnFocus.current = null; setConfirming(false); onClose(); };
  return <Dialog open={open} onOpenChange={(next) => { if (!next) requestClose(); }}>
    <DialogContent showCloseButton={false} onInteractOutside={(event) => { if (busy) event.preventDefault(); }}
      onEscapeKeyDown={event => { if (event.target instanceof Element && event.target.closest('[data-autocomplete-open=true]')) event.preventDefault(); }}
      className={cn('flex max-h-[min(88dvh,940px)] flex-col gap-0 overflow-hidden rounded-3xl bg-card p-0 text-foreground shadow-pop ring-foreground/[0.08]',
        // Phones: rise from the bottom edge like a sheet.
        'max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:max-h-[92dvh] max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none max-sm:data-open:slide-in-from-bottom-6 max-sm:data-open:zoom-in-100 max-sm:data-closed:zoom-out-100 max-sm:data-closed:slide-out-to-bottom-6',
        wide ? 'sm:max-w-[960px]' : 'sm:max-w-[580px]', fullWidth && 'max-h-[94dvh] sm:max-w-[min(1800px,calc(100vw-2rem))]')}>
      <DialogHeader className="flex-row items-start justify-between gap-3 border-b px-5 py-4 text-left sm:px-6">
        <div className="min-w-0 grid gap-1">
          <DialogTitle className="text-[18px] font-bold leading-snug tracking-tight">{title}</DialogTitle>
          {/* Radix sets aria-describedby only when a description is mounted, so a dialog without one has none. */}
          {description && <DialogDescription className="text-[13px]">{description}</DialogDescription>}
        </div>
        <DialogClose asChild><ShadButton variant="ghost" size="icon-sm" aria-label="Close" title="Close" disabled={busy} className="rounded-full bg-muted text-muted-foreground hover:text-foreground"><Icon name="x" /></ShadButton></DialogClose>
      </DialogHeader>
      {confirming && <div className="border-b px-5 py-3 sm:px-6">
        <Callout tone="warning" icon="alert" role="alert" title="Discard your changes?" actions={<>
          <Button size="sm" autoFocus onClick={() => setConfirming(false)}>Keep editing</Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={discard}>Discard</Button>
        </>}>What you entered here will be lost.</Callout>
      </div>}
      {/* auto-rows-max: cards hide their overflow, so without it the rows would share the fixed height and clip instead of scrolling. */}
      <div className={cn('grid min-h-0 flex-1 auto-rows-max grid-cols-[minmax(0,1fr)] content-start gap-4 overflow-y-auto px-5 py-5 sm:px-6', !footer && 'max-sm:pb-[max(1.25rem,env(safe-area-inset-bottom))]')}>{children}</div>
      {footer && <DialogFooter className="mx-0 mb-0 flex-row flex-wrap items-center gap-2 border-t bg-muted/60 px-5 py-3.5 max-sm:pb-[max(0.875rem,env(safe-area-inset-bottom))] sm:justify-start sm:px-6">{footer}</DialogFooter>}
    </DialogContent>
  </Dialog>;
}
