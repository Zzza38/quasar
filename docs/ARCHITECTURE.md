# Phase 1 architecture

## Persistence and authorization

SQLite with WAL runs on the existing server using `better-sqlite3`. This avoids another database service for an initial single-server pilot. Transactions serialize membership counts, schedule revisions, entity writes, history and retry receipts. The schema is initialized idempotently and records migration version 1; future schema changes must add explicit migrations. Use local storage with reliable locks. The repository happens to live under `/srv/NAS`; put the database on local disk or a local Docker volume, not an NFS/SMB mount.

Google OAuth is the only authentication provider. A verified Google email is required. Google subject identifies the account; both names must be entered before onboarding mutations. JWT sessions are encrypted and expire after 30 days. Owner privileges are checked against `OWNER_EMAIL` server-side on every admin operation. School verification is separate (see phase 3 below); Google email verification does not by itself mark a student school-verified.

All tRPC workspace, school and personal operations require a session. The service scopes records and receipts by the authenticated owner. A supplied user ID cannot change this. JSON POSTs additionally require a same-origin `Origin`. No authenticated API responses enter the service-worker cache. The `/` page is a public shell populated after authentication. Local account data intentionally remains readable while offline until explicit signout; do not use a shared browser profile for confidential offline data.

Only members may edit their current school's unlocked default. The tenth distinct member permanently sets `member_locked`, including if membership drops later. Support locks are separate and owner controlled. Owners can correct either lock. Every default revision is retained. Unapproved defaults require explicit selection. Member edits revoke approval; an owner can approve and lock. Creation does not automatically join or select a schedule. The support inbox accepts schedule evidence/links as text; formal evidence criteria remain a pilot policy decision.

## Scheduling rules

`src/domain/schedule.ts` is shared by client, server validation and tests. `exampleSchedule` provides a ten-day example; no cycle length is hardcoded.

- Periods have stable IDs and kind `class`, `lunch`, or `other`; a student's class assignment follows that period through the rotation.
- Cycle days have stable IDs and ordered, non-overlapping slots. The same period may appear in more than one slot, supporting a class split around lunch. Lunch waves can be separate lunch period IDs.
- The anchor names the cycle day on a calendar date. Advancement occurs after that date. Attendance weekdays and advancement weekdays are independently configurable (ISO weekdays Monday=1 through Sunday=7).
- Closures explicitly pause or advance the cycle. Replacement dates provide special slots and an advancement decision. Reset exceptions select the cycle day for that date and following dates, supporting term transitions, and may include special slots or a closure. The latest reset or anchor on/before a date determines rotation; dates before the earliest anchor are calculated backwards.
- Precedence is school rotation, school exception, personal cycle override, personal date override. Cycle overrides preserve school closures. A personal date override may reopen a date. Personal changes do not advance the shared rotation.
- A private custom schedule replaces the school default for that student. Overrides apply on top of the selected schedule.
- All dates use the school's IANA time zone. Repeated fall DST times use the earlier occurrence; nonexistent spring times are reported and skipped. Impossible/cross-midnight shifted slots are retained in storage and reported as issues, rather than causing the app to crash.
- Current period is shown until its end alongside the next future period, including lunch and unassigned periods. Search is bounded to 370 days by default; empty calendars return no upcoming period.

Schedule and personal objects use strict validation, stable IDs and real dates. Advanced editors currently expose those JSON objects; Fable can build structured editors on the same schemas. Changing a school's period or cycle ID is a semantic change, not a rename.

## Offline queue and conflict handling

Entities are either tasks (one per ID) or the `personal` document (classes, assignments, overrides, optional custom schedule). Versioned tombstones preserve deletion information. The API returns a full account snapshot including tombstones. IndexedDB persists the account's baseline, optimistic local entities, queue, conflicts, cached workspace metadata and retry state. Reloading does not remove pending edits. Local storage failure is reported before an edit is treated as saved.

Every queued operation has a random mutation ID, a base entity revision and the intended data or deletion. Once first attempted, the wire payload stays fixed until a reply is processed. Server receipts make lost responses and retries idempotent. Reusing an ID with different data is rejected. Server history validates the supplied base revision. Unsent changes following an earlier local edit are rebased onto its acknowledged server entity.

Three-way merging applies independent field changes. Collections with stable identities can merge changes to distinct entries. Competing edits to a field, edit/delete races and incompatible ordering become explicit conflicts. Merges that violate model invariants also become conflicts (for example, one device deletes a class while another assigns it). The local intent, base and server value are retained until the student chooses. A resolution sends a new operation against the current revision and can conflict again if another device changes it first. Conflict receipts preserve repeatability; they never overwrite server data.

