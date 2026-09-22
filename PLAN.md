# Quasar - Project plan

Status: phase-1 backend and functional application flows implemented (2026-09-11). Visual design and structured schedule editors are handed to Fable; live Google OAuth configuration, deployment, and the real-school pilot remain launch work. See [README.md](README.md), [Fable handoff](docs/FABLE_HANDOFF.md), and [operations](docs/OPERATIONS.md). Later phase sequencing and acceptance gates remain proposals. The interview below is retained as product history.

Build a free web app for US high-school students that makes the next class and upcoming tasks immediately clear, with dependable schedule setup and offline editing. Start with the personal tracker, then expand into calendar integration and school community features.

## Confirmed direction

- Build a Saturn clone, but better.
- Build for any school, rather than a single school or friend group.
- Initial audience: US high-school students. Broader school support remains the long-term direction.
- Define the intended product before implementation.
- The daily opening view should show upcoming to-dos and the student's next class.
- UX is the highest product priority and intended reason to switch.
- Reliability is central to the desired improvement: the user describes Saturn as glitchy and inconsistent.
- Launch as a web app first. The user wants to avoid paying for an Apple developer license for now.
- The schedule tracker must be valuable on its own. School-member browsing is requested; chat is deferred to a later release.
- Support any personal task, not just homework.
- Product name: **Quasar**.

## Scheduling and school setup

- A student can add a school if it does not exist, enter its schedule, and edit its days.
- Support school-specific cycle lengths and rotation advancement rules, including how weekends, holidays, and closures affect the cycle. Do not hardcode a 10-day cycle.
- The user's school is a required example: a 10-day rotating schedule. Classes are assigned stable period letters or numbers; each rotation day determines which periods occur and in what order. For example, A can be first on day 1, absent on day 2, and in the middle on day 3.
- Lunch is modeled as a period.
- Schedule setup includes configurable cycle days, ordered periods with start/end times, a starting date and cycle day, and date-specific exceptions.
- Students can shift or override their personal schedules without changing the school's default, including when the default is locked.
- Preserve personal overrides when support updates the default schedule; flag conflicts for the student instead of silently discarding overrides.
- At 10 or more school members, direct member editing of the default schedule locks. In phase 1, corrections go through support; voting is deferred to a later phase.
- Latest decision: remove the organizer role. Users instead contact support to create the correct school schedule and lock it.
- Support must approve changes to a support-locked schedule; a vote alone cannot change it.
- The project owner handles support at launch.
- Students may use an unreviewed school schedule, but it is not selected by default. When no approved default exists, onboarding asks them to explicitly choose a community schedule or build their own.
- Phase 1 includes a basic admin page for the project owner to review schools, edit/correct schedules, and lock them. Admin access must be enforced on the server.
- Still to define: evidence required for school schedules, detailed exception-editing behavior, and later-phase voting rules.

## Accounts and school community

- Google sign-in is required before using the app. School verification is separate from authentication.
- Joining a school requires selecting it; verification is separate and optional for joining.
- Verification requires a school email or other proof. Accepted alternative proof and review procedures remain open.
- Users provide display names and full names. Full names are visible only when both the viewer and the profile owner are verified at the school.
- Unverified members can browse profiles with limited information. The exact fields visible to them remain to be defined.
- In the later community phase, users can browse profiles of other members of their school. Classes and schedules are visible only through friendship; exact acceptance and sharing controls remain open.
- Members cannot completely hide from the school directory. The user's intent is to discourage anonymous scouting. This visibility rule alone does not prevent scouting; the exact limited profile fields and access controls must be resolved before community launch.
- Chat is desired for a later release; it is outside the initial release scope.
- Still to define: limited profile fields, alternative verification procedures, friendship permissions, and member reporting/removal.

## Offline use and synchronization

