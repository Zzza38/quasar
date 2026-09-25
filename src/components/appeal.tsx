'use client';

import { useState } from 'react';
import { api, errorMessage } from '@/client/api';
import { CHAT } from '@/domain/chat';
import { Button, Callout, Field, Modal, Spacer, Textarea } from './primitives';

/**
 * An appeal against a messaging pause or a removal from a school (docs/CHAT.md §14). It goes to the owner's support
 * inbox; the owner answers by lifting the sanction. One open appeal per sanction.
 */
export function AppealModal({ accountId, kind, schoolId, what, onClose, onSent }: { accountId: string; kind: 'pause' | 'ban'; schoolId?: string; what: string; onClose: () => void; onSent: () => Promise<unknown> }) {
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const trimmed = message.trim();
  const send = async () => {
    setPending(true); setError('');
    try {
      await api.support.appeal.mutate({ accountId, kind, ...(schoolId ? { schoolId } : {}), message: trimmed });
      await onSent();
    } catch (err) { setError(errorMessage(err)); setPending(false); }
  };
  return <Modal open onClose={onClose} busy={pending} dirty={trimmed.length > 0} title={`Appeal ${what}`} description="Support reads every appeal. Say what happened from your side, or what has changed. You’ll see the result here once support decides."
    footer={<><Button variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button><Spacer /><Button variant="primary" busy={pending} disabled={trimmed.length < 10} onClick={() => void send()}>Send appeal</Button></>}>
    <Field label="Your appeal" htmlFor="appeal-message" hint="At least 10 characters."><Textarea id="appeal-message" autoFocus rows={5} minLength={10} maxLength={CHAT.appealMaxLength} value={message} onChange={(event) => setMessage(event.target.value)} disabled={pending} /></Field>
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
  </Modal>;
}