School schedule corrections are independent of personal records. Membership stores the last reviewed school revision. Workspace snapshots include the old and current default until review acknowledgment. The shared domain helper flags removed period/day targets and shared changes under personal overrides; acknowledgment preserves all personal overrides. Fable can present the same retained values with more focused editing controls.

Service-worker cache contains only the public shell and static assets. Account changes are verified before uploads and the server binds each upload to the expected account. Signout requires connectivity and clears local account data only after server logout succeeds and pending changes have been saved or explicitly discarded. No OAuth credentials or tokens are stored in IndexedDB.

## Operational limits

This is a single-server SQLite implementation. History and receipts are intentionally retained so a long-offline device cannot lose its merge base; monitor disk growth and design a device-aware retention policy before pruning. Full snapshots and up to 100 school search results suit the pilot; pagination/delta sync are future scaling work. There is no capacity claim before load testing. See the operations checklist for backups, monitoring and migration triggers.

## Phase 2: calendar feeds, repeat tasks and reminders

Calendar subscriptions belong to one account. The server encrypts private feed URLs with AES-256-GCM using a key derived from `NEXTAUTH_SECRET`; listings and errors never return URLs. Back up that secret with the database: changing it requires re-adding subscriptions. Fetching permits only public HTTPS hosts on port 443, validates every DNS answer and redirect, pins the approved destination, and limits time and body size. The saved feed content is private database data, just like imported tasks.

The worker checks due subscriptions every minute and refreshes successful feeds every 30 minutes. Failures back off from five minutes to six hours without changing saved items. A conditional HTTP 304 still expands cached calendar content so the rolling window advances. Parsing covers the previous 90 days and next 365 days in the chosen calendar time zone. Unsupported subdaily recurrence, RANGE overrides, period-valued RDATE, malformed calendars and compressed responses fail the refresh as a whole.

Each imported task is identified by subscription, UID and recurrence ID. Repeated refreshes preserve completion and personal fields. Source-only changes update title, notes and deadline; competing local changes create a version-checked choice in Connected calendars. Missing or cancelled occurrences within the active window remain visible with a removed-source label. User-deleted tasks remain deleted. Removing a subscription detaches its surviving tasks instead of deleting them. Imported calendar placement follows source times even when a personal deadline differs.

Completing a manually recurring task creates its next occurrence inside the same transaction as the sync receipt. A permanent parent/successor record prevents duplication after retries, reopening or deleting a successor. Daily, weekly and monthly repeats preserve their original monthly anchor through short months. Offline completion creates its successor when synchronized.

Browser reminders require explicit enrollment per browser. Mutations bind to the original account, and sign-out removes the browser subscription. Notifications contain generic text, never task titles. The worker uses durable delivery records, a five-minute retry lease and at most five attempts, removes expired endpoints, and ignores completed/deleted/source-removed tasks and reminders over 24 hours late. Delivery is best effort; a crash after provider acceptance can retry the same notification, whose stable tag collapses visible duplicates. Date-only reminders use 09:00 in the saved reminder time zone; DST gaps move forward and folds use the first occurrence.

## Phase 3: verification, community and voting

Schema migration 4 adds `school_verifications`, `verification_requests`, `friendships`, `blocks`, `reports`, `school_bans`, `schedule_proposals`, `proposal_votes` and `schools.email_domains`. Rules live in `src/server/community.ts` and `src/server/proposals.ts`; every read re-derives access from the current rows, so there is no cached permission to invalidate.

- Verification is keyed by (user, school). `join` verifies automatically when the account's email domain matches one of the school's domains (exact or subdomain); otherwise students send a proof text that the owner approves or declines in the admin page. Three declines in a week block further requests.
- Friendships are stored once per unordered pair (`user_low`, `user_high`) with the requester and a `pending`/`accepted` status. A profile returns the friend's classes and personal schedule document only when the pair is `accepted`; the client renders the friend's day with the shared domain resolver. Requests require the same school and neither side blocking; accepted friendships persist across school changes but never reveal more than the friendship allows.
- Blocks are directional rows; either direction hides both members from each other's directory and profile, except that the blocker can still open the blocked profile to lift the block. Reports and support removal (`school_bans`) are owner-reviewed; a ban clears the student's school, verification and friendships and rejects future joins to that school.
- Proposals store the full school schedule (all grades) at a base revision. Votes are upserted per member; the tally runs inside the same transaction and applies a passing proposal as a new `school_revisions` row with `approved=0`, or parks it as `awaiting-support` when the school is support-locked. Any revision change supersedes open proposals. Thresholds derive from the count of verified members at tally time.
- Workspace payloads include a small `community` summary (verification status, incoming request count, friend count) for badges; directory and proposal lists are fetched on demand and are never cached by the service worker.
