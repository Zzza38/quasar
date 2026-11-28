'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { signIn } from 'next-auth/react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import { ADMIN_REAUTH_MESSAGE } from '@/lib/admin-session';
import type { AppState } from './app-state';
import { Button, Callout, Chip, EmptyState, Field, Input, Modal, Section, Select, Textarea } from './primitives';

type BoardPage = RouterOutput['announcements']['list'];
type Announcement = BoardPage['items'][number];
type Audience = { id: string; name: string };

function AnnouncementDetails({ item, heading }: { item: Announcement; heading?: boolean }) {
  return <div className="grid min-w-0 gap-2.5">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Chip icon={item.schoolId ? 'school' : 'bell'} tone={item.schoolId ? 'neutral' : 'accent'}>{item.schoolName ?? 'All Quasar'}</Chip>
      <time dateTime={item.createdAt} className="text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time>
    </div>
    {heading && <h3 className="wrap-anywhere text-lg font-bold">{item.title}</h3>}
    <p className="whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed">{item.body}</p>
    <p className="wrap-anywhere text-xs text-muted-foreground">Posted by {item.authorName}</p>
  </div>;
}

function AnnouncementError({ message }: { message: string }) {
  return <Callout tone="danger" role="alert" actions={message === ADMIN_REAUTH_MESSAGE &&
    <Button size="sm" onClick={() => void signIn('google', { callbackUrl: window.location.href }, { prompt: 'select_account', max_age: '0' })}>Sign in again with Google</Button>}>{message}</Callout>;
}

