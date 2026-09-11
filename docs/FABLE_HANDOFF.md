# Quasar UI handoff

The presentation layer was rebuilt on 2026-09-11 (see [UI_REDESIGN.md](../UI_REDESIGN.md)). This document maps the UI components to the domain, server and offline contracts they must respect. Keep the existing domain, authentication, authorization, and offline behavior when changing the presentation. [PLAN.md](../PLAN.md) remains the product scope; [ARCHITECTURE.md](ARCHITECTURE.md) explains the implementation and [OPERATIONS.md](OPERATIONS.md) covers hosting.

## Component map

| Area | Implementation | Notes |
| --- | --- | --- |
| Account, offline store, sync state | [use-workspace.ts](../src/components/use-workspace.ts) | Bootstrap, offline fallback, account checks around uploads, conflict resolution, verified sign-out. Behavior rules live here; views only call `save`, `resolve`, `synchronize`. |
| Root and routing | [tracker.tsx](../src/components/tracker.tsx), [app-state.ts](../src/components/app-state.ts) | Hash routes keep `/` a public offline shell. Builds the `AppState` passed to every view. |
| Shell, welcome, status | [shell.tsx](../src/components/shell.tsx) | Sidebar / tab bar, status pill, banners, account and sign-out sheets, welcome screen. |
| Onboarding | [onboarding.tsx](../src/components/onboarding.tsx) | Names → find or create school (templates from [templates.ts](../src/lib/templates.ts) + editor) → explicit approved / community / private choice with preview. Online only. |
| Views | [views/today.tsx](../src/components/views/today.tsx), [views/schedule.tsx](../src/components/views/schedule.tsx), [views/tasks.tsx](../src/components/views/tasks.tsx), [views/classes.tsx](../src/components/views/classes.tsx), [views/school.tsx](../src/components/views/school.tsx) | Each receives `AppState`. |
| School schedule editor | [schedule-editor.tsx](../src/components/schedule-editor.tsx) | Basics / periods / days / exceptions / preview sections, `describeIssues` for readable validation, `Preview` uses `resolveDay`. Used by onboarding, School view, private schedule and admin. |
| Personal adjustments | [overrides.tsx](../src/components/overrides.tsx) | Date sheet (close/reopen/custom periods/shift), cycle-day sheet, private schedule sheet, adjustments list. |
| Conflicts and reviews | [conflicts.tsx](../src/components/conflicts.tsx) | Field-level `DiffTable`, draft protection while editing, device conflicts, school-correction review with `detectOverrideConflicts`. |
| Owner support | [admin.tsx](../src/components/admin.tsx) | Inbox, schools table, review sheet with editor, approve and lock. |
| Primitives and styling | [ui.tsx](../src/components/ui.tsx), [icon.tsx](../src/components/icon.tsx), [format.ts](../src/lib/format.ts), [globals.css](../src/app/globals.css) | Tokens and light/dark themes. Custom CSS is in `@layer base` / `@layer components` so Tailwind utilities can override it. |

## Editing rules the forms follow

Build forms around [schedule.ts](../src/domain/schedule.ts), using its exported Zod schemas for validation and its inferred types for props. [example.ts](../src/domain/example.ts) contains editable ten-day starter data used by tests; it is an example, not an approved real school schedule.

1. **School schedule:** time zone; stable period definitions with class/lunch/other kind; configurable cycle days; each day's ordered start/end slots; anchor date and cycle day; attendance and advancement weekdays; date exceptions. Never assume a ten-day cycle.
2. **Exceptions:** closures with an explicit pause/advance choice; replacement slots with that choice; cycle resets with a selected cycle day. Resets may also supply special slots or an explicit closure. The preview uses `resolveDay` before saving.
3. **Personal schedule:** class/room/teacher and assignment controls, cycle-day slot overrides, individual date closure/reopening, replacement slots, time shifts, and an optional complete private schedule.
4. **Correction review:** readable list of what changed plus `detectOverrideConflicts` results; students can edit their retained settings or explicitly acknowledge keeping them.
5. **Device conflicts:** field comparisons with clear local/remote choices. The local choice retains the latest optimistic entity, including later queued edits, and the comparison shows that latest value.

Generate an ID once when creating a period, class, cycle day or slot (`slugId`, `randomId` in `format.ts`). Keep it when renaming, reordering or editing. Slots are chronological and cannot overlap or cross midnight. Several slots can reference the same period, so a class can appear before and after lunch. Lunch waves can use distinct lunch period IDs. Removing a class clears its period assignments in the same personal save; existing task data remains intact.

The anchor identifies the cycle day **on** its date; advancement occurs **after** each date. Weekday numbers are Monday=1 through Sunday=7. Attendance and advancement are separate settings. Personal edits affect only that student's view and do not change shared advancement.

## Reuse these contracts

