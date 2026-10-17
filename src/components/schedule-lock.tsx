'use client';

import { useEffect, useRef, useState } from 'react';
import type { PersonalSchedule } from '@/domain/schedule';
import { errorMessage } from '@/client/api';
import type { AppState } from './app-state';
import { Button, Callout, IconButton, Modal, Spacer } from './primitives';

/** Confirm before any personal schedule write, including drag-and-drop assignments. */
export function useScheduleLock(accountId: string | undefined, personal: PersonalSchedule, save: (next: PersonalSchedule) => Promise<void>) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const answer = useRef<((approved: boolean) => void) | null>(null);
  const finish = (approved: boolean) => {
    answer.current?.(approved);
    answer.current = null;
    setConfirming(false);
  };
  useEffect(() => () => {
    answer.current?.(false);
    answer.current = null;
  }, [accountId]);

  const savePersonal = async (next: PersonalSchedule) => {
    if (personal.scheduleLocked) {
      if (answer.current) throw new Error('Answer the unlock prompt before making another change.');
      const approved = await new Promise<boolean>((resolve) => {
        answer.current = resolve;
        setConfirming(true);
      });
      if (!approved) throw new Error('Your schedule is still locked.');
      await save({ ...next, scheduleLocked: false });
    } else {
      await save(next);
    }
  };

  const requestEdit = async (edit: () => void) => {
    if (!personal.scheduleLocked) { edit(); return; }
    try {
      await savePersonal({ ...personal, scheduleLocked: false });
      edit();
    } catch (err) {
      // Cancellation keeps the current view; a failed save must still be visible.
      if (errorMessage(err) !== 'Your schedule is still locked.') setError(errorMessage(err));
    }
  };

  const dialog = <><Modal open={confirming} onClose={() => finish(false)} title="Unlock schedule?"
    footer={<><Button variant="ghost" onClick={() => finish(false)}>Keep locked</Button><Spacer /><Button variant="primary" icon="unlock" onClick={() => finish(true)}>Unlock schedule</Button></>}>
    <p className="text-sm text-muted-foreground">Your schedule is locked to prevent accidental changes. Unlock it to continue editing.</p>
  </Modal>
    <Modal open={!!error} onClose={() => setError('')} title="Could not unlock schedule"
      footer={<Button onClick={() => setError('')}>Close</Button>}><Callout tone="danger" role="alert">{error}</Callout></Modal>
  </>;
  return { savePersonal, requestEdit, dialog };
}

export function ScheduleLockButton({ state }: { state: AppState }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const locked = !!state.personal.scheduleLocked;
  const toggle = async () => {
    setPending(true);
    setError('');
    try {
      if (locked && state.requestScheduleEdit) await state.requestScheduleEdit(() => {});
      else await state.savePersonal({ ...state.personal, scheduleLocked: !locked });
    }
    catch (err) { setError(errorMessage(err)); }
    finally { setPending(false); }
  };
  return <div className="grid justify-items-end gap-2">
    <IconButton size="sm" label={locked ? 'Unlock schedule' : 'Lock schedule'} icon={locked ? 'lock' : 'unlock'}
      aria-pressed={locked} variant={locked ? 'soft' : 'ghost'} disabled={pending || !state.personalValid} onClick={() => void toggle()} />
    {error && <Callout tone="danger" role="alert">{error}</Callout>}
  </div>;
}

export function editSchedule(state: AppState, edit: () => void) {
  if (state.requestScheduleEdit) void state.requestScheduleEdit(edit);
  else edit();
}
