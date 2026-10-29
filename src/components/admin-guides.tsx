'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, type RouterOutput, type School } from '@/client/api';
import { chatImage } from '@/client/chat-image';
import { GUIDE_KINDS, GUIDE_LIMITS, GUIDES, guideImageUrl, guideKeys, guideName, setupGuideSchema, type GuideKind, type SetupGuide } from '@/domain/setup-guides';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';
import { GuideSteps, PlatformGuide } from './setup-guide';
import { Button, Callout, Chip, Eyebrow, Field, Hint, IconButton, Input, Modal, Panel, Section, Segmented, Spacer, Textarea, Toggle } from './primitives';

type AdminGuides = RouterOutput['admin']['guides'];
type DraftStep = { key: string; text: string; image?: string };
type Draft = { name: string; note: string; steps: DraftStep[] };

let nextStepKey = 0;
const stepKey = () => `step-${nextStepKey++}`;
const toDraft = (guide: SetupGuide): Draft => ({ name: guide.name ?? '', note: guide.note, steps: guide.steps.map((step) => ({ key: stepKey(), ...step })) });
const fromDraft = (draft: Draft): SetupGuide => ({
  ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
  steps: draft.steps.map(({ text, image }) => ({ text: text.trim(), ...(image ? { image } : {}) })),
  note: draft.note.trim(),
});
const sameGuide = (a: SetupGuide | null, b: SetupGuide | null) => JSON.stringify(a) === JSON.stringify(b);
/** The first reason a draft can't be saved, checked with the server's schema. */
function draftProblem(draft: Draft): string {
  const parsed = setupGuideSchema.safeParse(fromDraft(draft));
  return parsed.success ? '' : parsed.error.issues[0]?.message ?? 'Check the steps.';
}
/** The platform a guide is shown with: itself, or for an extra such as the Veracross sync steps, its platform. */
const platformOf = (kind: GuideKind, key: string) => GUIDES[kind].extras[key] ?? key;
const isExtra = (kind: GuideKind, key: string) => key in GUIDES[kind].extras;
const defaultGuide = (kind: GuideKind, key: string) => GUIDES[kind].defaults[key];
const LEGENDS: Record<GuideKind, string> = { calendar: 'Where this school puts homework', schedule: 'Where students find their class schedule' };

/**
 * Rewords one guide and adds screenshots, with the student's view beside it. Step text takes the chat markdown subset,
 * so `**Calendar**` comes out bold. Screenshots are resized on the device and re-encoded by the server.
 */
