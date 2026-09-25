'use client';

import { useRef, useState } from 'react';
import { api, errorMessage } from '@/client/api';
import { MemberAvatar } from './member-avatar';
import { Button, Hint } from './primitives';

/** The longest side of an uploaded picture, in pixels: plenty for a 96 px avatar on a 2× screen, tiny to store. */
const AVATAR_PIXELS = 256;

/**
 * Crops an image file to a square, scales it to AVATAR_PIXELS and encodes it as a JPEG, all in the browser, so the
 * server only ever stores a few kilobytes (docs/CHAT.md §13). Returns the base64 body without the data-URL prefix.
 */
export async function encodeAvatar(file: File): Promise<{ mime: 'image/jpeg'; data: string }> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error('Choose an image file, such as a photo or a PNG.');
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_PIXELS; canvas.height = AVATAR_PIXELS;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser could not prepare the picture.');
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_PIXELS, AVATAR_PIXELS);
    const url = canvas.toDataURL('image/jpeg', 0.85);
    const data = url.split(',')[1] ?? '';
    if (!data) throw new Error('This browser could not prepare the picture.');
    return { mime: 'image/jpeg', data };
  } finally { bitmap.close(); }
}

export function AvatarSettings({ accountId, user, online, onChanged }: { accountId: string; user: { displayName: string; avatar: string | null; avatarSource: 'upload' | 'google' | 'none'; hasGooglePicture: boolean }; online: boolean; onChanged: () => Promise<unknown> }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | 'google' | 'none' | null>(null);
  const [error, setError] = useState('');
  const run = async (which: 'upload' | 'google' | 'none', action: () => Promise<unknown>) => {
    setBusy(which); setError('');
    try { await action(); await onChanged(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(null); }
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    await run('upload', async () => { const picture = await encodeAvatar(file); await api.avatar.upload.mutate({ accountId, ...picture }); });
  };
  return <div className="grid gap-3">
    <div className="flex flex-wrap items-center gap-3">
      <MemberAvatar name={user.displayName} src={user.avatar} size="lg" />
      <div className="flex min-w-0 flex-1 flex-wrap gap-2">
        {/* The only raw input allowed (AGENTS.md): a hidden file picker a shadcn Button opens. */}
        <input ref={input} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void upload(file); }} />
        <Button size="sm" icon="imageUp" busy={busy === 'upload'} disabled={!online || busy !== null} onClick={() => input.current?.click()}>Upload photo</Button>
        {user.hasGooglePicture && user.avatarSource !== 'google' && <Button size="sm" variant="ghost" busy={busy === 'google'} disabled={!online || busy !== null} onClick={() => void run('google', () => api.avatar.clear.mutate({ accountId, source: 'google' }))}>Use Google photo</Button>}
        {user.avatarSource !== 'none' && <Button size="sm" variant="ghost" busy={busy === 'none'} disabled={!online || busy !== null} onClick={() => void run('none', () => api.avatar.clear.mutate({ accountId, source: 'none' }))}>Use my initial</Button>}
      </div>
    </div>
    <Hint>{user.avatarSource === 'upload' ? 'Schoolmates and friends see the photo you uploaded.' : user.avatarSource === 'google' ? 'Schoolmates and friends see your Google profile photo.' : 'Schoolmates and friends see your initial. Upload a photo or use your Google one.'}</Hint>
    {error && <Hint tone="danger" role="alert">{error}</Hint>}
  </div>;
}
