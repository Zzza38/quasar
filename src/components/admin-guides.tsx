'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, type RouterOutput, type School } from '@/client/api';
import { chatImage } from '@/client/chat-image';
import { DEFAULT_FEED_GUIDES, FEED_PLATFORM_NAMES, FEED_PLATFORMS, feedGuideSchema, GUIDE_LIMITS, guideImageUrl, type FeedGuide, type FeedPlatform } from '@/domain/feed-guides';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';
import { FeedGuide as FeedGuideView, GuideSteps } from './feed-guide';
import { Button, Callout, Chip, Eyebrow, Field, Hint, IconButton, Input, Modal, Panel, Section, Segmented, Spacer, Textarea, Toggle } from './primitives';

type AdminGuides = RouterOutput['admin']['feedGuides'];
type DraftStep = { key: string; text: string; image?: string };
type Draft = { name: string; note: string; steps: DraftStep[] };

let nextStepKey = 0;
const stepKey = () => `step-${nextStepKey++}`;
const toDraft = (guide: FeedGuide): Draft => ({ name: guide.name ?? '', note: guide.note, steps: guide.steps.map((step) => ({ key: stepKey(), ...step })) });
const fromDraft = (draft: Draft): FeedGuide => ({
  ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
  steps: draft.steps.map(({ text, image }) => ({ text: text.trim(), ...(image ? { image } : {}) })),
  note: draft.note.trim(),
});
const sameGuide = (a: FeedGuide | null, b: FeedGuide | null) => JSON.stringify(a) === JSON.stringify(b);
/** The first reason a draft can't be saved, checked with the server's schema. */
function draftProblem(draft: Draft): string {
  const parsed = feedGuideSchema.safeParse(fromDraft(draft));
  return parsed.success ? '' : parsed.error.issues[0]?.message ?? 'Check the steps.';
}

/**
 * Rewords one guide and adds screenshots, with the student's view beside it. Step text takes the chat markdown subset,
 * so `**Calendar**` comes out bold. Screenshots are resized on the device and re-encoded by the server.
 */
