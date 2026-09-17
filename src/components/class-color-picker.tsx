'use client';

import { useEffect, useRef, useState } from 'react';
import { Popover } from 'radix-ui';
import type { StudentClass } from '@/domain/schedule';
import { classColor } from '@/lib/format';
import { errorMessage } from '@/client/api';
import { Button, Hint } from './primitives';

const COLORS = ['#0891b2', '#4f46e5', '#7e22ce', '#be185d', '#c2410c', '#ca8a04', '#15803d', '#334155'];

/** The card's top edge doubles as a hover, keyboard and touch color control. */
export function ClassColorPicker({ cls, disabled, onSave }: { cls: StudentClass; disabled: boolean; onSave: (color: string | undefined) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(classColor(cls.id, 'class', cls.color).dot);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const content = useRef<HTMLDivElement>(null);
  const cancelClose = () => clearTimeout(closeTimer.current);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const changeOpen = (next: boolean) => {
    cancelClose();
    if (pending) return;
    if (next && !open) {
      setDraft(classColor(cls.id, 'class', cls.color).dot);
      setError('');
    }
    setOpen(next);
  };
  const leave = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (!pending && !content.current?.contains(document.activeElement)) setOpen(false);
    }, 200);
  };
  const save = async (color: string | undefined) => {
    cancelClose();
    setPending(true);
    setError('');
    try { await onSave(color); setOpen(false); }
    catch (err) { setError(errorMessage(err)); }
    finally { setPending(false); }
  };

  return <Popover.Root open={open} onOpenChange={changeOpen}>
    <Popover.Trigger asChild>
      <button type="button" disabled={disabled} aria-label={`Change color for ${cls.name}`}
        className="absolute -top-1 inset-x-0 h-4 rounded-t-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        onPointerEnter={(event) => { if (event.pointerType === 'mouse' && !disabled) changeOpen(true); }} onPointerLeave={leave} />
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content ref={content} side="top" align="start" sideOffset={6} collisionPadding={12}
        aria-label={`Color for ${cls.name}`} onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()} onPointerEnter={cancelClose} onPointerLeave={leave}
        className="z-50 grid w-64 gap-3 rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
        <p className="text-sm font-semibold">Class color</p>
        <div className="grid grid-cols-8 gap-1">
          {COLORS.map((color) => <button key={color} type="button" aria-label={`Use ${color}`} disabled={disabled || pending}
            className="size-6 rounded-full border border-black/10 outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
            style={{ backgroundColor: color }} onClick={() => void save(color)} />)}
        </div>
        <div className="flex items-center gap-2">
          <input type="color" aria-label={`Custom color for ${cls.name}`} value={draft} disabled={disabled || pending}
            className="h-9 w-12 cursor-pointer rounded-md border border-input bg-transparent p-1" onChange={(event) => setDraft(event.target.value)} />
          <Button size="sm" busy={pending} disabled={disabled} onClick={() => void save(draft)}>Save color</Button>
        </div>
        <Button size="sm" variant="ghost" disabled={disabled || pending || !cls.color} onClick={() => void save(undefined)}>Use automatic color</Button>
        {error && <Hint tone="danger" role="alert">{error}</Hint>}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
