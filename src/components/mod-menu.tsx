'use client';

import { useEffect, useState } from 'react';
import { Button, Modal, Panel, Toggle } from './primitives';
import { setAttentionMode as setAttentionEnabled } from './attention-videos';
import { ShyParticles } from './shy-particles';
import { useModOverrides } from '@/client/mod-overrides';
import type { ModId } from '@/domain/mods';

const KONAMI_CODE = ['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a'];

export function ModMenu() {
  const [open, setOpen] = useState(false);
  const overrides = useModOverrides();
  const [choices, setChoices] = useState({ rgb: false, attention: false, backwards: false, shy: false });
  const effective = (mod: ModId) => overrides[mod] === 'default' ? choices[mod] : overrides[mod] === 'on';
  const choose = (mod: ModId, value: boolean) => {
    if (overrides[mod] === 'default') setChoices(previous => ({ ...previous, [mod]: value }));
  };
  const forced = (mod: ModId) => overrides[mod] === 'default' ? null : `Admin forced this mod ${overrides[mod]}.`;
  const rgbMode = effective('rgb'), attentionMode = effective('attention'), backwards = effective('backwards'), shy = effective('shy');

  useEffect(() => {
    if (rgbMode) document.documentElement.setAttribute('data-rgb-mode', 'true');
    else document.documentElement.removeAttribute('data-rgb-mode');
    return () => document.documentElement.removeAttribute('data-rgb-mode');
  }, [rgbMode]);

  useEffect(() => {
    setAttentionEnabled(attentionMode);
    return () => setAttentionEnabled(false);
  }, [attentionMode]);

  useEffect(() => {
    if (backwards) document.documentElement.setAttribute('data-backwards', 'true');
    else document.documentElement.removeAttribute('data-backwards');
    return () => document.documentElement.removeAttribute('data-backwards');
  }, [backwards]);

  useEffect(() => {
    let entered: string[] = [];
    const reset = () => { entered = []; };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const target = event.target;
      if (open || event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey ||
        (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [role="textbox"], [role="combobox"]')))) {
        reset();
        return;
      }

      const key = event.key.toLowerCase();
      if (entered.length > 0 && key === KONAMI_CODE[entered.length] && key.startsWith('arrow')) event.preventDefault();
      entered.push(key);
      // Keep the longest suffix that still starts the code, including overlapping Up presses.
      while (entered.length && !entered.every((value, index) => value === KONAMI_CODE[index])) entered.shift();
      if (entered.length === KONAMI_CODE.length) {
        reset();
        setOpen(true);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', reset);
    };
  }, [open]);

  return <>
    {rgbMode && <div className="rgb-mode-overlay" aria-hidden="true" />}

    {shy && <ShyParticles />}
    <Modal open={open} onClose={() => setOpen(false)} title="Mod menu" description="Secret code accepted. Choose a mod below."
    footer={<Button onClick={() => setOpen(false)}>Close menu</Button>}>
      <Panel>
        <Toggle label="RGB Mode" checked={rgbMode} onChange={value => choose('rgb', value)} disabled={overrides.rgb !== 'default'}
          description={forced('rgb') ?? 'Cycle neon colors across a dark screen. Toggle off to restore normal colors.'} />
      </Panel>
      <Panel>
        <Toggle label="What Is an Attention Span" checked={attentionMode} onChange={value => choose('attention', value)} disabled={overrides.attention !== 'default'}
          description={forced('attention') ?? 'Play muted Subway Surfers videos in the page layout when there is already room. Each starts at a random point and loops.'} />
      </Panel>
      <Panel>
        <Toggle label="Backwards" checked={backwards} onChange={value => choose('backwards', value)} disabled={overrides.backwards !== 'default'}
          description={forced('backwards') ?? 'Display all text backwards, including this menu.'} />
      </Panel>
      <Panel>
        <Toggle label={<span className="text-[9px]">I'm Shy</span>} checked={shy} onChange={value => choose('shy', value)} disabled={overrides.shy !== 'default'}
          description={forced('shy') ?? 'Every visible UI piece roams across the screen. The cursor pushes every piece, with quadratic falloff at a distance. Pieces push apart at close range and glide with friction.'} />
      </Panel>
    </Modal>
  </>;
}
