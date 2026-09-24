'use client';

import { useEffect, useState, type PointerEvent } from 'react';
import { hexToHsv, hsvToHex, type HSV } from '@/lib/color';
import { Input } from './input';
import { Button } from './button';
import { Slider } from './slider';

/** Named so screen readers say "Use Teal" rather than a hex code; the hex stays in the tooltip. */
const COLORS = [
  { hex: '#0891b2', name: 'Teal' },
  { hex: '#4f46e5', name: 'Indigo' },
  { hex: '#7e22ce', name: 'Purple' },
  { hex: '#be185d', name: 'Pink' },
  { hex: '#c2410c', name: 'Orange' },
  { hex: '#ca8a04', name: 'Gold' },
  { hex: '#15803d', name: 'Green' },
  { hex: '#334155', name: 'Slate' },
];

/** Expanded color control composed with shadcn inputs, buttons and Radix sliders. */
export function ColorPicker({ value, onValueChange, disabled, id, label = 'Hex color' }: {
  value: string; onValueChange: (color: string) => void; disabled?: boolean; id?: string; label?: string;
}) {
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  const [hex, setHex] = useState(value);
  // Arrow keys on the 2-D area change the color silently otherwise; announce the new position.
  const [spoken, setSpoken] = useState('');
  useEffect(() => {
    setHex(value);
    setHsv((current) => hsvToHex(current).toLowerCase() === value.toLowerCase() ? current : hexToHsv(value));
  }, [value]);
  const update = (next: HSV) => { setHsv(next); const color = hsvToHex(next); setHex(color); onValueChange(color); };
  const point = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    const box = event.currentTarget.getBoundingClientRect();
    update({ ...hsv, s: Math.max(0, Math.min(100, (event.clientX - box.left) / box.width * 100)), v: Math.max(0, Math.min(100, 100 - (event.clientY - box.top) / box.height * 100)) });
  };
  return <div data-slot="color-picker" className="grid min-w-0 gap-2.5">
    <div role="group" aria-label="Saturation and brightness" aria-description="Use left and right arrows for saturation, up and down arrows for brightness." aria-disabled={disabled} tabIndex={disabled ? -1 : 0}
      className="relative h-24 touch-none cursor-crosshair overflow-hidden rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), hsl(${hsv.h} 100% 50%)` }}
      onPointerDown={(event) => { if (!disabled) { event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus(); point(event); } }}
      onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) point(event); }}
      onKeyDown={(event) => {
        if (disabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const next = { ...hsv, s: Math.max(0, Math.min(100, hsv.s + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0))), v: Math.max(0, Math.min(100, hsv.v + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0))) };
        update(next);
        setSpoken(`Saturation ${Math.round(next.s)}%, brightness ${Math.round(next.v)}%`);
      }}>
      <span aria-hidden="true" className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_#0008]" style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%`, backgroundColor: value }} />
    </div>
    <span className="sr-only" aria-live="polite">{spoken}</span>
    <Slider aria-label="Hue" min={0} max={359} step={1} value={[hsv.h]} disabled={disabled} onValueChange={([h]) => update({ ...hsv, h })}
      trackClassName="bg-[linear-gradient(to_right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)]" />
    <div className="flex items-center gap-2">
      <span aria-hidden="true" className="size-8 shrink-0 rounded-md border" style={{ backgroundColor: value }} />
      <Input id={id} aria-label={label} spellCheck={false} value={hex} disabled={disabled} maxLength={7} className="h-8 font-mono text-xs" onBlur={() => setHex(value)}
        onChange={(event) => { const next = event.target.value; setHex(next); if (/^#[\da-f]{6}$/i.test(next)) onValueChange(next); }} />
    </div>
    <div className="flex justify-between gap-1">
      {COLORS.map((color) => <Button key={color.hex} type="button" size="icon-sm" variant="ghost" disabled={disabled} aria-label={`Use ${color.name}`} title={color.hex} aria-pressed={value.toLowerCase() === color.hex}
        className="size-6 rounded-full border border-black/10 p-0 ring-offset-background pointer-coarse:size-8 pointer-coarse:min-h-0 pointer-coarse:min-w-0 aria-pressed:ring-2 aria-pressed:ring-ring aria-pressed:ring-offset-2" style={{ backgroundColor: color.hex }} onClick={() => onValueChange(color.hex)} />)}
    </div>
  </div>;
}