function GuideEditor({ kind, platform, draft, onChange, accountId, disabled, idPrefix }: {
  kind: GuideKind; platform: string; draft: Draft; onChange: (draft: Draft) => void; accountId: string; disabled?: boolean; idPrefix: string;
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
  const name = GUIDES[kind].names[platform];
  // An extra has no tab of its own, so it has no tab name.
  const extra = isExtra(kind, platform);
  return <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
    <div className="grid gap-3">
      {!extra && <Field label="Tab name" htmlFor={`${idPrefix}-name`} hint={`Leave it empty to keep “${name}”.`}>
        <Input id={`${idPrefix}-name`} small maxLength={GUIDE_LIMITS.name} value={draft.name} disabled={disabled} placeholder={name} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
      </Field>}
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
      <strong className="text-sm font-bold">{extra ? 'Where to find the link' : `In ${draft.name.trim() || name}`}</strong>
      <GuideSteps guide={fromDraft(draft)} compact />
    </Panel>
  </div>;
}

/** One guide for every school: the built-in text until support saves its own. */
function PlatformGuideForm({ kind, platform, saved, accountId, onSaved, onDirty, onAccessLost }: {
  kind: GuideKind; platform: string; saved: SetupGuide | null; accountId: string; onSaved: () => Promise<void>; onDirty: (dirty: boolean) => void; onAccessLost: (error: unknown) => Promise<boolean>;
}) {
  const shared = saved ?? defaultGuide(kind, platform);
  const [draft, setDraft] = useState(() => toDraft(shared));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const dirty = !sameGuide(fromDraft(draft), shared);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const problem = draftProblem(draft);
  const name = GUIDES[kind].names[platform];
  const save = async (guide: SetupGuide | null) => {
    setPending(true); setError('');
    try { await api.admin.saveGuide.mutate({ accountId, kind, schoolId: null, platform, guide }); onDirty(false); await onSaved(); }
    catch (err) { if (!(await onAccessLost(err))) setError(errorMessage(err)); }
    finally { setPending(false); }
  };
  return <div className="grid gap-4">
    <div className="flex flex-wrap items-center gap-2">
      {saved ? <Chip tone="accent" icon="edit">Your wording</Chip> : <Chip>Built-in wording</Chip>}
      <Hint>{platform === 'veracross-sync' ? 'Students follow these steps in Connect Veracross, to get the link that keeps their classes in sync.' : ''} Every school on {GUIDES[kind].names[platformOf(kind, platform)]} sees this, unless it has its own steps (Schools → Setup).</Hint>
    </div>
    <GuideEditor kind={kind} platform={platform} draft={draft} onChange={setDraft} accountId={accountId} disabled={pending} idPrefix={`guide-${kind}-${platform}`} />
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    <div className="flex flex-wrap items-center gap-2">
      {saved && <Button variant="ghost" disabled={pending} onClick={() => { if (window.confirm(`Go back to the built-in ${name} steps? Your wording and screenshots for it are removed.`)) void save(null); }}>Use built-in wording</Button>}
      <Spacer />
      {problem && dirty && <Hint tone="danger">{problem}</Hint>}
      <Button variant="ghost" disabled={pending || !dirty} onClick={() => setDraft(toDraft(shared))}>Discard changes</Button>
      <Button variant="primary" busy={pending} disabled={!dirty || !!problem} onClick={() => void save(fromDraft(draft))}>Save for all schools</Button>
    </div>
  </div>;
}

/** /admin → Setup guides: the steps each platform shows, for every school, for both kinds of guide. */
export function GuideAdmin({ accountId, onAccessLost }: { accountId: string | null; onAccessLost: (error: unknown) => Promise<boolean> }) {
  const [view, setView] = useState<AdminGuides | null>(null);
  const [kind, setKind] = useState<GuideKind>('calendar');
  const [platform, setPlatform] = useState(GUIDES.calendar.platforms[0]);
  const [error, setError] = useState('');
  const [loads, setLoads] = useState(0);
  const dirty = useRef(false);
  const onDirty = useCallback((value: boolean) => { dirty.current = value; }, []);
  const load = useCallback(async () => {
    try { setView(await api.admin.guides.query({ schoolId: null })); setLoads((count) => count + 1); setError(''); }
    catch (err) { if (!(await onAccessLost(err))) setError(errorMessage(err)); }
  }, [onAccessLost]);
  useEffect(() => { void load(); }, [load]);
  const leave = () => {
    if (dirty.current && !window.confirm(`Discard your unsaved changes to the ${GUIDES[kind].names[platform]} steps?`)) return false;
    dirty.current = false;
    return true;
  };
  return <Section id="guides-title" title="Setup guides" icon="calendar"
    description="The steps students follow during setup to copy their homework calendar link and to get their class schedule. Pick which platforms a school uses, or give one school its own steps, from Schools → Setup.">
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    <Segmented<GuideKind> label="Guide" value={kind} options={GUIDE_KINDS.map((entry) => ({ value: entry, label: GUIDES[entry].label }))}
      onChange={(next) => { if (leave()) { setKind(next); setPlatform(GUIDES[next].platforms[0]); } }} />
    <Segmented<string> label="Platform" size="sm" value={platform} options={guideKeys(kind).map((entry) => ({ value: entry, label: GUIDES[kind].names[entry] }))}
      onChange={(next) => { if (leave()) setPlatform(next); }} />
    {view && accountId && <PlatformGuideForm key={`${kind}:${platform}:${loads}`} kind={kind} platform={platform} saved={view[kind].global[platform]} accountId={accountId} onSaved={load} onDirty={onDirty} onAccessLost={onAccessLost} />}
  </Section>;
}

type KindDraft = { platforms: string[]; custom: Record<string, Draft> };

/**
 * Schools → Setup: for each kind of guide, which platforms the school uses, so students only see those steps, and
 * any steps of the school's own. A platform left unticked keeps its school steps for when it is ticked again.
 */
export function SchoolGuideSheet({ school, accountId, onClose, onSaved }: { school: School; accountId: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const [view, setView] = useState<AdminGuides | null>(null);
  const [drafts, setDrafts] = useState<Record<GuideKind, KindDraft> | null>(null);
  const [kind, setKind] = useState<GuideKind>('calendar');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const load = useCallback(async () => {
    try {
      const next = await api.admin.guides.query({ schoolId: school.id });
      setView(next);
      setDrafts(Object.fromEntries(GUIDE_KINDS.map((entry) => [entry, {
        platforms: next[entry].platforms,
        custom: Object.fromEntries(guideKeys(entry).flatMap((key) => { const own = next[entry].school?.[key]; return own ? [[key, toDraft(own)]] : []; })),
      }])) as Record<GuideKind, KindDraft>);
      setError('');
    } catch (err) { setError(errorMessage(err)); }
  }, [school.id]);
  useEffect(() => { void load(); }, [load]);
  const shared = (of: GuideKind, key: string) => view?.[of].global[key] ?? defaultGuide(of, key);
  const wanted = (of: GuideKind, key: string) => { const draft = drafts?.[of].custom[key]; return draft ? fromDraft(draft) : null; };
  const changes = view && drafts ? GUIDE_KINDS.map((entry) => ({
    kind: entry,
    platforms: drafts[entry].platforms.join(',') !== view[entry].platforms.join(','),
    guides: guideKeys(entry).filter((key) => !sameGuide(wanted(entry, key), view[entry].school?.[key] ?? null)),
  })) : [];
  const dirty = changes.some((change) => change.platforms || change.guides.length > 0);
  const problem = GUIDE_KINDS.flatMap((entry) => Object.entries(drafts?.[entry].custom ?? {}).flatMap(([key, draft]) => {
    const issue = draftProblem(draft);
    return issue ? [`${GUIDES[entry].label}, ${GUIDES[entry].names[key]}: ${issue}`] : [];
  }))[0] ?? '';
  const save = async () => {
    if (!drafts) return;
    setPending(true); setError(''); setSaved(false);
    try {
      for (const change of changes) {
        if (change.platforms) await api.admin.setGuidePlatforms.mutate({ accountId, kind: change.kind, schoolId: school.id, platforms: drafts[change.kind].platforms });
        for (const platform of change.guides) await api.admin.saveGuide.mutate({ accountId, kind: change.kind, schoolId: school.id, platform, guide: wanted(change.kind, platform) });
      }
      await load(); setSaved(true); await onSaved();
    } catch (err) { setError(errorMessage(err)); await load(); }
    finally { setPending(false); }
  };
  const update = (change: (draft: KindDraft) => KindDraft) => setDrafts((current) => current && { ...current, [kind]: change(current[kind]) });
  const current = drafts?.[kind];
  const names = GUIDES[kind].names;
  // The guides this kind shows for the ticked platforms, each platform followed by its extras.
  const editable = current ? guideKeys(kind).filter((key) => current.platforms.includes(platformOf(kind, key))) : [];
  const preview = current && { platforms: current.platforms, guides: Object.fromEntries(guideKeys(kind).map((key) => [key, wanted(kind, key) ?? shared(kind, key)])) };
  return <Modal open onClose={onClose} dirty={dirty} busy={pending} wide title={`Setup guides for ${school.name}`}
    description="Students at this school only see the steps for the platforms ticked here. With none ticked, they see every platform."
    footer={<><Button variant="ghost" onClick={onClose} disabled={pending}>Done</Button><Spacer />
      {saved && !dirty && <span className="text-sm font-semibold text-success" role="status">Saved</span>}
      {problem && <Hint tone="danger">{problem}</Hint>}
      <Button variant="primary" busy={pending} disabled={!view || !dirty || !!problem} onClick={() => void save()}>Save</Button></>}>
    {error && <Callout tone="danger" icon="alert" role="alert">{error}</Callout>}
    {!view && !error && <Hint>Loading…</Hint>}
    {view && current && preview && <div className="grid gap-4">
      <Segmented<GuideKind> label="Guide" value={kind} options={GUIDE_KINDS.map((entry) => ({ value: entry, label: GUIDES[entry].label }))} onChange={setKind} />
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-bold">{LEGENDS[kind]}</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">{GUIDES[kind].platforms.map((platform) => <div key={platform} className="flex items-center gap-2">
          <Checkbox id={`school-${kind}-platform-${platform}`} checked={current.platforms.includes(platform)} disabled={pending}
            onCheckedChange={(checked) => update((draft) => ({ ...draft, platforms: GUIDES[kind].platforms.filter((entry) => entry === platform ? checked === true : draft.platforms.includes(entry)) }))} />
          <Label htmlFor={`school-${kind}-platform-${platform}`} className="font-medium">{names[platform]}</Label>
        </div>)}</div>
      </fieldset>
      {editable.map((key) => <Panel key={key} className="grid gap-3">
        <Toggle label={`Different ${names[key]} steps for this school`} checked={!!current.custom[key]} disabled={pending}
          description={current.custom[key] ? 'Only this school sees these steps.' : `Shows the ${names[key]} steps every school gets. Edit those in the Setup guides tab.`}
          onChange={(on) => update((draft) => { const custom = { ...draft.custom }; if (on) custom[key] = toDraft(shared(kind, key)); else delete custom[key]; return { ...draft, custom }; })} />
        {current.custom[key] && <GuideEditor kind={kind} platform={key} draft={current.custom[key]} accountId={accountId} disabled={pending} idPrefix={`school-guide-${kind}-${key}`}
          onChange={(next) => update((draft) => ({ ...draft, custom: { ...draft.custom, [key]: next } }))} />}
      </Panel>)}
      <Panel className="grid gap-2">
        <Eyebrow>What students at {school.name} see</Eyebrow>
        <PlatformGuide key={`${kind}:${current.platforms.join(',')}`} kind={kind} guides={preview} label={LEGENDS[kind]} compact
          extra={(platform) => Object.entries(GUIDES[kind].extras).filter(([, parent]) => parent === platform).map(([key]) => <div key={key} className="grid gap-2 rounded-xl bg-muted/60 p-3 ring-1 ring-inset ring-foreground/[0.04]">
            <strong className="text-[13px] font-bold">{guideName(kind, key, undefined)}</strong>
            <GuideSteps guide={preview.guides[key]} compact />
          </div>)} />
      </Panel>
    </div>}
  </Modal>;
}
