# Quasar

Phase 1 of [PLAN.md](PLAN.md): a personal school schedule and task tracker. The UI is a phone-first app with five views (Today, Schedule, Tasks, Classes, School) behind hash routes, structured editors for every schedule concept, and an always-visible sync status. [UI_REDESIGN.md](UI_REDESIGN.md) records the screen inventory and design decisions.

Built with Next.js App Router, TypeScript, Tailwind CSS, tRPC, Google OAuth through NextAuth, SQLite, and IndexedDB. There is no demo login or production authentication bypass.

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

Run a build first. Optionally set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an existing Chromium binary. The build and development commands use Webpack; the container enables Next's standalone output with `WHATSNEXT_STANDALONE=1`.

## Implemented scope

- Google sign-in, an onboarding wizard for names and school search/creation (schedule templates plus a structured editor with live date preview), and an explicit approved / community / private schedule choice.
- Variable rotations, stable periods, lunch waves, date anchors, school time zones, holidays/closures, replacement days, resets, personal shifts/overrides and private custom schedules, all edited through forms rather than JSON.
- Today view with the current/next period, countdown and progress; week and day browsing with rotation overview; general tasks with due date/time, optional class, notes, completion, editing and deletion; class cards with period assignments and "meets on" hints.
- Member edits of unlocked schedules, permanent membership threshold lock at ten members, support locks, owner review/corrections and an internal correction-request inbox.
- Persistent, account-scoped offline storage and edit queue, safe retries, automatic merges of independent changes, explicit conflict choices, shared correction review without deleting personal data.
- Single-server container packaging, health endpoint, backup utility and deployment/pilot instructions.

Shared-school editing and joining require a connection. Saved personal classes, tasks, assignments, custom schedules and overrides can be edited offline after a successful signed-in load. The service worker requires HTTPS except on localhost. Sync resumes when the app is open and connectivity returns; it does not require browser background-sync support.

Phase 2–4 features (iCal, directory, friends, chat, voting, reminders, richer task features) are not implemented. No member directory or other students' names/schedules are exposed.

## Project guide

Validation completed on 2026-09-11: 76 unit/integration tests, eight Chromium browser tests, TypeScript checking, production build, and a backup/restore-content check pass. Browser tests cover onboarding with an explicit community choice, class and task persistence, offline reload/edit/upload, competing-device conflict choices, shared-schedule editing, admin permissions, sign-out cache clearing, and desktop/mobile layout checks with screenshots of every screen. Live Google authorization needs real credentials; Docker execution was not tested because Docker is unavailable in this workspace. No live deployment was performed.

- [UI redesign notes](UI_REDESIGN.md): screens, routes, and the presentation-layer decisions.
- [UI handoff](docs/FABLE_HANDOFF.md): component map and integration contracts between the UI and the domain/offline layers.
- [Architecture and schedule rules](docs/ARCHITECTURE.md): persistence, conflict handling and implementation decisions.
- [Deployment, backups and pilot checklist](docs/OPERATIONS.md).
- `src/domain/`: shared Zod models, schedule engine, merge logic and tests.
- `src/server/`: Google auth, SQLite schema, domain service and tRPC authorization.
- `src/client/`: typed API and durable offline storage.
- `src/components/`: replaceable React presentation.

Compatibility was checked against the [Next.js installation guide](https://nextjs.org/docs/app/getting-started/installation), [tRPC fetch adapter](https://trpc.io/docs/server/adapters/fetch), and installed package declarations. Exact dependency versions are pinned in `package-lock.json`.
