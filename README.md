# Quasar

Production domain: `https://getquasarapp.com`. The [domain move runbook](docs/DOMAIN_MOVE.md) covers cutover and the notice at the previous address.

Phases 1 to 4 of [PLAN.md](PLAN.md): a personal school schedule and task tracker with a school community, friends-only one-to-one chat and one public Global chat room. The UI is a phone-first app with seven views (Today, Schedule, Tasks, Classes, School, People, Messages) at their own paths, structured editors for every schedule concept, and an always-visible sync status. [UI_REDESIGN.md](UI_REDESIGN.md) records the screen inventory and design decisions.

Built with Next.js App Router, TypeScript, Tailwind CSS with [shadcn/ui](https://ui.shadcn.com) (Radix primitives, lucide icons), tRPC, Google OAuth through NextAuth, SQLite, and IndexedDB. There is no demo login or production authentication bypass.

The shadcn-owned components live in `src/components/ui/` (managed by `components.json`; add more with `npx shadcn@latest add <name>`). App-level composites built on them (`Button`, `Field`, `Chip`, `Callout`, `Modal`, `Segmented`, `Section`, …) live in `src/components/primitives.tsx`.

## Run locally

Requires Node.js 22.12+ (Node 24 recommended) and npm. npm is the only supported package manager: `package-lock.json` is the only lockfile, and CI and the Dockerfile install from it with `npm ci`. Do not install with pnpm (see [docs/OPERATIONS.md](docs/OPERATIONS.md)).

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

Browser tests use an isolated temporary database (removed when the run ends; set `E2E_KEEP_DATABASE=1` to keep it for debugging) and encrypted test-session fixtures, without changing production authentication. The test server (and `scripts/ui-sweep.ts`) listens on 127.0.0.1 only and blanks the scan-provider and VAPID keys, so production keys in `.env.local` do not reach it:

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
- Persistent, account-scoped offline storage and edit queue (the first change saved on a page asks the browser for persistent storage; a browser that refuses may still evict it when space runs low, and the Account sheet says so), safe retries, automatic merges of independent changes, explicit conflict choices, shared correction review without deleting personal data.
- Single-server container packaging, health endpoint, backup utility and deployment/pilot instructions.
- The school lunch menu: connect the school's Nutrislice menu site (School → Lunch menu; the owner always, members while the shared schedule is open to member edits), and Today and Schedule show each day's lunch under the timeline, with the whole week and a link to the menu site in School. Weeks are fetched from the provider on demand and cached for three hours per school.

Shared-school editing and joining require a connection. Saved personal classes, tasks, assignments, custom schedules and overrides can be edited offline after a successful signed-in load. The service worker requires HTTPS except on localhost. Sync resumes when the app is open and connectivity returns; it does not require browser background-sync support.

Phase 3 adds the People view: school verification (automatic by school email domain, or by support review of a proof), a member directory with verified-only full names, friend requests, friends' classes and today's timetable, blocking and reporting. Locked schools get schedule-change voting in the School view, and the support admin page gains verification requests, member reports, passed proposals awaiting publication, and per-school email domains.

Phase 4 adds Messages: one-to-one chat between accepted friends, specified in [docs/CHAT.md](docs/CHAT.md), plus one public **Global chat** room ([CHAT.md §11](docs/CHAT.md#11-global-chat-migration-7)) that every member with names entered can read and post in, across schools. The owner moderates the room directly (edit or remove any message with a reason everyone sees, audited), it has no block or report button of its own, but a block made in People or a one-to-one chat hides the blocked member's room messages from the blocker (one way), and each member can mute it. Slurs are censored to asterisks in both kinds of chat. On phones it opens from the dock's People tab (Chats / Friends, and it opens on Chats while anything is unread); on desktop it is a sidebar item. School likewise sits under Classes in the phone dock. Chat is online only and polls for new messages; nothing about it is stored on the device except the unread count. Removing a friend or blocking closes the chat for both people at once and leaves a report-only row for 30 days. Reports freeze up to 30 messages from that chat, and the owner sees one-to-one messages only by opening the report, which is logged. The admin page gains Show messages, Hide message, timed messaging pauses and a Paused members section. Chat pushes say only "You have new messages.", wait 60 s, are capped at one per 10 minutes and 20 a day, and stay quiet from 22:00 to 07:00. Turn them off under Account → Notifications → Message notifications. The background worker also deletes old chat data on the schedule in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Phase 2 adds private iCal subscriptions in Schedule, imported calendar items in Tasks and Schedule, task priorities and checklists, recurring tasks, and opt-in browser push reminders. The new controls use the existing cards, sheets, form fields and status indicators. Member directories, friends, chat and voting came later, in phases 3 and 4 above; phase 2 itself exposed no other student's name or schedule.

### Connected calendars and richer tasks

Add an iCal subscription under Schedule → Connected calendars. The calendar's time zone starts as the school's: imported due dates and times are converted into it (times the feed leaves unzoned are read in it). The task list and overdue checks read them in the school's zone, while reminders on imported items count from the calendar's zone, so a calendar set to another zone reminds by that zone's clock but turns overdue by the school's; change it only with a reason. Calendar refreshes match source identities to existing tasks and preserve completion, checklists, priorities and reminders. Changes to details that were also edited locally prompt a choice. Missing source items remain saved and marked as removed. Refresh failures keep the last successful data. Pausing stops automatic updates; removing a subscription keeps its items as regular tasks. Calendar subscriptions and source choices require a connection; saved tasks and their richer fields use the existing offline queue.

Task repeat settings support daily, weekly and monthly intervals and an optional inclusive end date. Task dates, like school dates, run from 1900 through 2199, and a repeat that would step past 2199 simply ends. Completing a task creates the next occurrence when the completion syncs. Monthly repeats retain the original day, clamping to shorter months. The next occurrence resets task/checklist completion and keeps the other task settings. Each completion records when it happened, so Tasks lists completed work most recent first, 50 at a time with Show more (tasks completed before this was recorded follow). Retries and reopening the same completed task never create another successor; deleting a successor does not cause it to be recreated. Imported items follow their source calendar rather than manual repeat settings.

Task reminders use the saved reminder time zone and due time, or 9:00 AM when only a date is set. Enable browser notifications from Account on each device. Reminders require HTTPS, browser permission, server VAPID configuration and the background worker. Browser/provider availability affects delivery; reminders are not alarms.

### Background worker

Run `npm run worker` alongside the web process with the same `.env.local`, database path and VAPID keys. It periodically refreshes calendars and delivers due reminders. When a new support item arrives (a correction request, feedback, a verification request, a report or a proposal awaiting support), the owner's enrolled browsers get a generic "A new support request is waiting" push that opens `/admin` and carries no request text, names or emails. Keep one supervised worker running in production. Configure `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` as described in `.env.example`; never commit private keys. Without VAPID keys, or with keys that are malformed or do not form a pair, calendar refreshing still works and browser notification enrollment remains unavailable. Manual calendar refresh is available in the app.

The current private installation has its worker and VAPID keys configured. Local automated checks do not establish delivery to a real device; enable browser reminders in Account and test a task reminder.

## Timetable photo scanning

Students can add classes from photos of a printed or on-screen timetable (Classes → Scan timetable). A scan may carry up to three photos, for example both halves of a timetable. The browser downsizes each photo, the server sends them to any OpenAI-compatible vision model along with the school's period IDs and the grade-filtered class directory. The model can ask the server for up to six enlarged close-ups of parts of the photos (contrast-enhanced or rotated if it wants) before it answers, and it says the photo is too unclear instead of guessing; rows it is not sure of are flagged for the student to check. The student confirms or edits every row before anything is saved. A row keeps the model's directory match only when the printed name could be that class: the same words in any order, or a shortened name at the same level ("AP Chem" for "AP Chemistry"), never a different number, honors or AP level. Photos are not stored. Configure `SCAN_API_URL`, `SCAN_MODEL` and optionally `SCAN_API_KEY`, `SCAN_MODEL_REASONING`, `SCAN_MODEL_TEMPERATURE`, `SCAN_MODEL_VARIANT` (on OpenRouter `:floor`, the cheapest provider, by default) and `SCAN_ZOOM` as described in `.env.example`; the feature stays hidden until both the URL and model are set. Examples: OpenAI `gpt-6-luna`, DeepSeek `deepseek-chat`, OpenRouter (`https://openrouter.ai/api/v1`) `openai/gpt-6-luna`, or a local Ollama `qwen3-vl:8b`. Each account may run 10 scans per hour and 30 per day. The quotas count scans, not photos, so a three-photo scan uses one. Each scan is recorded in `audit_log` as `schedule.scan`. While a scan runs the student sees its steps, a timer and each close-up the model asks for: the browser sends a random `progressId` with the scan and polls `scan.progress` once a second, and the server keeps that state in memory only until the scan ends. On OpenRouter the scan also asks for a summary of the model's thinking (OpenAI models hide the thinking itself), shown as a one-line "What the scanner is thinking".

## AI task helpers (beta)

Behind the `ai-tools` beta. Schoology's calendar feed names no class for an assignment, so imported tasks arrive with no class and no priority. On Tasks, **Sort with AI** sends up to 40 open tasks with no priority (soonest due first) to a model with the student's classes, each due day's timetable (an assignment is usually due when its class starts) and up to 30 of their own tagged tasks. It suggests a priority with a short reason, and a class only when the title, notes, a teacher, the timetable or an earlier tagged task points to one; the server drops any class the model isn't sure of, so it never guesses. The student ticks what to apply, and a class is filled in only when the task has none. **Break it down** in the task sheet's checklist adds 3 to 8 steps to the draft. Nothing is saved without the student, and changes go through the normal offline task queue (`src/components/ai-tasks.tsx`, `src/server/ai.ts`).

Requests run on the server's model (`AI_API_URL`, `AI_MODEL`, `AI_API_KEY`, `AI_MODEL_REASONING`, else the scan model) with 20 sorts and 30 breakdowns per account per day, or on the member's own key with no daily quota. In Account → AI a member pastes an OpenAI, OpenRouter, DeepSeek, Anthropic or Google Gemini API key (checked with one tiny request before it is saved), or uses **Connect OpenRouter**, an OAuth PKCE flow that returns to `/tasks` with a key billed to their own OpenRouter credits. Own keys are only ever sent to the fixed provider URLs in `src/domain/ai.ts`, are stored AES-GCM encrypted with a key derived from `NEXTAUTH_SECRET` (changing it asks members to add their key again), and are never returned to the browser; Account shows the last four characters. Every account is limited to 30 AI requests an hour. Each request is recorded in `audit_log` as `ai.sort` or `ai.breakdown`. For testing, `AI_OWNER_CODEX_HOME` runs the owner's own requests on the owner's ChatGPT plan through `codex exec` (a separate Codex home signed in with `codex login --device-auth`), with tools, apps and plugins off, a read-only sandbox in an empty folder and none of the server's environment; no other account ever runs on it. **Quasar AI Plus** (`src/server/billing.ts`) raises the server-model quota to 200 sorts and 300 breakdowns a day through a Stripe subscription. The rest of Quasar and own-key AI stay free. It stays hidden until `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_PRICE_MONTHLY` are set (`STRIPE_PRICE_YEARLY` adds a yearly button). Account → AI opens Stripe Checkout or Stripe's billing portal, so no card data reaches this server. Plus turns on and off only from signed webhooks at `/api/stripe/webhook` (events `checkout.session.completed` and `customer.subscription.created`, `.updated`, `.deleted`), and the server calls Stripe's REST API with fetch, with no SDK. A failed renewal (`past_due`) keeps Plus while Stripe retries. Linking a Claude subscription is not offered (Anthropic does not allow third-party apps to use Claude.ai logins); Sign in with ChatGPT waits on OpenAI's approval.

**Duplicates.** Tasks → Duplicates (for everyone) merges copies of one assignment, most often a task the student typed and the same one imported from Schoology. One task is kept, a live calendar import first since its feed keeps updating it, and the others' class, notes, checklist steps, priority and completion move into it before they are deleted. The server does the merge (`src/server/merges.ts`, rules in `src/domain/task-merge.ts`) and keeps the tasks as they were in `task_merges`, so History can undo any merge: removed tasks nobody touched since come back with their calendar link, and the kept task goes back too unless it was edited. In the beta the AI also checks open tasks and tasks completed in the last 14 days a few seconds after new ones arrive. It asks the model only when a task is new or edited since its last check (`ai_duplicate_checks`), and merges a group by itself only when the model is sure, the group has at most three tasks, none repeats, their due dates are within two days and they don't all come from one calendar. Other groups wait under Find, and **Check with AI** runs a full check that merges nothing. Undone merges and **Not duplicates** are kept in `task_not_duplicates`, and the AI never merges those tasks together again. Checks count as `ai.dedup`, 20 a day free and 200 with Plus.

**Photo to tasks and study sets** (Plus features, in the beta). **From a photo** on Tasks reads up to three photos or PDF pages of a whiteboard, syllabus, assignment sheet or planner page (`src/server/photo-tasks.ts`, `src/components/photo-tasks.tsx`). The model gets a three-week calendar and the student's classes, and the server works out written due words itself ("Friday" is the soonest Friday from today, "next Tuesday" skips this week's) against the school's today. A class is kept only when the photo names it and the student has it. The student edits titles, dates and classes and unticks rows in a review sheet, rows with the same title and due date as an existing task start unticked, and saving goes through `state.saveTask` like a typed task (tests are saved as high priority). **Make a study set** in the sheet of a test or quiz task (`src/server/study.ts`, `src/components/study-set.tsx`) makes 10 to 25 flashcards and a 5 to 10 question multiple-choice quiz with explanations from the task's notes, pasted text and up to three photos. Sets are stored per task in `study_sets` (migration 33) with the pasted text, so Remake only needs photos again, and with the cards marked "got it" and the last quiz score. Cards flip with a tap, Space or Enter, and are marked with buttons, the arrow keys or a swipe. Both send pictures through `AiService.askWithImages`: a member's own OpenAI, OpenRouter, Anthropic or Gemini key, otherwise (DeepSeek can't read pictures) the server's scan model. Photos are never stored. Requests count as `ai.photo` (3 a day free, 60 with Plus) and `ai.study` (2 free, 60 with Plus). Everyone in the beta can use both, free accounts within those daily limits. Once billing is configured, the buttons show a small Plus tag for members without Plus.

**Do now** (for everyone) is on Today: overdue work, work due by the next school day, and high-priority work due within three days, at most five. **Upcoming tests and quizzes** (beta) on Tasks lists open tasks due in the next three weeks that the AI calls a test or quiz.

**Weekly parent summary** (beta, Plus) is a private link a parent opens without an account. Quasar has no email, so the student sends the link themselves. In Account → AI the student turns on **Share a weekly summary with a parent** and ticks what the page shows: tasks due this week and whether they're done (the only one on at first), the overdue count, upcoming tests and quizzes, and what was completed this week. The page at `/summary/<token>` (`src/server/parent-summary.ts`, `src/app/summary/[token]/page.tsx`) is rendered on the server from the synced tasks in the school's time zone. It shows the student's first name, never task notes, and nothing that isn't ticked. The token is 32 random bytes. The server stores only its SHA-256 (`parent_summary_shares`) and compares hashes with `timingSafeEqual`, so the link appears once, right after it's made. **Make a new link** replaces it and the old one stops working. Turning the switch off deletes the link and its view log. Only the student's own session can change any of this. Each view is logged with its time only (`parent_summary_views`, kept 90 days) for the "Last viewed" line. Views are limited to 30 per visitor address per 10 minutes and 60 per link per hour. The page sends `no-store`, `no-referrer` and `noindex`, and `robots.txt` disallows `/summary/`. While billing is on and the student doesn't have Plus, the page says the summary is paused and shows nothing else. An unknown, replaced or turned-off link, a suspended account, and an account outside the beta all get the same "This link doesn't work" page.

**Plan my week and time estimates** (Plus features in the beta, `src/server/plan.ts`, rules in `src/domain/plan.ts`). **Plan my week** on Today asks the model once for study blocks over the next 7 days: spaced reviews before each test or quiz and sessions before big work, for open tasks due in the next two weeks. The server offers it only real slots, which are periods in the student's own timetable with no class in them (lunch excluded) and an after-school slot of up to 150 minutes on each open school day. It then drops every block outside those slots or ending after its task is due. A date-only due date counts as due when that day starts. Blocks live in `ai_plan_blocks` (one plan per member in `ai_plans`). Today lists the day's blocks, the **Week** sheet shows the rest, and the student marks each one done or skips it. A block left unmarked after its time counts as missed and offers **Replan**, which replaces every planned block and keeps the done and skipped ones. The AI also estimates minutes for open tasks due in the next two weeks. Estimates are kept in `ai_task_estimates` by a hash of the title and notes, like the test check, so an unchanged task is never asked twice. Rows show a `~45 min` chip, and Today and Tasks show a quiet warning when a day in the coming week has more than 2.5 hours of estimated work due ("Wednesday looks heavy: 3 h 20 m. Start “Essay” Monday."). Plans count as `ai.plan` (2 a day free, 30 with Plus) and estimate requests as `ai.estimate` (10 free, 200 with Plus). While billing isn't set up, everyone in the beta can use them at the free limits. Once it is, a free account that runs out is pointed to Plus, and the buttons carry a small Plus tag.

## Schoology grades (beta)

Members in the `schoology-connect` beta get a **Grades** tab in Classes, beside the timetable. Before they connect, it offers **Connect Schoology**, which sends them to Schoology to approve Quasar (three-legged OAuth 1.0a) and brings them back to `/classes?schoology=return`. If Schoology's approval page stays blank, **Finish connecting** completes the same handshake for 15 minutes after it started.

Once connected, Grades shows one card per Schoology class: the grade Schoology reports, a ruler from that grade to the member's goal (percent cutoffs above the line, letters below), and the score the next piece of work needs. Opening a class shows its gradebook by category, the goal, and what-if scores typed next to ungraded work. On a wide screen the class opens beside a rail for switching classes; on a phone it opens in a sheet with the same switcher. Refresh and Schoology settings (the two import switches, where imported tasks go, disconnect) are the two buttons at the top right.

A goal is a letter or a custom percentage from 0 to 100 with up to two decimals (94.5 works). Letters use the common cutoffs in `LETTER_CUTOFFS`; a school with other cutoffs uses a custom percentage. The ruler, the needed score and the what-ifs all read the same number (`goalPercent` in `src/domain/grade-goals.ts`). A member who has not picked a goal sees the letter they have now as a starting point; nothing is saved until they choose. Goals are the only thing about grades Quasar stores: `schoology_grade_goals` holds one row per member and Schoology section. `schoology.setGoal` checks the beta, the signed-in account, and that the section is in the gradebook Schoology returns for that member.

Grades themselves are never written to the database. `schoology.gradebook` reads every class in one pass (the member's grades once, then each section's assignment list, four at a time) and keeps the result in the server process's memory for five minutes per member; Refresh rereads unless the last read is under ten seconds old. The cache is dropped on disconnect, on a refused token, and on restart. The math is `src/domain/grade-math.ts`: it works out whether each category is graded by total points or by average, and when it cannot reproduce Schoology's number it anchors to that number and the page says the needed scores are close estimates. Missing and incomplete work counts as zero, excused work does not count, and ungraded work in a category with no weight is listed as unable to change the grade.

Only the member's access token is kept, encrypted with `NEXTAUTH_SECRET` (migration 29). Set `SCHOOLOGY_CONSUMER_KEY` and `SCHOOLOGY_CONSUMER_SECRET` to an API key from `https://<school>.schoology.com/api`; without them the button says it isn't set up. Connections show up in the audit log as `schoology.connect`. Whether a student other than the key's owner can approve Quasar with a personal API key is unproven: one friend's approval page came up blank in October 2026.

Connected members' imported Schoology tasks also get their class from the section each assignment is in, and the two switches in Schoology settings (both on by default) add assignments straight from the API that the calendar feed doesn't bring (due from two weeks ago on, or undated and changed in that time; past-due graded ones are skipped) and check off a task once its dropbox has a non-draft turn-in. Quasar reads Schoology for tasks at most every 15 minutes per member, from the open app (`schoology.sync`) and the worker.

`tests/e2e/grades.spec.ts` drives all of this in a browser against a stand-in for Schoology's API with a made-up gradebook. `SCHOOLOGY_API_URL` points the server at that stand-in; it is honoured only for HTTPS or loopback addresses and is not set in production.

## School schedule following

Personal timetables follow shared school bell times. A recurring correction can be for the school or only for the student. Personal adjustments save changed slot fields, inherit untouched school times, and clear when the school adopts them. Matching adjustments from at least three other classmates in the same grade can suggest a school proposal. Full private timetable controls live under advanced settings and warn that school corrections will no longer reach that timetable.

A personal schedule without a saved lock preference starts locked. **Unlock schedule** requires confirmation before editing classes, assignments, or timetable settings. **Lock schedule** protects all of them again. The choice syncs with the account and survives reloads. Homework tasks stay editable.

Schedule following is available to everyone and does not depend on beta enrollment. Removing the former `schedule-following` beta does not disable it or replace saved adjustments. Existing queued edits and retry payloads keep their original revisions. Older clients that cannot read sparse adjustments receive a reload message before an incompatible write commits.

## Running a beta

A beta lets chosen members try a change on the real site (https://getquasarapp.com) before everyone gets it. There is no separate beta URL or build: the beta code ships in the normal production build behind a per-account flag. A member joins in Account → Betas, and the flagged code turns on for them on every device. Everyone else keeps the current version.

A beta is private or public. A **private** beta is joined by typing its code, so only people you give the code to get in. A **public** beta has no code: it is listed in Account → Betas and anyone can join it with a tap. Betas are private unless you ask for public.

Betas are created with a command, not from `/admin`. The command edits the beta list, `betas.json`, which sits beside the database (`data/betas.json` locally, the data volume in Docker) or at `BETAS_PATH`. The list holds the join codes in plain text, so it is gitignored and never committed. The server re-reads it whenever it changes: creating, pausing or removing a beta takes effect immediately, without a deploy or restart.

### 1. Put the change behind a flag

Pick a key: lowercase letters, numbers and dashes, such as `month-grid`. Wrap the new UI in `<Beta>` from `src/components/betas.tsx`, with the current UI as the fallback:

```tsx
import { Beta, useBeta } from '@/components/betas';

<Beta id="month-grid" fallback={<WeekSchedule state={state} />}>
  <MonthGrid state={state} />
</Beta>
```

For logic rather than a whole component, branch on `useBeta('month-grid')`, which returns true only for members in that beta. If you need the flag on the server, `new BetaService(service).joined(userId)` in `src/server/betas.ts` lists the member's betas.

`<Beta>` also catches crashes. If the beta UI throws, the member sees the fallback with a notice that offers **Leave beta** and **Report it**, not a broken page.

Keep beta changes additive. All members share one database, so any migration a beta needs runs for everyone as soon as it deploys. Add columns and tables. Don't rename or drop anything a non-beta code path still reads.

Merge and deploy as usual. Until the beta exists in the list, nobody is in it, so the deploy changes nothing for anyone.

### 2. Create the beta

Run the command in the checkout whose server should have the beta. For the live site that is the production checkout, `/srv/NAS/Private/GitHub/quasar`: the command loads `.env.local` there, so it edits the same list the live server reads.

```sh
npm run beta -- create month-grid --name "Month grid" --description "Try the month view in Schedule." --max 30
```

`--name` and `--description` are what members see in Account. `--max` caps how many people can join, so a leaked code (or a popular public beta) can't pull in the whole school. Add `--public` to list the beta in Account → Betas with no code; everything below about codes is for private betas. Leave out `--code` and the command generates one that is easy to read out, like `TQJKH-VMQWP`. Pass `--code "GRID-2026"` to choose your own: 4 to 64 letters and numbers, where case, spaces and dashes don't matter (`GRID-2026` and `grid 2026` are the same code). The command warns about codes under 8 characters, since those are easy to guess.

The command prints the code. `/admin` → **Betas** also shows every private beta's code with a Copy button, so you can look it up any time.

### 3. Testers join, leave and send feedback

- **Join.** Account → Betas → type the code → Join, or tap Join next to a public beta. Five wrong codes in ten minutes locks the account out of joining for the rest of that window.
- **Leave.** The **Leave beta** button next to each beta. No code needed. Opening `https://getquasarapp.com/?beta=off` (any view path works too) leaves every beta before the page renders, so it still works if a beta breaks the app badly enough that Account won't open.
- **Feedback.** **Send feedback** next to the beta. The report attaches the page path, screen size, theme, online status, the member's betas, their browser and the last five client errors on the page. The tester sees all of it under "Sent with your feedback" before sending. The server adds its build ID.

Feedback lands in `/admin` → Inbox with a "Beta feedback: <key>" chip and a Diagnostics section. It counts toward the same five-open-requests limit as other support requests.

### 4. Manage it

```sh
npm run beta -- list                                   # every beta, its code and status, and where the list is
npm run beta -- pause month-grid                       # the code stops working; members already in stay in
npm run beta -- open month-grid                        # the code works again
npm run beta -- new-code month-grid                    # a fresh generated code; members stay in
npm run beta -- new-code month-grid --code "GRID-2027" # or one you choose
npm run beta -- public month-grid                      # listed in Account → Betas, no code; members stay in
npm run beta -- private month-grid                     # back to a (new) code; members stay in
npm run beta -- edit month-grid --name "Month view" --max none
npm run beta -- remove month-grid                      # ends the beta: it switches off for everyone in it
```

`remove` deletes every membership for the retired beta and retires the key, and the command refuses to reuse it, so the old members can't end up in a new beta that happens to share the name.

`/admin` → **Betas** is read-only apart from **Remove** under a beta's Members, which takes one person out. It shows each beta's code, status, member count, members and open feedback. Joins, leaves and removals go to the audit log as `beta.*`.

To clean up memberships left by older versions, run `pnpm beta cleanup`. The server also deletes retired memberships when it reads the beta registry. Paused betas and public betas still have members; neither means the feature has shipped to everyone.

### 5. Ship it to everyone

Every merged change goes to everyone unless the owner explicitly asks to retain its beta after merge. A request to create or test a beta does not carry over past merge. Before merging, delete the `<Beta>`/`useBeta` branch in the PR and keep the new code path. Merge and deploy, then run `npm run beta -- remove <key>` in the production checkout. To abandon a beta instead, delete the new code path and remove it the same way.

## Staff roles

The owner is the account in `OWNER_EMAIL` (pinned by `OWNER_GOOGLE_SUB`). Other people can help run Quasar with a staff role. Each role is a fixed set of permissions, defined in `src/domain/staff.ts`:

| Role | Can do |
| --- | --- |
| `administrator` | Everything below, plus suspending accounts |
| `moderator` | Reports and their chat messages, messaging pauses, removals from a school, Global chat moderation, and the appeals against pauses and removals |
| `support` | Correction requests and beta feedback, verification, member search, opening a member's record, signing a member out and forgetting their browsers |
| `schedule-editor` | Correction requests, passed proposals, shared school timetables and names, and every school's class directory and lunch menu. Changing a school's email domains needs verification, because domains verify students |

These stay with the owner: the whole audit log, betas, mod overrides, editing a member's profile, classes, tasks, feeds and friendships, and moving a member to another school. Staff see a member's record without tasks or feeds, and without the address and browser on audit rows.

Staff never act on the owner, on other staff or on themselves. Only the owner sees reports that involve staff, whether as reporter, reported member or a sender in a group report's messages, and only the owner sees requests, removals or record entries about staff. Staff need a Google sign-in from the last two hours, like the owner, for the console and for editing other schools' directories and menus. Their actions go to the audit log and journald with their address and browser. In Global chat, staff messages carry a role badge, and a moderation note names the role ("Removed by a moderator").

Chat text that moderation took out is shown by tier: member, then moderator, administrator and owner. Support and schedule editors count as members here. Only the server censors and removes. A member is never sent what was taken out. The server keeps the rest for those allowed to read it (`src/server/moderation.ts`):

- **Slurs.** The message is stored censored, plus the text as sent. Only the owner gets that copy. In the bubble, the owner sees the censored word's asterisks, and hovering or focusing them shows the word.
- **Removed messages.** Moderators and up see a removed message's text and photo inside its dashed outline when whoever removed it ranks at their tier or below. A member's own deletion counts as a member's. A moderator sees what members and moderators removed, an administrator also sees what administrators removed, and the owner sees everything. Members never see removed text. The text is cleared after 30 days like any deleted text.
- **Edits.** A Global chat edit keeps the sender's text from before the first edit, under "See original", for the editor's tier and up. The rank kept is the highest that has edited, so a moderator's later edit can't show moderators what an administrator took out. A member's own edit would show to everyone, but members can't edit messages yet.

Roles are granted with a command, never from `/admin`. No role can grant roles in the app, administrator included. Run it in the production checkout for the live site. A change applies at the account's next request, with no deploy or restart. The account must have signed in once, and every change goes to the audit log under the owner as `staff.grant` or `staff.revoke`.

```sh
npm run staff -- roles                                  # every role and its permissions
npm run staff -- list                                   # current staff
npm run staff -- grant friend@example.com administrator # or an account ID; replaces any role they had
npm run staff -- revoke friend@example.com
```

## Continuous integration

Every push to `master` and every pull request runs `.github/workflows/ci.yml`: typecheck, the unit suite and the production build on Node 22 (the engines floor) and Node 24 (what production and the Docker image run), then the Playwright suite in Chromium against the Node 24 build. A separate job builds both Docker images (the standalone app and the `worker` target), checks that the app container answers `/api/health` and that the worker container starts. Failed browser runs upload `test-results/` (traces and screenshots) as an artifact.

## Project guide

Phase 2 verification completed on 2026-09-11: 138 unit/integration tests, all ten Chromium browser scenarios, TypeScript checking and the production build pass. Browser checks cover existing onboarding, schedule editing, offline sync, conflicts, authorization and responsive layouts, plus rich recurring tasks and completed imported calendar entries. Quasar and its background worker are running in production at https://quasar.ziona.dev/ through Cloudflare Tunnel (see [operations](docs/OPERATIONS.md)); the private health endpoint and database integrity check pass. A verified database backup was saved before deployment. Google sign-in completion, a real school feed and delivery to a real browser remain interactive pilot checks. Docker execution was not tested because Docker is unavailable on this host; CI's Docker job now builds and smoke-tests both images instead.

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

Classes → Browse school classes opens the searchable, grade-filtered directory. Select multiple classes, add them, then drag them onto school blocks (or tap a class and then a block; touch and hold to drag with a finger). Personal edits affect only your copy. Shared directory editing follows the school's permanent ten-member lock and support lock; the owner can manage directories in Support → Schools → Classes. Locked entries have a correction-request action. Directory changes and removals preserve existing personal copies.

The additive SQLite migration creates `school_classes`; existing schedules and tasks are retained. Only with the owner's explicit permission, publish their saved class names, rooms, and teachers with `node --env-file=.env.local --import tsx scripts/seed-directory.ts`. Back up first. This command uses the configured owner, is repeatable, and preserves personal class IDs, colors, assignments, and sync history. It does not publish other students' personal classes.
