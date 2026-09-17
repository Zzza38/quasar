'use client';

import { cn } from '@/lib/utils';
import { Icon } from './icon';
import { ACCENTS, useTheme, type Appearance } from '@/lib/theme';
import { IconButton, Segmented } from './primitives';
import { Label } from './ui/label';

export function ThemePicker() {
  const theme = useTheme();
  return <div className="grid gap-4">
    <div className="grid gap-1.5">
      <Label className="text-muted-foreground">Appearance</Label>
      <Segmented<Appearance> label="Appearance" value={theme.appearance} onChange={theme.setAppearance} options={[
        { value: 'system', label: 'System' }, { value: 'light', label: <span className="inline-flex items-center gap-1.5"><Icon name="sun" size={14} />Light</span> }, { value: 'dark', label: <span className="inline-flex items-center gap-1.5"><Icon name="moon" size={14} />Dark</span> },
      ]} />
    </div>
    <div className="grid gap-1.5">
      <Label className="text-muted-foreground">Accent colour</Label>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Accent colour">
        {ACCENTS.map((accent) => {
          const selected = theme.accent === accent.id;
          return <button key={accent.id} type="button" role="radio" aria-checked={selected} aria-label={accent.label} title={accent.label} style={{ background: accent.swatch }} onClick={() => theme.setAccent(accent.id)}
            className={cn('grid size-8 place-items-center rounded-full text-white ring-2 ring-offset-2 ring-offset-background transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-ring', selected ? 'ring-foreground' : 'ring-transparent')}>
            {selected && <Icon name="check" size={14} strokeWidth={3} />}
          </button>;
        })}
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