| Export | Use |
| --- | --- |
| `scheduleSchema`, `Schedule` | School schedule and optional complete personal schedule |
| `personalScheduleSchema`, `PersonalSchedule`, `emptyPersonalSchedule()` | Classes, assignments, cycle/date overrides, optional `customSchedule` |
| `classSchema`, `StudentClass`, `slotSchema`, `periodSchema`, `cycleDaySchema`, `exceptionSchema` | Validate individual form sections |
| `resolveDay(schedule, date, personal?)` | Local school date to `{ cycleDayId, cycleDayLabel, closed, periods, issues }` |
| `nextClass(schedule, now, personal?, lookAheadDays?)` | Current period or next upcoming period; `null` when none is found |
| `detectOverrideConflicts(previous, current, personal)` | Review shared changes without changing or deleting personal settings |
| `taskSchema`, `Task`, `upcomingTasks` in [task.ts](../src/domain/task.ts) | Task form validation and sorting incomplete tasks |

`nextClass` returns `status: 'current' | 'upcoming'` and includes lunch and unassigned periods. A resolved period includes local `start`/`end`, UTC `startAt`/`endAt`, period metadata, and its optional assigned class. Both scheduling functions automatically use `personal.customSchedule` when present. Keep the school's time zone visible and calculate “today” in that zone. Do not convert date-only values through the browser's UTC `Date` parser.

Resolution precedence is school rotation, school exception, personal cycle override, then personal date override. A cycle override does not reopen a school closure; a date override can. Time shifts that move slots outside their date, removed period references, and nonexistent daylight-saving times appear in `issues`. Keep the saved edits and present a way to correct them. Repeated autumn clock times use their earlier occurrence.

## Save through the existing offline workspace

[client/api.ts](../src/client/api.ts) exposes the typed tRPC client and `Workspace`/`School` output types. [client/offline.ts](../src/client/offline.ts) owns IndexedDB and the persistent upload queue. `useWorkspace` connects the two; views never touch the store directly.

| Operation | Contract |
| --- | --- |
| Read and subscribe | `store.read()` returns optimistic `entities`, pending count, conflicts, cached context and the last error; `store.subscribe(listener)` observes changes |
| Save a task | `store.save('task', stableTaskId, taskData)`; use `null` to delete |
| Save personal settings | `store.save('personal', 'personal', personalData)`; save the complete validated document and retain fields unrelated to the edit |
| Upload | `store.sync(sender)` sends `api.sync.mutate({ ...mutation, accountId: store.accountId })`; existing account checks must surround uploads |
| Refresh | `store.ingest(serverEntities)` and `store.setContext(context)` retain queued local work |
| Resolve conflict | `store.resolve(mutationId, 'local' | 'remote')`, then synchronize; a further remote edit can produce another conflict |

Await `save` before reporting success: it resolves after the local transaction commits, not after a network upload. Distinguish saving locally, waiting to sync, syncing, saved remotely, failed sync and unresolved conflicts. Network failure must leave entered data available with retry. Disable duplicate submission while a local write is pending. Keep drafts on validation or save errors and avoid resetting open forms during background refreshes.

Use the queue for personal changes even when online. It owns mutation IDs, base revisions, retries, tombstones, merging and conflict persistence. Do not replace it with direct task API calls, a latest-write-wins state cache, or localStorage. The personal document is one versioned entity; tasks have separate IDs. School revisions and task/personal entity versions are distinct.

Name entry, school selection/creation, shared corrections, support requests, review acknowledgment and admin operations are online operations through `api`. Shared saves include `expectedVersion`; a stale revision must produce a reviewable error while retaining the form draft.

## Preserve account and school rules

- Google sign-in and both names are required before setup. Offline access is for an account previously saved on this device. An authentication rejection must return to sign-in, not activate offline fallback.
- Check the active account before uploading its queue. Account switches must never send one account's edits to another account.
- Sign-out requires a connection and verified server logout before clearing that account's device cache. Pending work must first sync or be explicitly discarded; preserve the existing choice and retain local data if sign-out fails.
- An unreviewed school schedule requires explicit selection. Creating a school does not automatically join it or select its schedule.
- Member edits lock at ten members and remain locked after departures. Support locks are separate. Personal settings remain editable. Server authorization remains authoritative even if the UI hides restricted actions.
- School corrections preserve personal overrides. Acknowledgment keeps those settings and records review; it is not a command to reset them.
- Keep `/` a public application shell. [sw.js](../public/sw.js) caches public application assets only; never place authenticated API responses, names, schedules or tasks in its shared cache.

## Review after UI changes

Run `npm run typecheck`, `npm test`, `npm run build`, then `npm run test:e2e` (requires `npx playwright install chromium` once). The browser tests exercise explicit school choice, class/lunch setup and reload, task completion offline, reconnect/retry, competing edits, shared-schedule editing, admin approval, sign-out with a clean cache, and desktop/mobile layouts; they also save screenshots of every screen under `test-results/` for a visual check in light and dark mode.

Keep phase 1 focused on personal schedules and tasks. Automatic iCalendar feeds, subtasks, recurring tasks, priorities, notifications, reminders, member browsing, verification workflows, friends, sharing, voting and chat are deferred. Google email verification is authentication and does not establish school verification.