- Previously signed-in users can view and edit saved schedules and tasks offline, including completing tasks.
- Persist offline changes locally until they can be uploaded after connectivity returns.
- Proposed reliability criteria: queued edits survive reloads, retry safely, and show whether changes are waiting to sync or saved remotely.
- When devices make conflicting edits, let the user choose the resolution rather than silently taking the latest edit. Preserve the competing values until resolved. Non-conflicting edits should synchronize without a choice prompt.
- Shared school corrections preserve personal overrides and surface any conflicts as described above.

## UX and design ownership

- Prioritize a clearer home screen and visual polish alongside reliability.
- The home screen must surface the next class and upcoming to-dos.
- The user intends Fable 5.1 to handle most UI work. Codex may contribute UI mockups or small touches; this records the user's workflow preference and does not initiate a handoff.

## Tasks and calendar integration

- Track general tasks, including homework.
- Phase-1 tasks have a title, optional due date/time, optional class association, notes, and completion status.
- Subtasks, recurring tasks, and priorities are desired after phase 1.
- Desired integration: iCalendar (.ics/iCal) support. The user reports that Schoology exports iCal and wants homework from that feed to appear in the app.
- Imported homework should appear both as checkable to-dos and calendar events.
- Users can paste an iCal feed URL and have it refresh automatically.
- Completing an imported task leaves its calendar entry visible but grayed out.
- Automatic iCal sync is deferred beyond the first release.
- Reminders and notifications can wait until after phase 1; their later placement remains open.
- Refresh frequency and handling source edits/deletions remain undecided. Schoology feed contents have not yet been verified.

## Reliability requirements

Observed problem in Saturn, as reported by the user: periods worked, but adding certain classes and a lunch wave failed or crashed the app. The workaround was to add entries, restart, hope they synced, and repeat for broken classes. The cause is unknown.

Proposed acceptance criteria derived from this problem, to refine during specification:

- A student can add classes and lunch waves, reload the app, and see the saved configuration intact.
- The UI clearly distinguishes saving, saved, and failed states; a student never has to guess whether a change synced.
- Failed saves preserve entered information and allow retry without restarting or creating duplicates.
- Coverage includes different class and lunch configurations, not just generic period creation.

## Competitive position

- User perspective: Saturn benefits from Snapchat marketing and Snapchat integration. This is interview input, not independently verified competitor research.
- Intended advantage: a better user experience, including dependable daily use.
- Open challenge: define an advantage compelling enough to attract students despite Saturn's existing reach and integrations.
- Acquisition strategy and any social or Snapchat integration requirements remain undecided.

## Working assumptions to validate

- “Saturn” refers to the school schedule and student social app.
- Initial audience is US high-school students, on web. Pilot size, launch date, and later-phase details remain undecided.

## Hosting and operations

- Initially host on the user's existing server. The user reports sufficient capacity for a large workload; capacity has not been measured as part of this planning interview.
- Move to cloud infrastructure if and when needed; cloud hosting is not a launch dependency.
- The project owner handles schedule support.
- Deployment setup, domain, backups/restoration, monitoring, and a capacity-based migration trigger remain to be specified before launch.
- No numerical operating budget has been set; the preference is to use existing infrastructure.

## Phased delivery

The user requested phases and established the phase-1 boundaries below. Later phase ordering and acceptance gates are proposed; dates are not set.

### Phase 1: dependable personal schedule and tasks

- Required Google sign-in and name entry; select an existing school or create a missing school and schedule.
- School-specific rotations, period-to-class assignments, lunch periods, calendar exceptions, and personal overrides.
- Use an unreviewed schedule through explicit selection; support can establish and lock the default schedule.
- Enforce the 10-member edit restriction and support locks; corrections go through support, with voting deferred.
- Provide a basic owner-only admin page to review schools, edit/correct schedules, and lock them.
- Clear, polished home screen with next class and upcoming tasks; manually create, edit, and complete general tasks with title, optional due date/time, optional class association, and notes.
- Offline viewing, editing, and task completion with persistent queued synchronization.
- Exit gate: representative rotation and exception dates produce the correct next class; class/lunch edits survive reloads; offline edits upload without loss or duplicates; conflicting edits present a user choice; shared corrections preserve personal overrides and flag conflicts; shared locks and admin permissions are enforced.
- Launch for US high-school students using the existing server.
- Excludes automatic iCal sync, member browsing, friendship sharing, chat, reminders, notifications, voting, subtasks, recurring tasks, and task priorities.