function GuideEditor({ platform, draft, onChange, accountId, disabled, idPrefix }: {
  platform: FeedPlatform; draft: Draft; onChange: (draft: Draft) => void; accountId: string; disabled?: boolean; idPrefix: string;
}) {
  const file = useRef<HTMLInputElement>(null);
  const target = useRef<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState('');
  // The latest draft, so an upload that finishes after more typing keeps that typing.
  const latest = useRef(draft);
  latest.current = draft;
  const setSteps = (steps: DraftStep[]) => onChange({ ...latest.current, steps });
  const updateStep = (key: string, patch: Partial<DraftStep>) => setSteps(latest.current.steps.map((step) => step.key === key ? { ...step, ...patch } : step));
  const move = (index: number, by: number) => {
    const steps = [...draft.steps];
    [steps[index], steps[index + by]] = [steps[index + by], steps[index]];
    setSteps(steps);
  };
  const upload = async (picked: File | undefined) => {
    const key = target.current;
    if (!picked || !key) return;
    setError(''); setUploading(key);
    try {
      const { id } = await api.admin.uploadGuideImage.mutate({ accountId, data: await chatImage(picked) });
      updateStep(key, { image: id });
    } catch (err) { setError(errorMessage(err)); }
    finally { setUploading(null); }
  };
  const busy = disabled || uploading !== null;
  return <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
    <div className="grid gap-3">
      <Field label="Tab name" htmlFor={`${idPrefix}-name`} hint={`Leave it empty to keep “${FEED_PLATFORM_NAMES[platform]}”.`}>
        <Input id={`${idPrefix}-name`} small maxLength={GUIDE_LIMITS.name} value={draft.name} disabled={disabled} placeholder={FEED_PLATFORM_NAMES[platform]} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
      </Field>
      <ol className="grid gap-2.5" aria-label="Steps">
        {draft.steps.map((step, index) => <li key={step.key} className="grid gap-2 rounded-xl bg-card p-3 ring-1 ring-foreground/[0.06]">
          <div className="flex items-center gap-1">
            <Label htmlFor={`${idPrefix}-${step.key}`} className="text-[13px] font-bold">Step {index + 1}</Label>
            <Spacer />
            <IconButton icon="arrowUp" size="sm" label={`Move step ${index + 1} up`} disabled={busy || index === 0} onClick={() => move(index, -1)} />
            <IconButton icon="arrowDown" size="sm" label={`Move step ${index + 1} down`} disabled={busy || index === draft.steps.length - 1} onClick={() => move(index, 1)} />
            <IconButton icon="trash" size="sm" label={`Remove step ${index + 1}`} disabled={busy || draft.steps.length === 1} onClick={() => setSteps(draft.steps.filter((entry) => entry.key !== step.key))} />
          </div>
          <Textarea id={`${idPrefix}-${step.key}`} rows={2} className="min-h-16" maxLength={GUIDE_LIMITS.text} value={step.text} disabled={disabled} onChange={(event) => updateStep(step.key, { text: event.target.value })} />
          {step.image
            ? <div className="flex flex-wrap items-end gap-2">
              <img src={guideImageUrl(step.image)} alt={`Screenshot for step ${index + 1}`} className="max-h-28 max-w-full rounded-lg object-contain ring-1 ring-foreground/[0.08]" />
              <Button size="sm" variant="ghost" icon="trash" disabled={busy} onClick={() => updateStep(step.key, { image: undefined })}>Remove screenshot</Button>
            </div>
            : <Button size="sm" icon="imageUp" className="justify-self-start" busy={uploading === step.key} disabled={busy} onClick={() => { target.current = step.key; file.current?.click(); }}>Add screenshot</Button>}
        </li>)}
      </ol>
      <Button size="sm" icon="plus" className="justify-self-start" disabled={busy || draft.steps.length >= GUIDE_LIMITS.steps}
        onClick={() => setSteps([...draft.steps, { key: stepKey(), text: '' }])}>Add step</Button>
      <Field label="Tip under the steps" htmlFor={`${idPrefix}-note`} hint="Optional. Good for the usual problem, like a class that never shows up.">
        <Textarea id={`${idPrefix}-note`} rows={2} className="min-h-16" maxLength={GUIDE_LIMITS.note} value={draft.note} disabled={disabled} onChange={(event) => onChange({ ...draft, note: event.target.value })} />
      </Field>
      <Hint>Write <code className="font-mono">**Calendar**</code> for bold, <code className="font-mono">_this_</code> for italic and <code className="font-mono">`.ics`</code> for code. Links that start with https:// can be clicked.</Hint>
      {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
      <input ref={file} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(event) => { const picked = event.target.files?.[0]; event.target.value = ''; void upload(picked); }} />
    </div>
    <Panel className="grid content-start gap-2 lg:sticky lg:top-20">
      <Eyebrow>What students see</Eyebrow>
      <strong className="text-sm font-bold">In {draft.name.trim() || FEED_PLATFORM_NAMES[platform]}</strong>
      <GuideSteps guide={fromDraft(draft)} compact />
    </Panel>
  </div>;
}

