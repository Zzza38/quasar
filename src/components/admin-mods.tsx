'use client';

import { useState } from 'react';
import { api, errorMessage } from '@/client/api';
import { publishModOverrides, useModOverrides } from '@/client/mod-overrides';
import { MODS, type ModId, type ModOverrideState } from '@/domain/mods';
import { Callout, Field, Hint, Panel, Section, Select } from './primitives';

export function AdminMods({ accountId, onAccessChange }: { accountId: string | null; onAccessChange: () => Promise<void> }) {
  const overrides = useModOverrides();
  const [saving, setSaving] = useState<ModId | null>(null);
  const [error, setError] = useState('');
  const save = async (mod: ModId, state: ModOverrideState) => {
    if (!accountId || saving) return;
    setSaving(mod); setError('');
    try {
      publishModOverrides(await api.admin.setModOverride.mutate({ accountId, mod, state }));
    } catch (err) {
      setError(errorMessage(err));
      await onAccessChange();
    } finally { setSaving(null); }
  };
  return <Section title="Mod overrides" id="mods-title" description="Apply to everyone, including signed-out visitors. Changes reach open pages within a few seconds and survive reloads. User choice restores the secret menu toggle.">
    {error && <Callout tone="danger" role="alert">{error}</Callout>}
    <div className="grid gap-3 sm:grid-cols-2">
      {MODS.map(mod => <Panel key={mod.id}>
        <Field label={mod.name}>
          <Select aria-label={`${mod.name} override`} value={overrides[mod.id]} disabled={!accountId || saving !== null}
            onChange={event => void save(mod.id, event.target.value as ModOverrideState)}>
            <option value="default">User choice</option>
            <option value="on">Force on</option>
            <option value="off">Force off</option>
          </Select>
        </Field>
        <Hint>{saving === mod.id ? 'Saving...' : mod.description}</Hint>
      </Panel>)}
    </div>
  </Section>;
}