function ComposeAnnouncement({ state, owner, onClose, onPublished }: { state: AppState; owner: boolean; onClose: () => void; onPublished: (audience: string) => void }) {
  const school = state.context.school;
  const [audience, setAudience] = useState(school.id);
  const [schools, setSchools] = useState<Audience[]>([school]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const retry = useRef<{ input: string; id: string } | null>(null);
  useEffect(() => {
    if (!owner) return;
    let active = true;
    api.admin.schools.query().then(rows => { if (active) setSchools(rows); })
      .catch(err => { if (active) setError(errorMessage(err)); });
    return () => { active = false; };
  }, [owner]);
  const audienceName = audience === 'platform' ? 'All Quasar' : schools.find(s => s.id === audience)?.name ?? school.name;
  return <Modal open title="New announcement" onClose={onClose} busy={busy} dirty={!!(title || body)}>
    <form className="grid gap-4" onSubmit={async event => {
      event.preventDefault();
      if (busy || !state.online || !title.trim() || !body.trim()) return;
      const input = { accountId: state.context.user.id, schoolId: audience === 'platform' ? null : audience, title: title.trim(), body: body.trim() };
      const serialized = JSON.stringify(input);
      const requestId = retry.current?.input === serialized ? retry.current.id : crypto.randomUUID();
      retry.current = { input: serialized, id: requestId };
      setBusy(true); setError('');
      try {
        await api.announcements.publish.mutate({ ...input, requestId });
        onPublished(audienceName);
      } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
    }}>
      <Field label="Audience" htmlFor="announcement-audience">
        <Select id="announcement-audience" disabled={!owner || busy} value={audience} onChange={event => setAudience(event.target.value)}>
          {schools.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          {owner && <option value="platform">All Quasar</option>}
        </Select>
      </Field>
      <Field label="Title" htmlFor="announcement-title"><Input id="announcement-title" required maxLength={120} disabled={busy} value={title} onChange={event => setTitle(event.target.value)} /></Field>
      <Field label="Message" htmlFor="announcement-message"><Textarea id="announcement-message" required maxLength={4000} rows={5} disabled={busy} value={body} onChange={event => setBody(event.target.value)} /></Field>
      {audience === 'platform' && <Callout tone="warning">This announcement will appear on every school's board and as a popup across Quasar.</Callout>}
      {error && <AnnouncementError message={error} />}
      <div><Button type="submit" variant="primary" busy={busy} disabled={!state.online || !title.trim() || !body.trim()}>Publish announcement</Button></div>
    </form>
  </Modal>;
}

export function AnnouncementBoard({ state }: { state: AppState }) {
  const { user, school, staff, isAdmin } = state.context;
  const canPublish = isAdmin || (staff?.role === 'school-manager' && staff.schoolId === school.id);
  const [{ items, nextBefore: next }, setPage] = useState<BoardPage>({ items: [], nextBefore: null });
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [compose, setCompose] = useState(false);
  const [published, setPublished] = useState('');
  const generation = useRef(0);
  const lastCursor = useRef<number | undefined>(undefined);
  const pending = useRef(false);
  const load = useCallback(async (before?: number) => {
    const request = ++generation.current;
    lastCursor.current = before;
    pending.current = true;
    setBusy(true); setError('');
    try {
      const page = await api.announcements.list.query({ accountId: user.id, before });
      if (generation.current !== request) return;
      setPage(current => {
        if (before !== undefined) return { ...page, items: [...current.items, ...page.items] };
        // Preserve older pages if the refreshed page still overlaps the loaded history.
        const tail = page.items.at(-1);
        const overlap = tail ? current.items.findIndex(item => item.id === tail.id) : -1;
        if (overlap < 0) return page;
        return { items: [...page.items, ...current.items.slice(overlap + 1)], nextBefore: current.nextBefore };
      });
    } catch (err) { if (generation.current === request) setError(errorMessage(err)); }
    finally { if (generation.current === request) { pending.current = false; setBusy(false); } }
  }, [user.id]);
  useEffect(() => {
    if (!state.online) return;
    void load();
    const refresh = () => {
      if (!pending.current && document.visibilityState === 'visible') void load();
    };
    const timer = window.setInterval(refresh, 60000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      generation.current++;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load, state.online]);
  return <Section id="announcement-board" title="Announcements" icon="bell" description={`Updates for ${school.name} and everyone on Quasar.`}
    action={canPublish && <Button size="sm" variant="primary" disabled={!state.online} onClick={() => setCompose(true)}>New announcement</Button>}>
    {published && <Callout tone="success" role="status">Published to {published}.</Callout>}
    {!state.online ? <Callout>Connect to see the latest announcements.</Callout> : error ? <Callout tone="danger" role="alert" actions={<Button size="sm" onClick={() => void load(lastCursor.current)}>Retry</Button>}>{error}</Callout>
      : busy && items.length === 0 ? <p role="status" className="text-sm text-muted-foreground">Loading announcements…</p>
      : items.length === 0 && <EmptyState icon="bell" title="No announcements yet">New posts will appear here.</EmptyState>}
    {items.map(item => <article key={item.id} className="rounded-xl border bg-card p-4"><AnnouncementDetails item={item} heading /></article>)}
    {next !== null && <div><Button size="sm" busy={busy} disabled={!state.online} onClick={() => void load(next)}>Older announcements</Button></div>}
    {compose && canPublish && <ComposeAnnouncement state={state} owner={isAdmin} onClose={() => setCompose(false)} onPublished={name => { setCompose(false); setPublished(name); void load(); }} />}
  </Section>;
}

export function AnnouncementPopup({ accountId, openBoard }: { accountId: string; openBoard: () => void }) {
  const [item, setItem] = useState<Announcement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (item || busy) return;
    let active = true;
    let pending = false;
    const check = async () => {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      try {
        const unread = await api.announcements.unread.query({ accountId });
        if (active) setItem(unread);
      } catch { /* A connection or focus change retries delivery. */ }
      finally { pending = false; }
    };
    void check();
    const timer = window.setInterval(check, 60000);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); };
  }, [accountId, item, busy]);
  if (!item) return null;
  const dismiss = async (board = false) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await api.announcements.dismiss.mutate({ accountId, id: item.id });
      if (!mounted.current) return;
      setItem(null);
      if (board) openBoard();
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return <Modal open title={<span className="wrap-anywhere">{item.title}</span>} onClose={() => void dismiss()} busy={busy}
    footer={<><Button disabled={busy} onClick={() => void dismiss(true)}>Open board</Button><Button variant="primary" busy={busy} onClick={() => void dismiss()}>Dismiss</Button></>}>
    <AnnouncementDetails item={item} />
    {error && <AnnouncementError message={error} />}
  </Modal>;
}