/** One platform's guide for every school: the built-in text until support saves its own. */
function PlatformGuideForm({ platform, saved, accountId, onSaved, onDirty, onAccessLost }: {
  platform: FeedPlatform; saved: FeedGuide | null; accountId: string; onSaved: () => Promise<void>; onDirty: (dirty: boolean) => void; onAccessLost: (error: unknown) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(() => toDraft(saved ?? DEFAULT_FEED_GUIDES[platform]));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const dirty = !sameGuide(fromDraft(draft), saved ?? DEFAULT_FEED_GUIDES[platform]);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const problem = draftProblem(draft);
  const save = async (guide: FeedGuide | null) => {
    setPending(true); setError('');
    try { await api.admin.saveFeedGuide.mutate({ accountId, schoolId: null, platform, guide }); onDirty(false); await onSaved(); }
    catch (err) { if (!(await onAccessLost(err))) setError(errorMessage(err)); }
    finally { setPending(false); }
  };
  return <div className="grid gap-4">
    <div className="flex flex-wrap items-center gap-2">
      {saved ? <Chip tone="accent" icon="edit">Your wording</Chip> : <Chip>Built-in wording</Chip>}
      <Hint>Every school on {FEED_PLATFORM_NAMES[platform]} sees this, unless it has its own steps (Schools → Setup).</Hint>
    </div>
    <GuideEditor platform={platform} draft={draft} onChange={setDraft} accountId={accountId} disabled={pending} idPrefix={`guide-${platform}`} />
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    <div className="flex flex-wrap items-center gap-2">
      {saved && <Button variant="ghost" disabled={pending} onClick={() => { if (window.confirm(`Go back to the built-in ${FEED_PLATFORM_NAMES[platform]} steps? Your wording and screenshots for it are removed.`)) void save(null); }}>Use built-in wording</Button>}
      <Spacer />
      {problem && dirty && <Hint tone="danger">{problem}</Hint>}
      <Button variant="ghost" disabled={pending || !dirty} onClick={() => setDraft(toDraft(saved ?? DEFAULT_FEED_GUIDES[platform]))}>Discard changes</Button>
      <Button variant="primary" busy={pending} disabled={!dirty || !!problem} onClick={() => void save(fromDraft(draft))}>Save for all schools</Button>
    </div>
  </div>;
}

/** /admin → Setup guide: the calendar-link steps each platform shows, for every school. */
export function GuideAdmin({ accountId, onAccessLost }: { accountId: string | null; onAccessLost: (error: unknown) => Promise<boolean> }) {
  const [view, setView] = useState<AdminGuides | null>(null);
  const [platform, setPlatform] = useState<FeedPlatform>('schoology');
  const [error, setError] = useState('');
  const [loads, setLoads] = useState(0);
  const dirty = useRef(false);
  const onDirty = useCallback((value: boolean) => { dirty.current = value; }, []);
  const load = useCallback(async () => {
    try { setView(await api.admin.feedGuides.query({ schoolId: null })); setLoads((count) => count + 1); setError(''); }
    catch (err) { if (!(await onAccessLost(err))) setError(errorMessage(err)); }
  }, [onAccessLost]);
  useEffect(() => { void load(); }, [load]);
  return <Section id="guides-title" title="Setup guide" icon="calendar"
    description="The steps students follow to copy their homework calendar link, during setup and on the Schedule page. Pick which platforms a school uses, or give one school its own steps, from Schools → Setup.">
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    <Segmented<FeedPlatform> label="Platform" value={platform} options={FEED_PLATFORMS.map((entry) => ({ value: entry, label: FEED_PLATFORM_NAMES[entry] }))}
      onChange={(next) => { if (!dirty.current || window.confirm(`Discard your unsaved changes to the ${FEED_PLATFORM_NAMES[platform]} steps?`)) { dirty.current = false; setPlatform(next); } }} />
    {view && accountId && <PlatformGuideForm key={`${platform}:${loads}`} platform={platform} saved={view.global[platform]} accountId={accountId} onSaved={load} onDirty={onDirty} onAccessLost={onAccessLost} />}
  </Section>;
}

/**
 * Schools → Setup: which platforms the school uses, so students only see those steps, and any steps of the school's
 * own. A platform left unticked keeps its school steps for when it is ticked again.
 */
export function SchoolGuideSheet({ school, accountId, onClose, onSaved }: { school: School; accountId: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const [view, setView] = useState<AdminGuides | null>(null);
  const [platforms, setPlatforms] = useState<FeedPlatform[]>([]);
  const [custom, setCustom] = useState<Partial<Record<FeedPlatform, Draft>>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const load = useCallback(async () => {
    try {
      const next = await api.admin.feedGuides.query({ schoolId: school.id });
      setView(next); setPlatforms(next.platforms);
      setCustom(Object.fromEntries(FEED_PLATFORMS.flatMap((platform) => next.school?.[platform] ? [[platform, toDraft(next.school[platform])]] : [])));
      setError('');
    } catch (err) { setError(errorMessage(err)); }
  }, [school.id]);
  useEffect(() => { void load(); }, [load]);
  const shared = (platform: FeedPlatform) => view?.global[platform] ?? DEFAULT_FEED_GUIDES[platform];
  const wanted = (platform: FeedPlatform) => custom[platform] ? fromDraft(custom[platform]) : null;
  const changedGuides = view ? FEED_PLATFORMS.filter((platform) => !sameGuide(wanted(platform), view.school?.[platform] ?? null)) : [];
  const platformsChanged = !!view && platforms.join(',') !== view.platforms.join(',');
  const dirty = platformsChanged || changedGuides.length > 0;
  const problem = FEED_PLATFORMS.flatMap((platform) => {
    const issue = custom[platform] ? draftProblem(custom[platform]) : '';
    return issue ? [`${FEED_PLATFORM_NAMES[platform]}: ${issue}`] : [];
  })[0] ?? '';
  const save = async () => {
    setPending(true); setError(''); setSaved(false);
    try {
      if (platformsChanged) await api.admin.setFeedPlatforms.mutate({ accountId, schoolId: school.id, platforms });
      for (const platform of changedGuides) await api.admin.saveFeedGuide.mutate({ accountId, schoolId: school.id, platform, guide: wanted(platform) });
      await load(); setSaved(true); await onSaved();
    } catch (err) { setError(errorMessage(err)); await load(); }
    finally { setPending(false); }
  };
  const preview = { platforms, guides: Object.fromEntries(FEED_PLATFORMS.map((platform) => [platform, wanted(platform) ?? shared(platform)])) as Record<FeedPlatform, FeedGuide> };
  return <Modal open onClose={onClose} dirty={dirty} busy={pending} wide title={`Setup guide for ${school.name}`}
    description="Students at this school only see the steps for the platforms ticked here. With none ticked, they see every platform."
    footer={<><Button variant="ghost" onClick={onClose} disabled={pending}>Done</Button><Spacer />
      {saved && !dirty && <span className="text-sm font-semibold text-success" role="status">Saved</span>}
      {problem && <Hint tone="danger">{problem}</Hint>}
      <Button variant="primary" busy={pending} disabled={!view || !dirty || !!problem} onClick={() => void save()}>Save</Button></>}>
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    {!view && !error && <Hint>Loading…</Hint>}
    {view && <div className="grid gap-4">
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-bold">Where this school puts homework</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">{FEED_PLATFORMS.map((platform) => <div key={platform} className="flex items-center gap-2">
          <Checkbox id={`school-platform-${platform}`} checked={platforms.includes(platform)} disabled={pending}
            onCheckedChange={(checked) => setPlatforms((current) => FEED_PLATFORMS.filter((entry) => entry === platform ? checked === true : current.includes(entry)))} />
          <Label htmlFor={`school-platform-${platform}`} className="font-medium">{FEED_PLATFORM_NAMES[platform]}</Label>
        </div>)}</div>
      </fieldset>
      {platforms.map((platform) => <Panel key={platform} className="grid gap-3">
        <Toggle label={`Different ${FEED_PLATFORM_NAMES[platform]} steps for this school`} checked={!!custom[platform]} disabled={pending}
          description={custom[platform] ? 'Only this school sees these steps.' : `Shows the ${FEED_PLATFORM_NAMES[platform]} steps every school gets. Edit those in the Setup guide tab.`}
          onChange={(on) => setCustom((current) => { const next = { ...current }; if (on) next[platform] = toDraft(shared(platform)); else delete next[platform]; return next; })} />
        {custom[platform] && <GuideEditor platform={platform} draft={custom[platform]} accountId={accountId} disabled={pending} idPrefix={`school-guide-${platform}`}
          onChange={(draft) => setCustom((current) => ({ ...current, [platform]: draft }))} />}
      </Panel>)}
      <Panel className="grid gap-2">
        <Eyebrow>What students at {school.name} see</Eyebrow>
        <FeedGuideView key={platforms.join(',')} guides={preview} compact />
      </Panel>
    </div>}
  </Modal>;
}
