'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { StudentClass } from '@/domain/schedule';
import { classColor } from '@/lib/format';
import { errorMessage } from '@/client/api';
import { Button, Hint } from './primitives';
import { ColorPicker } from './ui/color-picker';

/** An absolute extension of the card surface; opening never changes layout. */
export function ClassColorPicker({ cls, disabled, onSave }: { cls: StudentClass; disabled: boolean; onSave: (color: string | undefined) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(classColor(cls.id, 'class', cls.color).dot);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [lift, setLift] = useState(0);
  const id = useId();
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancelClose = () => clearTimeout(closeTimer.current);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useLayoutEffect(() => {
    const measure = () => {
      if (!root.current || !content.current) return;
      const mobileHeader = document.querySelector('.app-topbar')?.getBoundingClientRect();
      const top = mobileHeader?.height ? mobileHeader.bottom + 8 : 8;
      setLift(Math.max(0, Math.min(content.current.offsetHeight, root.current.getBoundingClientRect().top - top)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content.current!);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: globalThis.PointerEvent) => { if (!pending && !root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, pending]);
  const changeOpen = (next: boolean) => {
    cancelClose();
    if (pending) return;
    if (next && !open) { setDraft(classColor(cls.id, 'class', cls.color).dot); setError(''); }
    setOpen(next);
  };
  const leave = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (!pending && !root.current?.contains(document.activeElement)) setOpen(false);
    }, 250);
  };
  const save = async (color: string | undefined) => {
    cancelClose(); setPending(true); setError('');
    try { await onSave(color); setOpen(false); trigger.current?.focus(); }
    catch (err) { setError(errorMessage(err)); }
    finally { setPending(false); }
  };

  return <div ref={root} data-color-picker-open={open} className="absolute -top-1 inset-x-0" style={{ zIndex: open ? 40 : 1 }}
    onPointerEnter={cancelClose} onPointerLeave={leave}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) leave(); }}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); changeOpen(false); trigger.current?.focus(); } }}>
    <button ref={trigger} type="button" disabled={disabled} aria-label={`Change color for ${cls.name}`} aria-expanded={open} aria-controls={id}
      className="absolute inset-x-0 top-0 h-4 rounded-t-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      onClick={() => changeOpen(!open)} onPointerEnter={(event) => { if (event.pointerType === 'mouse' && !disabled) changeOpen(true); }} />
    <div ref={content} id={id} role="dialog" aria-label={`Color for ${cls.name}`} aria-hidden={!open} inert={!open}
      className="absolute inset-x-0 grid gap-3 rounded-t-xl border-t-4 bg-card p-3 text-card-foreground shadow-lg ring-1 ring-foreground/10 transition-[transform,clip-path,opacity] duration-200 ease-out"
      style={{ top: -lift, borderTopColor: draft, transform: `translateY(${open ? 0 : lift}px)`, clipPath: open ? 'inset(0 0 0 0)' : 'inset(0 0 calc(100% - 4px) 0)', opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none' }}>
      <div className="flex items-center justify-between gap-2">
        <strong className="text-xs">Class color</strong>
        <Button size="sm" variant="ghost" icon="x" aria-label="Close color picker" disabled={pending} onClick={() => { changeOpen(false); trigger.current?.focus(); }} />
      </div>
      <ColorPicker value={draft} onValueChange={setDraft} disabled={disabled || pending} label={`Custom color for ${cls.name}`} />
      <div className="flex flex-wrap items-center justify-between gap-1">
        <Button size="sm" variant="ghost" className="px-1 text-xs" disabled={disabled || pending || !cls.color} onClick={() => void save(undefined)}>Use automatic color</Button>
        <Button size="sm" busy={pending} disabled={disabled} onClick={() => void save(draft)}>Save color</Button>
      </div>
      {error && <Hint tone="danger" role="alert">{error}</Hint>}
    </div>
  </div>;
}
