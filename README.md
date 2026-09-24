# Quasar

Phases 1 to 4 of [PLAN.md](PLAN.md): a personal school schedule and task tracker with a school community and friends-only chat. The UI is a phone-first app with seven views (Today, Schedule, Tasks, Classes, School, People, Messages) behind hash routes, structured editors for every schedule concept, and an always-visible sync status. [UI_REDESIGN.md](UI_REDESIGN.md) records the screen inventory and design decisions.

Built with Next.js App Router, TypeScript, Tailwind CSS with [shadcn/ui](https://ui.shadcn.com) (Radix primitives, lucide icons), tRPC, Google OAuth through NextAuth, SQLite, and IndexedDB. There is no demo login or production authentication bypass.

The shadcn-owned components live in `src/components/ui/` (managed by `components.json`; add more with `npx shadcn@latest add <name>`). App-level composites built on them (`Button`, `Field`, `Chip`, `Callout`, `Modal`, `Segmented`, `Section`, …) live in `src/components/primitives.tsx`.

## Run locally

Requires Node.js 22.12+ (Node 24 recommended) and npm.

```sh
npm ci
cp .env.example .env.local
# Fill in the variables below, then:
npm run dev
```

Open `http://localhost:3000`. Create a Google OAuth **Web application** client, configure its consent screen/test users, and add `http://localhost:3000/api/auth/callback/google` as an authorized redirect URI. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXTAUTH_URL`, and a strong `NEXTAUTH_SECRET` in `.env.local`. Generate a secret with `openssl rand -base64 32`. Set `OWNER_EMAIL` to the owner's verified Google email to enable `/admin`; roles are enforced by the server. Names are entered during onboarding independently of Google profile names.

Google credentials and a public domain are required for real sign-in and deployment; neither is supplied in this repository. Schedule logic and synchronization tests run without credentials.

```sh
npm test
npm run typecheck
npm run build
npm start
```

Browser tests use an isolated temporary database and encrypted test-session fixtures, without changing production authentication:

```sh
npx playwright install chromium
npm run test:e2e
```

Run a build first. Optionally set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an existing Chromium binary. The build and development commands use Webpack; the container enables Next's standalone output with `QUASAR_STANDALONE=1`.

## Implemented scope

- Google sign-in, an onboarding wizard for names and school search/creation (schedule templates plus a structured editor with live date preview), and an explicit approved / community / private schedule choice.
- Variable rotations, stable periods, lunch waves, date anchors, school time zones, holidays/closures, replacement days, resets, personal shifts/overrides and private custom schedules, all edited through forms rather than JSON.
- Today view with the current/next period, countdown and progress; week and day browsing with rotation overview; general tasks with due date/time, optional class, notes, completion, editing and deletion; class cards with period assignments and "meets on" hints.
- Member edits of unlocked schedules, permanent membership threshold lock at ten members, support locks, owner review/corrections and an internal correction-request inbox.
- Persistent, account-scoped offline storage and edit queue, safe retries, automatic merges of independent changes, explicit conflict choices, shared correction review without deleting personal data.
- Single-server container packaging, health endpoint, backup utility and deployment/pilot instructions.

Shared-school editing and joining require a connection. Saved personal classes, tasks, assignments, custom schedules and overrides can be edited offline after a successful signed-in load. The service worker requires HTTPS except on localhost. Sync resumes when the app is open and connectivity returns; it does not require browser background-sync support.

Phase 3 adds the People view: school verification (automatic by school email domain, or by support review of a proof), a member directory with verified-only full names, friend requests, friends' classes and today's timetable, blocking and reporting. Locked schools get schedule-change voting in the School view, and the support admin page gains verification requests, member reports, passed proposals awaiting publication, and per-school email domains.

Phase 4 adds Messages: one-to-one chat between accepted friends, specified in [docs/CHAT.md](docs/CHAT.md). On phones it opens from an icon in the top bar; on desktop it is a sidebar item. Chat is online only and polls for new messages; nothing about it is stored on the device except the unread count. Removing a friend or blocking closes the chat for both people at once and leaves a report-only row for 30 days. Reports freeze up to 30 messages from that chat, and the owner sees them only by opening the report, which is logged. The admin page gains Show messages, Hide message, timed messaging pauses and a Paused members section. Chat pushes say only "You have new messages.", wait 60 s, are capped at one per 10 minutes and 20 a day, and stay quiet from 22:00 to 07:00. Turn them off under Account → Notifications → Message notifications. The background worker also deletes old chat data on the schedule in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Phase 2 adds private iCal subscriptions in Schedule, imported calendar items in Tasks and Schedule, task priorities and checklists, recurring tasks, and opt-in browser push reminders. The new controls use the existing cards, sheets, form fields and status indicators. Member directories, friends, chat and voting remain deferred; other students' names and schedules are not exposed.

### Connected calendars and richer tasks

Add an iCal subscription under Schedule → Connected calendars. Choose a time zone for floating times. Calendar refreshes match source identities to existing tasks and preserve completion, checklists, priorities and reminders. Changes to details that were also edited locally prompt a choice. Missing source items remain saved and marked as removed. Refresh failures keep the last successful data. Pausing stops automatic updates; removing a subscription keeps its items as regular tasks. Calendar subscriptions and source choices require a connection; saved tasks and their richer fields use the existing offline queue.

Task repeat settings support daily, weekly and monthly intervals and an optional inclusive end date. Completing a task creates the next occurrence when the completion syncs. Monthly repeats retain the original day, clamping to shorter months. The next occurrence resets task/checklist completion and keeps the other task settings. Retries and reopening the same completed task never create another successor; deleting a successor does not cause it to be recreated. Imported items follow their source calendar rather than manual repeat settings.

Task reminders use the saved reminder time zone and due time, or 9:00 AM when only a date is set. Enable browser notifications from Account on each device. Reminders require HTTPS, browser permission, server VAPID configuration and the background worker. Browser/provider availability affects delivery; reminders are not alarms.

### Background worker

Run `npm run worker` alongside the web process with the same `.env.local`, database path and VAPID keys. It periodically refreshes calendars and delivers due reminders. When a new support item arrives (a correction request, feedback, a verification request, a report or a proposal awaiting support), the owner's enrolled browsers get a generic "A new support request is waiting" push that opens `/admin` and carries no request text, names or emails. Keep one supervised worker running in production. Configure `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` as described in `.env.example`; never commit private keys. Without VAPID keys, calendar refreshing still works and browser notification enrollment remains unavailable. Manual calendar refresh is available in the app.

The current private installation has its worker and VAPID keys configured. Local automated checks do not establish delivery to a real device; enable browser reminders in Account and test a task reminder.

## Timetable photo scanning

Students can add classes from photos of a printed or on-screen timetable (Classes → Scan timetable). A scan may carry up to three photos, for example both halves of a timetable. The browser downsizes each photo, the server sends them once to any OpenAI-compatible vision model along with the school's period IDs and the grade-filtered class directory, and the student confirms or edits every row before anything is saved. Photos are not stored. Configure `SCAN_API_URL`, `SCAN_MODEL` and optionally `SCAN_API_KEY` and `SCAN_MODEL_REASONING` as described in `.env.example`; the feature stays hidden until both the URL and model are set. Examples: OpenAI `gpt-5.6-luna`, DeepSeek `deepseek-chat`, OpenRouter (`https://openrouter.ai/api/v1`) `openai/gpt-6-luna`, or a local Ollama `qwen3-vl:8b`. Each account may run 10 scans per hour and 30 per day. The quotas count scans, not photos, so a three-photo scan uses one. Each scan is recorded in `audit_log` as `schedule.scan`.

## Continuous integration

Every push to `master` and every pull request runs `.github/workflows/ci.yml`: typecheck, the unit suite and the production build, then the Playwright suite against that build in Chromium. Failed browser runs upload `test-results/` (traces and screenshots) as an artifact.

## Project guide

Phase 2 verification completed on 2026-09-11: 138 unit/integration tests, all ten Chromium browser scenarios, TypeScript checking and the production build pass. Browser checks cover existing onboarding, schedule editing, offline sync, conflicts, authorization and responsive layouts, plus rich recurring tasks and completed imported calendar entries. Quasar and its background worker are running at https://home-server.tail210f05.ts.net:3003/; the private health endpoint and database integrity check pass. A verified database backup was saved before deployment. Google sign-in completion, a real school feed and delivery to a real browser remain interactive pilot checks. Docker execution was not tested because Docker is unavailable on this host.

- [UI redesign notes](UI_REDESIGN.md): screens, routes, and the presentation-layer decisions.
- [UI handoff](docs/FABLE_HANDOFF.md): component map and integration contracts between the UI and the domain/offline layers.
- [Architecture and schedule rules](docs/ARCHITECTURE.md): persistence, conflict handling and implementation decisions.
- [Deployment, backups and pilot checklist](docs/OPERATIONS.md).
- `src/domain/`: shared Zod models, schedule engine, merge logic and tests.
- `src/server/`: Google auth, SQLite schema, domain service and tRPC authorization.
- `src/client/`: typed API and durable offline storage.
- `src/components/`: replaceable React presentation.

Compatibility was checked against the [Next.js installation guide](https://nextjs.org/docs/app/getting-started/installation), [tRPC fetch adapter](https://trpc.io/docs/server/adapters/fetch), and installed package declarations. Exact dependency versions are pinned in `package-lock.json`.


### School class directory and grades

Choose a grade when joining a school; existing students can choose it from the setup reminder, Account, or School. Grade changes use the selected grade's bell schedule and lunch times. Personal timetable copies and explicit adjustments stay intact.

Classes → Browse school classes opens the searchable, grade-filtered directory. Select multiple classes, add them, then drag them onto school periods (or select a class and tap a period). Personal edits affect only your copy. Shared directory editing follows the school's permanent ten-member lock and support lock; the owner can manage directories in Support → Schools → Classes. Locked entries have a correction-request action. Directory changes and removals preserve existing personal copies.

The additive SQLite migration creates `school_classes`; existing schedules and tasks are retained. Only with the owner's explicit permission, publish their saved class names, rooms, and teachers with `node --env-file=.env.local --import tsx scripts/seed-directory.ts`. Back up first. This command uses the configured owner, is repeatable, and preserves personal class IDs, colors, assignments, and sync history. It does not publish other students' personal classes.