### Phase 2: connected homework and calendar

- Implemented richer task tools: checklists with stable item IDs, daily/weekly/monthly recurring tasks, priority filtering/sorting, and opt-in browser push reminders. Recurrence is generated once when completion syncs; reminders require server keys and a running background worker.
- Subscribe to iCal URLs and refresh automatically.
- Show imported homework as both tasks and calendar entries; completed items stay visible, grayed out.
- Preserve completion and personal task fields during refresh. Source changes conflicting with locally edited details require a choice; removed source items stay marked as removed, and refresh failures preserve saved data. Subscription removal keeps imported items as regular tasks.
- Exit gate: repeated refreshes do not duplicate items or reset completion, and source changes follow documented rules.

### Phase 3: school profiles and friends

- Proposed placement for schedule-change voting. Define voter eligibility, threshold, and proposal handling; support approval remains required for support-locked schedules.
- School-email verification and an alternative proof route.
- Browse school profiles with the agreed name visibility rules; no complete directory hiding.
- Friendship-based access to classes and schedules.
- Define and implement verification permissions, reporting, blocking, and support removal before exposing the directory. These controls are proposed work, not yet agreed product details.
- Exit gate: profile and schedule access matches explicit permissions, and friendship removal revokes shared access.

### Phase 4: chat

- Add chat after the personal tracker and community foundations are working.
- Decide whether chat is between friends, class groups, or school groups; define messaging permissions and moderation before implementation.
- Exit gate: messaging scope and abuse-handling behavior are specified and verified.

## Product interview

This section preserves interview history. The product sections above describe current decisions and supersede earlier proposals.

### Round 1: audience, problem, and differentiation

1. Who is the first audience: you and your friends, your entire school, or students across schools? What age group?
2. What are the three most frustrating things about Saturn? Describe actual situations, and distinguish things you have experienced from things you suspect.
3. What should a student accomplish in their first five minutes, and what brings them back every school day?
4. If the first release could do only one thing exceptionally well, what would it be? Which Saturn features are essential, and which should be excluded?
5. Why would someone switch if their friends stayed on Saturn? Should this be useful alone, depend on a school community, or both?

Answers so far:

1. Serve any school long-term. Round 6 sets the initial audience to US high-school students.
2. Saturn is glitchy and does not always work. The concrete class/lunch setup failure is documented above.
3. Show upcoming to-dos and the next class immediately.
4. UX is the essential priority. Required and excluded first-release features were established in subsequent rounds.
5. Win users through UX. The user sees Snapchat marketing and integration as Saturn's strengths; a concrete switching incentive remains unresolved.

### Round 2: make UX concrete

1. What specific Saturn failure should we fix first? Describe what you tried, what happened, and what should have happened.
2. Beyond reliability, which UX improvement matters most: fewer taps, a clearer screen, faster task entry, or visual polish? Other priorities are welcome.
3. Where do to-dos come from initially: manual entry, school-system imports, or classmates? What counts as a to-do?
4. When the first student from a new school joins, who supplies the bell schedule and their classes? How much setup is acceptable?
5. Would a first release with schedules and to-dos, but no social features, be worth using? If not, which social capability is essential?
6. Which platforms must the first release support: iPhone, Android, web, or a combination?

Answers:

1. Certain classes and lunch-wave setup failed or crashed despite periods working; restarts and repeated attempts were needed.
2. Subsequently resolved: clearer home screen and visual polish.
3. Any task; iCal support is desired for Schoology homework.
4. Students create missing schools and schedules. The original organizer proposal was superseded in round 3; current rules are in Scheduling and school setup.
5. Yes, a good schedule tracker is useful without social features.
6. Web first, to avoid paying for an Apple developer license for now.

### Round 3: schedule rules and shared ownership

