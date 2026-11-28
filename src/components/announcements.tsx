'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { TRPCClientError } from '@trpc/client';
import { signIn } from 'next-auth/react';
import { api, errorMessage, type RouterOutput } from '@/client/api';
import { announcementTime } from '@/domain/announcement-time';
import { browserTimeZone } from '@/lib/format';
import { ADMIN_REAUTH_MESSAGE } from '@/lib/admin-session';
import type { AppState } from './app-state';
import { Button, Callout, Chip, EmptyState, Field, Input, Modal, Section, Segmented, Select, Textarea } from './primitives';

type BoardPage = RouterOutput['announcements']['list'];
type Announcement = BoardPage['items'][number];
type Audience = { id: string; name: string };

function AnnouncementDetails({ item, heading }: { item: Announcement; heading?: boolean }) {
  return <div className="grid min-w-0 gap-2.5">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Chip icon={item.schoolId ? 'school' : 'bell'} tone={item.schoolId ? 'neutral' : 'accent'}>{item.schoolName ?? 'All Quasar'}</Chip>
      <time dateTime={item.publishAt} className="text-xs text-muted-foreground">{new Date(item.publishAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time>
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

function ComposeAnnouncement({ state, owner, onClose, onPublished }: { state: AppState; owner: boolean; onClose: () => void; onPublished: (message: string) => void }) {
  const school = state.context.school;
  const [audience, setAudience] = useState(school.id);
  const [schools, setSchools] = useState<Audience[]>([school]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [timing, setTiming] = useState<'now' | 'later'>('now');
  const [localTime, setLocalTime] = useState('');
  const zone = browserTimeZone();
  const scheduled = timing === 'later';
  const release = announcementTime(localTime, zone, state.now.getTime());
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
  return <Modal open title="New announcement" onClose={onClose} busy={busy} dirty={!!(title || body || (scheduled && localTime))}>
    <form className="grid gap-4" onSubmit={async event => {
      event.preventDefault();
      if (busy || !state.online || !title.trim() || !body.trim()) return;
      const requested = scheduled ? announcementTime(localTime, zone, Date.now()) : null;
      if (requested && !requested.instant) { setError(requested.error || 'Choose a publish date and time.'); return; }
      const input = { publishAt: requested?.instant ?? undefined, accountId: state.context.user.id, schoolId: audience === 'platform' ? null : audience, title: title.trim(), body: body.trim() };
      const serialized = JSON.stringify(input);
      const requestId = retry.current?.input === serialized ? retry.current.id : crypto.randomUUID();
      retry.current = { input: serialized, id: requestId };
      setBusy(true); setError('');
      try {
        await api.announcements.publish.mutate({ ...input, requestId });
        onPublished(requested?.instant ? `Scheduled for ${audienceName} on ${new Date(requested.instant).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.` : `Published to ${audienceName}.`);
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
      <Segmented<'now' | 'later'> label="Publish time" value={timing} disabled={busy} onChange={setTiming} options={[
        { value: 'now', label: 'Now' }, { value: 'later', label: 'Schedule for later' },
      ]} />
      {scheduled && <Field label="Publish date and time" htmlFor="announcement-publish-at" error={release.error}
        hint={`Time zone: ${zone}${release.offset ? ' (UTC' + release.offset + ')' : ''}`}>
        <Input id="announcement-publish-at" type="datetime-local" required disabled={busy} value={localTime} onChange={event => setLocalTime(event.target.value)} />
      </Field>}
      {audience === 'platform' && <Callout tone="warning">This announcement will appear on every school's board and as a popup across Quasar.</Callout>}
      {error && <AnnouncementError message={error} />}
      <div><Button type="submit" variant="primary" busy={busy} disabled={!state.online || !title.trim() || !body.trim() || (scheduled && !release.instant)}>{scheduled ? 'Schedule announcement' : 'Publish announcement'}</Button></div>
    </form>
  </Modal>;
}

function RemoveAnnouncement({ accountId, item, scheduled, onClose, onRemoved }: { accountId: string; item: Announcement; scheduled: boolean; onClose: () => void; onRemoved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const remove = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const input = { accountId, id: item.id };
      if (scheduled) await api.announcements.cancel.mutate(input);
      else await api.announcements.remove.mutate(input);
      onRemoved();
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  return <Modal open title={scheduled ? 'Cancel scheduled announcement?' : 'Delete announcement?'} onClose={onClose} busy={busy}
    footer={<><Button onClick={onClose} disabled={busy}>{scheduled ? 'Keep scheduled' : 'Keep announcement'}</Button>
      <Button variant="danger" busy={busy} onClick={() => void remove()}>{scheduled ? 'Cancel announcement' : 'Delete announcement'}</Button></>}>
    <p className="wrap-anywhere text-sm">{scheduled ? `Cancel "${item.title}" for ${item.schoolName ?? 'All Quasar'} before it goes live?` :
      `Remove "${item.title}" from the board and popups for ${item.schoolName ?? 'All Quasar'}?`}</p>
    {error && <AnnouncementError message={error} />}
  </Modal>;
}

function PublishedAnnouncement({ item, accountId, online, onRemoved }: { item: Announcement; accountId: string; online: boolean; onRemoved: () => void }) {
  const [confirm, setConfirm] = useState(false);
  return <article className="grid gap-3 rounded-xl border bg-card p-4">
    <AnnouncementDetails item={item} heading />
    {item.canDelete && <Button size="sm" variant="ghost" icon="trash" className="w-fit text-destructive" disabled={!online} onClick={() => setConfirm(true)}>Delete announcement</Button>}
    {confirm && item.canDelete && <RemoveAnnouncement accountId={accountId} item={item} scheduled={false} onClose={() => setConfirm(false)} onRemoved={() => { setConfirm(false); onRemoved(); }} />}
  </article>;
}

function PublishedManagement({ accountId, online, onClose, onRemoved }: { accountId: string; online: boolean; onClose: () => void; onRemoved: () => void }) {
  const [before, setBefore] = useState<number>();
  const [page, setPage] = useState<BoardPage | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!online) { setPage(null); return; }
    let active = true;
    let busy = false;
    const refresh = async () => {
      if (busy || document.visibilityState === 'hidden') return;
      busy = true;
      try {
        const result = await api.announcements.management.query({ accountId, before });
        if (active) { setPage(result); setError(''); }
      } catch (err) {
        if (active) { setPage(null); setError(errorMessage(err)); }
      } finally { busy = false; }
    };
    void refresh();
    const timer = window.setInterval(refresh, 60000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [accountId, before, online, revision]);
  const turnPage = (cursor?: number) => { setPage(null); setError(''); setBefore(cursor); };
  return <Modal open wide title="Published announcements" description="Posts from all schools and across Quasar." onClose={onClose}>
    {!online ? <Callout>Connect to manage published announcements.</Callout> : error ? <><AnnouncementError message={error} /><Button size="sm" onClick={() => setRevision(value => value + 1)}>Retry</Button></>
      : !page ? <p role="status">Loading announcements…</p> : page.items.length === 0 ? <EmptyState title="No published announcements" icon="bell" /> :
      page.items.map(item => <PublishedAnnouncement key={item.id} item={item} accountId={accountId} online={online} onRemoved={() => {
        setPage(null); setBefore(undefined); setRevision(value => value + 1); onRemoved();
      }} />)}
    {online && <div className="flex flex-wrap gap-2">
      {before !== undefined && <Button size="sm" onClick={() => turnPage()}>Newest announcements</Button>}
      {page?.nextBefore != null && <Button size="sm" onClick={() => turnPage(page.nextBefore!)}>Older announcements</Button>}
    </div>}
  </Modal>;
}

export function AnnouncementBoard({ state }: { state: AppState }) {
  const { user, school, staff, isAdmin } = state.context;
  const canPublish = isAdmin || (staff?.role === 'school-manager' && staff.schoolId === school.id);
  const [{ items, nextBefore: next }, setPage] = useState<BoardPage>({ items: [], nextBefore: null });
  const [upcoming, setUpcoming] = useState<Announcement[]>([]);
  const [upcomingError, setUpcomingError] = useState('');
  const [cancel, setCancel] = useState<Announcement | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [compose, setCompose] = useState(false);
  const [manage, setManage] = useState(false);
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
      const [page, scheduledItems] = await Promise.all([
        api.announcements.list.query({ accountId: user.id, before }),
        canPublish && before === undefined ? api.announcements.upcoming.query({ accountId: user.id })
          .then(rows => ({ rows, error: '' }), err => ({ rows: [], error: errorMessage(err) })) : null,
      ]);
      if (generation.current !== request) return;
      if (scheduledItems) {
        setUpcoming(scheduledItems.rows); setUpcomingError(scheduledItems.error);
        setCancel(current => current && scheduledItems.rows.some(item => item.id === current.id && item.canDelete) ? current : null);
      }
      setPage(current => before === undefined ? page : { ...page, items: [...current.items, ...page.items] });
    } catch (err) {
      if (generation.current === request) {
        setError(errorMessage(err));
        if (err instanceof TRPCClientError && (err.data?.code === 'FORBIDDEN' || err.data?.code === 'UNAUTHORIZED')) {
          setPage({ items: [], nextBefore: null }); setUpcoming([]); setCancel(null); setManage(false);
        }
      }
    }
    finally { if (generation.current === request) { pending.current = false; setBusy(false); } }
  }, [user.id, canPublish]);
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
    {isAdmin && <Button size="sm" className="w-fit" variant="secondary" onClick={() => setManage(true)} disabled={!state.online}>Manage published announcements</Button>}
    {manage && isAdmin && <PublishedManagement accountId={user.id} online={state.online} onClose={() => setManage(false)} onRemoved={() => { setPublished('Announcement deleted.'); void load(); }} />}
    {published && <Callout tone="success" role="status">{published}</Callout>}
    {canPublish && upcomingError && <AnnouncementError message={upcomingError} />}
    {canPublish && upcoming.length > 0 && <section aria-labelledby="upcoming-announcements" className="grid gap-3">
      <h3 id="upcoming-announcements" className="font-bold">Upcoming announcements</h3>
      {upcoming.map(item => <article key={item.id} className="grid gap-3 rounded-xl border border-dashed bg-muted/40 p-4">
        <AnnouncementDetails item={item} heading />
        {item.canDelete && <Button size="sm" variant="ghost" className="w-fit" disabled={!state.online} onClick={() => setCancel(item)}>Cancel announcement</Button>}
      </article>)}
    </section>}
    {!state.online ? <Callout>Connect to see the latest announcements.</Callout> : error ? <Callout tone="danger" role="alert" actions={<Button size="sm" onClick={() => void load(lastCursor.current)}>Retry</Button>}>{error}</Callout>
      : busy && items.length === 0 ? <p role="status" className="text-sm text-muted-foreground">Loading announcements…</p>
      : items.length === 0 && <EmptyState icon="bell" title={upcoming.length && canPublish ? "No published announcements yet" : "No announcements yet"}>New posts will appear here.</EmptyState>}
    {items.map(item => <PublishedAnnouncement key={item.id} item={item} accountId={user.id} online={state.online} onRemoved={() => {
      setPage(current => ({ ...current, items: current.items.filter(entry => entry.id !== item.id) })); setPublished('Announcement deleted.'); void load();
    }} />)}
    {next !== null && <div><Button size="sm" busy={busy} disabled={!state.online} onClick={() => void load(next)}>Older announcements</Button></div>}
    {cancel?.canDelete && canPublish && <RemoveAnnouncement scheduled accountId={user.id} item={cancel} onClose={() => setCancel(null)} onRemoved={() => {
      setUpcoming(current => current.filter(item => item.id !== cancel.id)); setCancel(null); setPublished('Announcement canceled.'); void load();
    }} />}
    {compose && canPublish && <ComposeAnnouncement state={state} owner={isAdmin} onClose={() => setCompose(false)} onPublished={message => { setCompose(false); setPublished(message); void load(); }} />}
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
    if (busy) return;
    let active = true;
    let pending = false;
    const check = async () => {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      try {
        const unread = await api.announcements.unread.query({ accountId });
        if (active) { setItem(unread); setError(''); }
      } catch { /* A connection or focus change retries delivery. */ }
      finally { pending = false; }
    };
    void check();
    const timer = window.setInterval(check, 60000);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); };
  }, [accountId, busy]);
  if (!item) return null;
  const dismiss = async (board = false) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      try { await api.announcements.dismiss.mutate({ accountId, id: item.id }); }
      catch (err) { if (!(err instanceof TRPCClientError && err.data?.code === 'NOT_FOUND')) throw err; }
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
