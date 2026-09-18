'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/client/api';
import { effectiveSchedule, scheduleForGrade, emptyPersonalSchedule, personalScheduleSchema, type PersonalSchedule } from '@/domain/schedule';
import type { Task } from '@/domain/task';
import { todayIn } from '@/lib/format';
import { VIEWS, taskItems, type AppState, type View } from './app-state';
import { DeviceConflicts, SchoolReview } from './conflicts';
import { Onboarding } from './onboarding';
import { Spinner } from './icon';
import { CenteredNotice, Shell, Welcome } from './shell';
import { Button, Callout } from './primitives';
import { useWorkspace } from './use-workspace';
import { ClassesView } from './views/classes';
import { ScheduleView } from './views/schedule';
import { SchoolView } from './views/school';
import { TasksView } from './views/tasks';
import { TodayView } from './views/today';
import { GradePicker } from './grade-picker';

/* ---------- Hash routing keeps the public offline shell at "/" ---------- */

function parseHash(hash: string): { view: View; params: URLSearchParams } {
  const [name, query = ''] = hash.replace(/^#\/?/, '').split('?');
  const view = VIEWS.find((entry) => entry.id === name)?.id ?? 'today';
  return { view, params: new URLSearchParams(query) };
}

function useHashRoute() {
  const [route, setRoute] = useState(() => parseHash(typeof window === 'undefined' ? '' : window.location.hash));
  useEffect(() => {
    const update = () => setRoute(parseHash(window.location.hash));
    update();
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const navigate = useCallback((view: View, params?: Record<string, string>) => {
    const query = params && Object.keys(params).length ? `?${new URLSearchParams(params)}` : '';
    const next = `#${view}${query}`;
    if (window.location.hash === next) setRoute(parseHash(next));
    else window.location.hash = next;
    window.scrollTo({ top: 0 });
  }, []);
  return { ...route, navigate };
}

function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    const onVisible = () => { if (document.visibilityState === 'visible') setNow(new Date()); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [intervalMs]);
  return now;
}

/* ---------- Root ---------- */

export function Tracker() {
  const session = useWorkspace();
  const route = useHashRoute();
  const now = useNow();
  const { context, snapshot } = session;

  const personalEntity = snapshot?.entities.find((entity) => entity.kind === 'personal' && entity.id === 'personal' && !entity.deleted);
  const parsedPersonal = useMemo(() => personalScheduleSchema.safeParse(personalEntity?.data ?? emptyPersonalSchedule()), [personalEntity]);
  const personal: PersonalSchedule = parsedPersonal.success ? parsedPersonal.data : emptyPersonalSchedule();
  const openTasks = useMemo(() => snapshot ? taskItems(snapshot.entities).filter((item) => !item.task.completed).length : 0, [snapshot]);

  if (session.authRequired) return <Welcome message={session.error || undefined} />;
  if (session.loading && !context) return <CenteredNotice title="Opening your schedule…"><Spinner className="inline-block text-primary" size={20} /></CenteredNotice>;
  if (!context || !snapshot) {
    return <CenteredNotice title="Connect to get started" action={<Button variant="primary" onClick={() => void session.initialize()} busy={session.loading}>Retry connection</Button>}>
      {session.error || 'Connect to the internet and sign in once to set up Quasar on this device.'}
    </CenteredNotice>;
  }

  const needsNames = !context.user.displayName || !context.user.fullName;
  if (needsNames || !context.school) {
    return <Onboarding context={context} online={session.online} error={session.error} onRefresh={session.initialize} onSignOut={session.requestLogout} logoutPending={session.logout.pending} />;
  }

  const school = context.school;
  const schedule = effectiveSchedule(school.schedule, personal);
  const timeZone = schedule.timeZone;
  const state: AppState = {
    context: { ...context, school },
    snapshot,
    personal,
    personalValid: parsedPersonal.success,
    schedule: scheduleForGrade(school.schedule, personal.grade),
    timeZone,
    now,
    today: todayIn(timeZone, now),
    online: session.online,
    saveTask: (id: string, task: Task | null) => session.save('task', id, task),
    savePersonal: (value: PersonalSchedule) => session.save('personal', 'personal', personalScheduleSchema.parse(value)),
    refresh: session.initialize,
    navigate: route.navigate,
    params: route.params,
  };

  return <Shell session={session} context={context} view={route.view} taskCount={openTasks} gradeSettings={<GradePicker personal={personal} save={state.savePersonal} disabled={!state.personalValid} />}>
    {!personal.grade && state.personalValid && <div className="mb-4 rounded-xl border border-primary/40 bg-card p-4">
      <p className="mb-3 text-sm">Choose your grade to see the right school schedule and lunch times.</p>
      <GradePicker personal={personal} save={state.savePersonal} />
    </div>}
    <div className="grid gap-4 mb-4 empty:hidden" id="conflicts">
      {!parsedPersonal.success && <Callout tone="danger" icon="alert" role="alert" title="Your saved personal schedule needs review" actions={<Button size="sm" onClick={() => void session.synchronize()} disabled={!session.online}>Retry sync</Button>}>It could not be read on this device. Retry sync before making more changes so nothing is overwritten.</Callout>}
      <DeviceConflicts snapshot={snapshot} schedule={schedule} classes={personal.classes} resolve={session.resolve} />
      {context.review && <SchoolReview key={context.review.version} review={context.review} personal={personal} online={session.online} today={state.today}
        onAcknowledge={async () => { await api.school.acknowledge.mutate({ version: context.review!.version }); await session.initialize(); }}
        onOpenClasses={() => route.navigate('classes')} />}
    </div>
    {route.view === 'today' && <TodayView state={state} />}
    {route.view === 'schedule' && <ScheduleView state={state} />}
    {route.view === 'tasks' && <TasksView state={state} />}
    {route.view === 'classes' && <ClassesView state={state} />}
    {route.view === 'school' && <SchoolView state={state} />}
  </Shell>;
}
