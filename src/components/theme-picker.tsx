'use client';

import { cn } from '@/lib/utils';
import { useId } from 'react';
import { isCustomAccent } from '@/lib/accent';
import { Icon } from './icon';
import { ACCENTS, useTheme, type AccentId, type Appearance } from '@/lib/theme';
import { Button, ChoiceGroup, ChoiceItem, Hint, IconButton, Segmented } from './primitives';
import { Label } from './ui/label';
import { ColorPicker } from './ui/color-picker';

export function ThemePicker() {
  const theme = useTheme();
  const colorId = useId();
  const custom = isCustomAccent(theme.accent);
  const color = custom ? theme.accent : ACCENTS.find((accent) => accent.id === theme.accent)!.swatch;
  return <div className="grid gap-4">
    <div className="grid gap-1.5">
      <Label className="text-[13px] font-semibold text-foreground/80">Appearance</Label>
      <Segmented<Appearance> label="Appearance" value={theme.appearance} onChange={theme.setAppearance} options={[
        { value: 'system', label: 'System' }, { value: 'light', label: <span className="inline-flex items-center gap-1.5"><Icon name="sun" size={14} />Light</span> }, { value: 'dark', label: <span className="inline-flex items-center gap-1.5"><Icon name="moon" size={14} />Dark</span> },
      ]} />
    </div>
    <div className="grid gap-1.5">
      <Label className="text-[13px] font-semibold text-foreground/80">Accent color</Label>
      <ChoiceGroup<AccentId> className="flex flex-wrap gap-2.5" label="Accent color" value={theme.accent} onChange={theme.setAccent}>
        {ACCENTS.map((accent) => {
          const selected = theme.accent === accent.id;
          return <ChoiceItem key={accent.id} value={accent.id} aria-label={accent.label} title={accent.label} style={{ background: accent.swatch }}
            className={cn('grid size-9 place-items-center rounded-full text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.3),0_2px_6px_-2px_rgb(0_0_0/0.4)] ring-2 ring-offset-2 ring-offset-background transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-ring', selected ? 'scale-105 ring-foreground' : 'ring-transparent')}>
            {selected && <Icon name="check" size={14} strokeWidth={3} />}
          </ChoiceItem>;
        })}
      </ChoiceGroup>
      <div className="mt-2 grid gap-3 rounded-xl border bg-card p-3">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={colorId} className="text-[13px] font-semibold">Custom color</Label>
          {custom && <Button size="sm" variant="ghost" onClick={() => theme.setAccent('ocean')}>Reset accent</Button>}
        </div>
        <ColorPicker id={colorId} label="Custom accent hex color" value={color} onValueChange={(value) => theme.setAccent(value as AccentId)} />
        <Hint>Changes apply instantly and save on this device. Shades adjust for readable text in light and dark mode.</Hint>
      </div>
    </div>
  </div>;
}

/** One-tap light/dark switch for screens without an account menu. */
export function AppearanceToggle() {
  const theme = useTheme();
  const dark = theme.resolved === 'dark';
  return <IconButton label={dark ? 'Switch to light appearance' : 'Switch to dark appearance'} icon={dark ? 'sun' : 'moon'} variant="ghost" onClick={() => theme.setAppearance(dark ? 'light' : 'dark')} />;
}
