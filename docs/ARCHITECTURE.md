# Phase 1 architecture

## Persistence and authorization

SQLite with WAL runs on the existing server using `better-sqlite3`. This avoids another database service for an initial single-server pilot. Transactions serialize membership counts, schedule revisions, entity writes, history and retry receipts. The schema is initialized idempotently and records migration version 1; future schema changes must add explicit migrations. Use local storage with reliable locks. The repository happens to live under `/srv/NAS`; put the database on local disk or a local Docker volume, not an NFS/SMB mount.

Google OAuth is the only authentication provider. A verified Google email is required. Google subject identifies the account; both names must be entered before onboarding mutations. JWT sessions are encrypted and expire after 30 days. Owner privileges are checked against `OWNER_EMAIL` server-side on every admin operation. School verification and community profiles remain phase 3 work; Google email verification does not mark a student school-verified.

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
