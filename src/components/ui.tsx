'use client';

import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Icon, type IconName } from './icon';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft';
type Size = 'sm' | 'md' | 'lg';

export function Button({ variant = 'secondary', size = 'md', icon, iconRight, busy, children, className = '', type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; icon?: IconName; iconRight?: IconName; busy?: boolean }) {
  return <button type={type} className={`btn btn-${variant}${size === 'sm' ? ' btn-sm' : size === 'lg' ? ' btn-lg' : ''}${!children ? ' btn-icon' : ''} ${className}`} disabled={rest.disabled || busy} aria-busy={busy || undefined} {...rest}>
    {busy ? <span className="spinner" aria-hidden="true" /> : icon ? <Icon name={icon} size={size === 'sm' ? 15 : 17} /> : null}
    {children}
    {iconRight && !busy ? <Icon name={iconRight} size={size === 'sm' ? 15 : 17} /> : null}
  </button>;
}

export function IconButton({ label, icon, size = 'md', variant = 'ghost', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: IconName; size?: Size; variant?: Variant }) {
  return <Button variant={variant} size={size} icon={icon} aria-label={label} title={label} {...rest} />;
}

export function Field({ label, hint, error, children, className = '', htmlFor }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string; htmlFor?: string }) {
  return <div className={`field ${className}`}>
    <label htmlFor={htmlFor} className="label">{label}</label>
    {children}
    {hint && !error ? <span className="hint">{hint}</span> : null}
    {error ? <span className="hint" style={{ color: 'var(--danger-text)' }} role="alert">{error}</span> : null}
  </div>;
}

export function Input({ className = '', small, ...rest }: InputHTMLAttributes<HTMLInputElement> & { small?: boolean }) {
  return <input className={`input${small ? ' sm' : ''} ${className}`} {...rest} />;
}

export function Select({ className = '', small, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { small?: boolean }) {
  return <select className={`select${small ? ' sm' : ''} ${className}`} {...rest}>{children}</select>;
}

export function Textarea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`textarea ${className}`} {...rest} />;
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return <label className="toggle">
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} className="toggle-track" onClick={() => onChange(!checked)} />
    <span className="text-sm font-medium">{label}</span>
  </label>;
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: ReactNode }>; onChange: (value: T) => void; label: string }) {
  return <div className="segmented" role="group" aria-label={label}>
    {options.map((option) => <button key={option.value} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}

export function Chip({ tone = 'neutral', icon, children, className = '' }: { tone?: 'neutral' | 'accent' | 'now' | 'success' | 'danger' | 'warning'; icon?: IconName; children: ReactNode; className?: string }) {
  return <span className={`chip${tone === 'neutral' ? '' : ` chip-${tone}`} ${className}`}>{icon && <Icon name={icon} size={12} strokeWidth={2.2} />}{children}</span>;
}

export function Callout({ tone = 'neutral', icon, title, children, actions, role }: { tone?: 'warning' | 'danger' | 'success' | 'info' | 'neutral'; icon?: IconName; title?: ReactNode; children?: ReactNode; actions?: ReactNode; role?: 'alert' | 'status' }) {
  return <div className={`callout callout-${tone} flex gap-3 items-start`} role={role}>
    {icon && <Icon name={icon} size={18} className="mt-0.5" />}
    <div className="min-w-0 flex-1 grid gap-1">
      {title && <strong className="font-semibold">{title}</strong>}
      {children && <div>{children}</div>}
      {actions && <div className="flex flex-wrap gap-2 mt-2">{actions}</div>}
    </div>
  </div>;
}

export function EmptyState({ icon, title, children, action }: { icon: IconName; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return <div className="grid justify-items-center text-center gap-2 py-8 px-4">
    <span className="grid place-items-center w-12 h-12 rounded-2xl bg-accent-soft text-accent-text mb-1"><Icon name={icon} size={22} /></span>
    <h3 className="text-[15px]">{title}</h3>
    {children && <p className="text-sm text-text-2 max-w-[34ch]">{children}</p>}
    {action && <div className="mt-2">{action}</div>}
  </div>;
}

/** Accessible modal built on the native dialog element. Closing via Escape or backdrop calls onClose. */
export function Sheet({ open, onClose, title, children, footer, wide, fullWidth, description }: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; fullWidth?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const onCancel = (event: Event) => { event.preventDefault(); onClose(); };
    const onClick = (event: MouseEvent) => { if (event.target === dialog) onClose(); };
    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('click', onClick);
    return () => { dialog.removeEventListener('cancel', onCancel); dialog.removeEventListener('click', onClick); };
  }, [onClose]);
  return <dialog ref={ref} className={`sheet${wide ? ' wide' : ''}${fullWidth ? ' timetable-sheet' : ''}`} aria-labelledby={titleId}>
    {open && <div className="fade-in">
      <div className="sheet-head">
        <div className="min-w-0"><h2 id={titleId} className="text-[17px]">{title}</h2>{description && <p className="text-sm text-text-2 mt-0.5">{description}</p>}</div>
        <IconButton label="Close" icon="x" onClick={onClose} />
      </div>
      <div className="sheet-body">{children}</div>
      {footer && <div className="sheet-foot">{footer}</div>}
    </div>}
  </dialog>;
}

export function SectionHeader({ title, description, action, eyebrow }: { title: ReactNode; description?: ReactNode; action?: ReactNode; eyebrow?: ReactNode }) {
  return <div className="flex items-start justify-between gap-3 flex-wrap">
    <div className="min-w-0">
      {eyebrow && <div className="eyebrow mb-1">{eyebrow}</div>}
      <h2>{title}</h2>
      {description && <p className="text-sm text-text-2 mt-1">{description}</p>}
    </div>
    {action}
  </div>;
}

export function WeekdayPicker({ value, onChange, label, disabled }: { value: number[]; onChange: (value: number[]) => void; label: string; disabled?: boolean }) {
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
    {names.map((name, index) => {
      const day = index + 1;
      const active = value.includes(day);
      return <button key={day} type="button" disabled={disabled} aria-pressed={active} onClick={() => onChange(active ? value.filter((entry) => entry !== day) : [...value, day].sort((left, right) => left - right))}
        className={`btn btn-sm ${active ? 'btn-primary' : 'btn-secondary'}`} style={{ minWidth: 46 }}>{name}</button>;
    })}
  </div>;
}

export function ColorDot({ color, size = 10 }: { color: string; size?: number }) {
  return <span aria-hidden="true" style={{ width: size, height: size, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }} />;
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="callout callout-danger" role="alert">{children}</p>;
}
