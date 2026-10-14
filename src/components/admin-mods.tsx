'use client';

import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/client/api';
import { publishModOverrides } from '@/client/mod-overrides';
import { DEFAULT_MOD_OVERRIDES, MODS, type ModId, type ModOverrideState } from '@/domain/mods';
import { Button, Callout, Field, Hint, Panel, Section, Select } from './primitives';

export function AdminMods({ accountId, userId, onAccessChange }: { accountId: string; userId: string; onAccessChange: () => Promise<void> }) {
  const [overrides, setOverrides] = useState(DEFAULT_MOD_OVERRIDES);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    api.admin.modOverrides.query({ userId }).then(next => { if (live) { setOverrides(next); setLoading(false); } })
      .catch(err => { if (live) setError(errorMessage(err)); });
    return () => { live = false; };
  }, [userId, retry]);
  const [saving, setSaving] = useState<ModId | null>(null);
  const [error, setError] = useState('');
  const save = async (mod: ModId, state: ModOverrideState) => {
    if (!accountId || saving) return;
    setSaving(mod); setError('');
    try {
      const next = await api.admin.setModOverride.mutate({ accountId, userId, mod, state });
      setOverrides(next);
      publishModOverrides(userId, next);
    } catch (err) {
      setError(errorMessage(err));
      await onAccessChange();
    } finally { setSaving(null); }
  };
  return <Section title="Mod overrides" id="mods-title" className="mt-4" description="Apply only to this account on every device. Changes reach their open pages within a few seconds and survive reloads. User choice restores their secret menu toggle.">
    {error && <Callout tone="danger" role="alert">{error}</Callout>}
    {error && loading && <Button onClick={() => { setError(''); setRetry(value => value + 1); }}>Retry loading mods</Button>}
    <div className="grid gap-3 sm:grid-cols-2">
      {MODS.map(mod => <Panel key={mod.id}>
        <Field label={mod.name}>
          <Select aria-label={`${mod.name} override`} value={overrides[mod.id]} disabled={loading || saving !== null}
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
