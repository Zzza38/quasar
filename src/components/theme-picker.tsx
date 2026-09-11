'use client';

import { Icon } from './icon';
import { ACCENTS, useTheme, type Appearance } from '@/lib/theme';
import { IconButton, Segmented } from './ui';

export function ThemePicker() {
  const theme = useTheme();
  return <div className="grid gap-3">
    <div className="grid gap-1.5">
      <span className="label">Appearance</span>
      <Segmented<Appearance> label="Appearance" value={theme.appearance} onChange={theme.setAppearance} options={[
        { value: 'system', label: 'System' }, { value: 'light', label: <span className="inline-flex items-center gap-1.5"><Icon name="sun" size={14} />Light</span> }, { value: 'dark', label: <span className="inline-flex items-center gap-1.5"><Icon name="moon" size={14} />Dark</span> },
      ]} />
    </div>
    <div className="grid gap-1.5">
      <span className="label">Accent colour</span>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Accent colour">
        {ACCENTS.map((accent) => <button key={accent.id} type="button" role="radio" aria-checked={theme.accent === accent.id} aria-label={accent.label} title={accent.label} className="swatch" style={{ background: accent.swatch }} onClick={() => theme.setAccent(accent.id)}>
          {theme.accent === accent.id && <Icon name="check" size={14} strokeWidth={3} />}
        </button>)}
      </div>
      <span className="hint">{ACCENTS.find((accent) => accent.id === theme.accent)?.label}. Saved on this device.</span>
    </div>
  </div>;
}

/** One-tap light/dark switch for screens without an account menu. */
export function AppearanceToggle() {
  const theme = useTheme();
  const dark = theme.resolved === 'dark';
  return <IconButton label={dark ? 'Switch to light appearance' : 'Switch to dark appearance'} icon={dark ? 'sun' : 'moon'} variant="ghost" onClick={() => theme.setAppearance(dark ? 'light' : 'dark')} />;
}
