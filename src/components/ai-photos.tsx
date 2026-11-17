'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import { Button, Hint, IconButton } from './primitives';
import { isPdf, readPdf, MAX_PDF_TEXT } from './pdf-pages';
import { photoError, prepareImage } from './scan-schedule';

/**
 * The photo picker the Plus AI features share (Photo to tasks, study sets): up to three photos or PDF pages, downsized
 * in the browser like the timetable scan's, with the PDFs' own text kept alongside. Photos go to the AI for one
 * request and are not stored.
 */
export const MAX_AI_PHOTOS = 3;
type Picture = { image: string; mediaType: 'image/jpeg'; preview: string; pdf?: { id: string; name: string } };
export type AiStatus = RouterOutput['ai']['status'];

/** The member's AI status (ai.status), for the quota line and the Plus tag. */
export function useAiStatus(enabled: boolean) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const reload = useCallback(() => api.ai.status.query().then(setStatus, () => setStatus(null)), []);
  useEffect(() => { if (enabled) void reload(); }, [enabled, reload]);
  return { status, reload };
}

/** A Plus feature's "Plus" tag: only when billing is set up and the member isn't on Plus (they still get the free taste). */
export function PlusTag({ status }: { status: AiStatus | null }) {
  if (!status?.beta || status.plusUnlocked) return null;
  return <span className="ml-0.5 rounded-full bg-primary-soft px-1.5 py-px text-[10.5px] font-bold uppercase tracking-wide text-primary-soft-foreground">Plus</span>;
}

/** "2 of 3 free photo imports left today", or where the request runs when it's the member's own key. */
export function quotaLine(status: AiStatus | null, kind: 'photo' | 'study', name: string): string {
  if (!status?.beta) return '';
  if (status.own) return `Runs on your ${status.own.providerName} ${status.own.via === 'openrouter' ? 'account' : 'key'}.`;
  if (!status.server) return '';
  const quota = status.quota[kind];
  return `${Math.max(0, quota.limit - quota.used)} of ${quota.limit} ${status.plan === 'plus' ? 'Plus' : 'free'} ${name} left today.`;
}

export function useAiPhotos(label: string) {
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [photos, setPhotos] = useState<Picture[]>([]);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [limited, setLimited] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const reset = useCallback(() => { setPhotos([]); setTexts({}); setLimited(false); setError(''); }, []);
  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    setLimited(false); setError(''); setPreparing(true);
    void (async () => {
      const prepared: Picture[] = [];
      const read: Record<string, string> = {};
      const failed: { name: string; message: string }[] = [];
      let room = MAX_AI_PHOTOS - photos.length, skipped = false;
      for (const file of files) {
        if (room <= 0) { skipped = true; break; }
        try {
          if (isPdf(file)) {
            const pdf = await readPdf(file, room);
            if (pdf.pages.length === 0) throw new Error('That PDF has no pages.');
            const source = { id: crypto.randomUUID(), name: file.name };
            prepared.push(...pdf.pages.map(page => ({ ...page, pdf: source })));
            if (pdf.text) read[source.id] = pdf.text;
            if (pdf.total > pdf.pages.length) skipped = true;
            room -= pdf.pages.length;
          } else { prepared.push(await prepareImage(file)); room -= 1; }
        } catch (err) { failed.push({ name: file.name, message: errorMessage(err) }); }
      }
      setLimited(skipped);
      if (prepared.length) { setPhotos(current => [...current, ...prepared].slice(0, MAX_AI_PHOTOS)); setTexts(current => ({ ...current, ...read })); }
      if (failed.length) setError(photoError(files.length, failed, prepared.length));
      setPreparing(false);
    })();
  };
  const remove = (index: number) => {
    const removed = photos[index];
    const next = photos.filter((_, i) => i !== index);
    setPhotos(next);
    if (removed?.pdf && !next.some(photo => photo.pdf?.id === removed.pdf!.id)) setTexts(({ [removed.pdf!.id]: _gone, ...rest }) => rest);
    setLimited(false); setError('');
  };
  const pdfText = Object.values(texts).join('\n\n').slice(0, MAX_PDF_TEXT);
  /** The two hidden inputs the picker's buttons open (the one raw input AGENTS.md allows). */
  const inputs = <>
    <input ref={fileRef} type="file" accept="application/pdf,.pdf,image/*" className="sr-only" tabIndex={-1} aria-hidden="true" multiple aria-label={`Choose ${label}`} onChange={choose} />
    <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" aria-label={`Take a photo of ${label}`} onChange={choose} />
  </>;
  return {
    photos, pdfText, preparing, error, limited, reset, remove, inputs,
    images: photos.map(({ image, mediaType }) => ({ image, mediaType })),
    pickFile: () => fileRef.current?.click(),
    takePhoto: () => cameraRef.current?.click(),
  };
}

/** Thumbnails with remove buttons, the add buttons while there is room, and the not-stored note. */
export function AiPhotoStrip({ picker, disabled, what }: { picker: ReturnType<typeof useAiPhotos>; disabled?: boolean; what: string }) {
  const { photos } = picker;
  return <div className="grid gap-2">
    {photos.length > 0 && <ul className="grid grid-cols-3 gap-2" aria-label="Pictures to read">
      {photos.map((photo, index) => <li key={index} className="relative">
        <img src={photo.preview} alt={photo.pdf ? `Page ${photos.slice(0, index + 1).filter(entry => entry.pdf?.id === photo.pdf!.id).length} of ${photo.pdf.name}` : `Photo ${index + 1}`}
          className="aspect-[3/4] w-full rounded-xl bg-muted object-cover ring-1 ring-foreground/[0.06]" />
        <IconButton label={`Remove ${photo.pdf ? 'page' : 'photo'} ${index + 1}`} icon="x" size="sm" variant="secondary" disabled={disabled} className="absolute right-1.5 top-1.5 rounded-full" onClick={() => picker.remove(index)} />
      </li>)}
    </ul>}
    {photos.length < MAX_AI_PHOTOS && <div className="flex flex-wrap gap-2">
      <Button size="sm" icon="camera" disabled={disabled || picker.preparing} onClick={picker.takePhoto}>Take a photo</Button>
      <Button size="sm" icon="imageUp" busy={picker.preparing} disabled={disabled} onClick={picker.pickFile}>{photos.length ? 'Add another' : 'Choose photos or a PDF'}</Button>
    </div>}
    {picker.limited && <Hint>Up to three photos or pages are read. Keep the ones with {what}.</Hint>}
    {picker.error && <Hint tone="danger" role="alert">{picker.error}</Hint>}
  </div>;
}