1. What does a real week at the user's school look like, including rotations, lunch waves, and exceptions?
2. When does a school schedule lock, and who can still change it?
3. Who can vote, what passes a change or organizer removal, and who becomes the replacement organizer?
4. Can students override their own schedule without modifying the shared school schedule?
5. Should iCal be a one-time file import or a feed that stays updated, and should its entries behave as checkable tasks or calendar events?
6. Beyond reliability, which two UX qualities matter most?

Answers:

1. A 10-day rotation with classes mapped to stable period identifiers; periods change order or do not meet on particular days. Round 4 clarifies school-specific cycles and lunch as a period.
2. Personal shifts are allowed; at 10 or more members, changing the default requires a vote.
3. Remove organizers. Contact support to create the correct schedule and lock it. Round 4 confirms support approval is required for changes to a support-locked schedule.
4. Yes, personal overrides are allowed.
5. Both checkable to-dos and calendar events. Round 4 confirms automatic feed updates.
6. Clearer home screen and visual polish. Fable 5.1 will handle most UI work, with Codex permitted to make mockups and small touches.

### Round 4: resolve schedule edge cases and launch operations

1. Can students create and use a school immediately while waiting for support, and can a vote change a support-locked schedule?
2. Who handles support at launch, and what should students provide to establish the correct schedule?
3. Do weekends, holidays, and unexpected closures pause the 10-day rotation or follow a published calendar?
4. How do lunch waves split a class, and does a student's wave vary by class or rotation day?
5. Should iCal subscriptions refresh automatically, and should completing an imported task leave its calendar entry visible?
6. Must students sign in before trying the app, and must saved schedules work without an internet connection?

Answers:

1. Support must approve changes to a support-locked schedule. Rounds 5–6 confirm explicit selection of unreviewed schedules is allowed.
2. The project owner is support. Required supporting evidence remains unanswered.
3. Cycle length and advancement rules vary by school; 10 days is an example, not a universal requirement.
4. Lunch is just a period.
5. Automatically refresh iCal feeds. Completed items remain on the calendar, grayed out.
6. Require sign-in and names; allow browsing other members of the same school. Add chat later. Round 5 confirms offline editing and synchronization.

### Round 5: membership, visibility, and release boundaries

1. What proves school membership, and which sign-in methods should be available?
2. Are names full names or display names, what can schoolmates see, and can students hide from the directory?
3. Can students use a newly created school while support review is pending?
4. Should an already signed-in student be able to view saved schedules and tasks offline, and make changes offline?
5. Are automatic iCal sync and the school directory required for the first release? Are reminders also required?

Answers:

1. Select a school to join. Verification requires a school email or other proof. Round 6 selects Google sign-in.
2. Browse profiles; classes and schedules require friendship. No complete directory hiding, motivated by concern about scouting. Round 6 clarifies that both viewer and owner must be verified for full-name visibility; unverified members see limited profiles.
3. Yes, unreviewed schedules can be used, but are not selected by default.
4. Offline editing and completion are required; store changes until uploaded.
5. Break delivery into phases. Automatic iCal sync and member browsing are not essential initially. Round 6 also defers reminders.

### Round 6: phase boundaries and remaining permissions

1. Does the proposed phase order fit, and are reminders needed in phase 1?
2. Does verification gate the viewer, the profile owner, or both for name visibility, and can unverified users browse profiles at all?
3. What should a new member see when their school has no approved default schedule?
4. What sign-in method, initial age group, launch geography, and operating budget should phase 1 target?

Answers:

1. Reminders can wait until after phase 1. The full proposed phase order has not been explicitly confirmed.
2. Both viewer and profile owner must be verified for full-name visibility. Unverified users can browse profiles with limited information.
3. Yes: offer an explicit choice of community schedule or building a personal schedule when no approved default exists.
4. Google sign-in; US high-school audience; host on the existing server, moving to cloud infrastructure only when needed. No numeric budget specified.

### Round 7: finish defining the first release

