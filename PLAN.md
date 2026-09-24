# Quasar - Project plan

Status: phases 1 and 2 are implemented and deployed. Phase 3 (school verification, member directory, friends, safety controls and schedule voting) was implemented on 2026-09-22. Phase 4 (friends-only chat with audited moderation, see [docs/CHAT.md](docs/CHAT.md)) was implemented on 2026-09-24. Phases 3 and 4 are running on the tailnet dev server for review before production. The real-school pilot remains launch work. See [README.md](README.md), [Fable handoff](docs/FABLE_HANDOFF.md), and [operations](docs/OPERATIONS.md). Later sequencing and acceptance gates remain proposals. The interview below is retained as product history.

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

Implemented 2026-09-22 with the following decisions, each a default the owner can change:

- Verification is per (student, school). It happens automatically when the Google sign-in address is on a school email domain that support attached to the school, or after support approves a proof request sent from the People view. Verification is dormant while the student follows another school and returns on rejoining.
- Members browse a directory of their school. Nobody can hide from it. Display name, grade, verification badge and join date are visible to every member; full names appear only when viewer and profile owner are both verified.
- Classes and the personal timetable are shared only through an accepted friendship. Requests go to schoolmates only; a crossing request becomes a friendship. Removing a friend, blocking, or support removal revokes access at once because every read re-checks the friendship. At most 30 unanswered outgoing requests.
- Blocking hides both people from each other and ends any friendship. Reports (private, at most 10 open per reporter) reach the support inbox, where the owner can dismiss them or remove the member from the school; removal drops verification and friendships, resolves open reports, and prevents rejoining.
- Voting exists only for member-locked schools (10 or more members). Verified members propose one open change each (five open per school) and vote for or against; the proposer counts as a vote for. A proposal passes at max(3, 20% of verified members, capped at 25) votes for with more for than against, and is rejected by the mirror rule. Passing applies a new unapproved revision that members review as usual. On support-locked schools a passed proposal waits for the owner, who publishes it keeping approval and lock, or declines it. A proposal is superseded when the school revision changes underneath it.
- Exit gate met: profile and schedule access matches explicit permissions, and friendship removal revokes shared access (covered by unit and browser tests).

### Phase 4: chat

Implemented 2026-09-24 from the spec in [docs/CHAT.md](docs/CHAT.md), with the following decisions, each a default the owner can change (the numbers live in the `CHAT` object in `src/domain/chat.ts`):

- Chat is one to one, between accepted friends only. A pair can chat only while they have an accepted friendship and no block in either direction. The friend request is the consent step, so strangers cannot start a chat and there is no message-request flow.
- There are no class groups, school rooms or friend groups. Class membership is self-declared, so a class room would let anyone reach minors.
- Verification is shown, not required. Every thread shows "Verified" or "Not verified" for the other person, and full names follow the phase-3 both-verified rule.
- Chats follow the friendship, not the school. Unfriending, blocking or support removal closes the chat for both people at once, because every call re-checks access.
- Chat is online only. Messages, drafts and unsent messages live in memory for the open tab and never reach IndexedDB, the offline queue, localStorage or the service-worker cache. The only chat data on the device is the unread count, its timestamp and the push setting.
- Messages are text only, up to 1,000 characters after normalization. Only `https://` links are clickable, the full URL is always shown, and the server never fetches a URL. There is no presence, typing indicator or read receipt.
- On phones Messages is an icon in the top bar, so the six-tab dock is unchanged. On desktop it is a seventh sidebar item.
- Delivery is polling over tRPC: an open thread every 4 s, the chat list every 10 s, the badge with the 15 s workspace poll. There is no SSE or WebSocket.
- Pushes are generic ("You have new messages."), sent only for messages still unread after 60 s, at most one per 10 minutes and 20 a day, never between 22:00 and 07:00 in the school's time zone. A student can mute one chat or turn off Message notifications for the account.
- Limits: 20 messages a minute, 500 a day, 20 new conversations a day. Sends are idempotent by client ID, so retries never duplicate or use up quota.
- Deleting a message hides it from both people at once. The text is kept 30 days so it can still be reported.
- A closed chat leaves a report-only row for 30 days. It looks the same after an unfriend, a block or a removal, so it cannot reveal a block. Reporting needs only past membership of the chat.
- A report freezes up to 30 messages from that one chat (or 15 before and 14 after a reported message) with a category. `danger` reports sort first and show the reporter 911 and 988. The owner sees chat text only by pressing Show messages on a report, and every view is written to the audit log. No admin procedure reads live messages.
- Support tools, lightest first: hide one reported message, a messaging pause (1, 7 or 30 days or until lifted), and the existing removal from school. A paused student can still read, mute, block and report, and is told exactly what happened.
- Display names that mention Quasar, support, admin, moderator, staff or official are rejected when new or changed.
- Retention: messages are deleted after 180 days, the text of deleted messages is erased after 30 days, report snapshots are cleared 180 days after the report is resolved, and threads idle for 180 days are deleted.
- Exit gate met: messaging scope and abuse-handling behavior are specified in docs/CHAT.md and verified by `src/server/chat.test.ts` (scope, idempotent sends, body rules without echo, rate limits, revocation, closed rows, unread counts, cursors, reports, the admin procedure allowlist, pauses, account binding, retention, reserved names, migration), the `deliverChat` cases in `src/server/notifications.test.ts`, the worker order in `src/server/jobs.test.ts`, and the five browser scenarios in `tests/e2e/chat.spec.ts`.

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