1. Should phase 1 include voting, or defer voting while retaining the 10-member lock and support-approved corrections?
2. Which task fields and behaviors are essential: due dates/times, class association, notes, subtasks, recurrence, and priority?
3. Who will pilot the first release, by when, and what concrete result would make it successful?
4. Is the product free, eventually paid, ad-supported, or undecided?

Answers:

1. Defer voting; retain the 10-member lock and support-approved corrections in phase 1.
2. Accept title, optional due date/time, optional class, notes, and completion. Add subtasks, recurring tasks, and priorities in later phases.
3. The project owner will test and recruit additional testers. No date, tester count, or explicit success threshold was specified.
4. Free for now; longer-term monetization is undecided.

### Round 8: final implementation preferences

1. Product name: subsequently confirmed as **Quasar**.
2. Preferred stack: Next.js, TypeScript, Tailwind CSS, and tRPC. The user is open to complementary modern tools; no additional library or service is mandated.
3. Schedule editor proposal accepted: configurable cycle days, ordered periods with start/end times, a starting date/day, and date-specific exceptions.
4. Preserve personal overrides after shared corrections and flag conflicts.
5. Let the user choose when edits conflict.
6. Include a basic admin page for school review, schedule editing, and locking in phase 1.

The user requested this final plan update and will start implementation in another thread.

## Pilot and business model

- The project owner is the first tester and will recruit other testers.
- Free for now; no decision on eventual paid features, advertising, or other monetization.
- Pilot date and tester count remain unset.
- Proposed pilot evaluation: use real school schedules across a full rotation; verify next-class accuracy, class/lunch setup, task management, and offline recovery. Collect feedback on home-screen clarity and visual polish.
- Product acceptance criteria above are proposed checks, not completed validation or user-agreed numerical success targets.

## Implementation decisions

Use Next.js, TypeScript, Tailwind CSS, and tRPC, with Google sign-in and hosting on the existing server. Phase 1 now uses NextAuth for Google OAuth, SQLite with versioned records and transactions, IndexedDB for offline storage, and a public-shell service worker. Docker packaging and backup/pilot instructions are included. The private installation and its phase-2 background worker are running at https://home-server.tail210f05.ts.net:3003/.

Compatible package versions are pinned in `package-lock.json`. Database access uses parameterized SQL without an ORM. The phase-2 implementation passes 138 unit/integration tests, all ten browser scenarios, TypeScript checking, and the production build. Live Google authorization and Docker container execution remain untested here; browser tests use isolated encrypted session fixtures without adding a production authentication bypass. Implementation details and resolved schedule/synchronization rules are recorded in [architecture](docs/ARCHITECTURE.md).

### Suggested implementation order

1. Inspect repository instructions and runtime constraints; establish the requested stack, persistent data model, Google sign-in, and owner/admin authorization.
2. Build and validate the scheduling model: configurable rotations, date anchors, period times, lunch, exceptions, and school time zones.
3. Implement school selection/creation, explicit unreviewed-schedule selection, the 10-member lock, personal class assignments and overrides, and the admin review/edit/lock flow.
4. Implement basic tasks and the next-class/upcoming-task home screen, keeping most visual design work aligned with the intended Fable 5.1 workflow.
5. Complete offline persistence, queued synchronization, user-selected conflict resolution, and preservation of overrides after default changes. Account for offline requirements in the data model from the start.
6. Verify phase-1 acceptance criteria and prepare the existing-server deployment and pilot instructions.

### Details to settle during implementation

- Data model and synchronization mechanics, including edit/delete conflicts and how unresolved conflicts are presented.
- School time zones, exception precedence, cycle advancement options, and term transitions within the agreed schedule model.
- Who can edit unlocked defaults, how the 10-member lock persists if membership later drops, and support-review evidence.
- Admin account setup and the home-screen/schedule-entry layouts.

Before pilot launch, establish Google authentication configuration, domain/deployment setup, backups and restoration, monitoring, and concrete pilot acceptance checks. These operational details do not prevent starting local implementation. Later-phase permissions and integrations can be specified when those phases are designed; retain the phase-1 exclusions.
