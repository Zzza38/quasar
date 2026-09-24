# Quasar phase 4: chat implementation spec

**Status (2026-09-24):** Implemented in full (no §8 scope cuts), and this document now describes the shipped behavior; the review round's clarifications are folded in below. It started as the final phase-4 design. It starts from the winning "reliability" draft and adds the judges' grafts from the "safety" and "ux" drafts. Where the judges disagreed, the spec picks one answer and gives the reason in a sentence. Every number and switch is a default the owner can change later. The constants live in one `CHAT` object at the top of `src/domain/chat.ts`. The phase-4 exit gate is "messaging scope and abuse-handling behavior are specified and verified". Sections 2, 3 and 9 cover it. A completeness review against the code (same day) fixed the places where an implementer would have had to guess. The main changes: body validation now happens in the service, so errors are fixed strings and not zod JSON. The unread count uses server-stamped newest-wins, with no `use-workspace` change. Thread sizing uses a scoped `visualViewport` hook, which also covers iOS. Admin chat mutations are account-bound. The retention SQL is indexable. The racy lost-response e2e step is gone.

Sources read before writing:
- `PLAN.md`, `docs/ARCHITECTURE.md`, `docs/FABLE_HANDOFF.md`, `AGENTS.md`
- in `src/server`: `community.ts`, `router.ts`, `db.ts` (migrations 1–5), `service.ts`, `notifications.ts`, `jobs.ts`
- `scripts/worker.ts`, `src/app/api/trpc/[trpc]/route.ts` (its `onError` logs `error.message`), `src/app/layout.tsx`, `src/lib/format.ts` (date-only helpers, no instant formatter), `src/hooks/use-mobile.ts` (the shadcn sidebar switches to a sheet below 1024 px, the same `lg` breakpoint as the dock)
- in `src/components`: `views/people.tsx`, `shell.tsx`, `app-state.ts`, `tracker.tsx`, `use-workspace.ts`, `admin.tsx`, `notification-settings.tsx`, `primitives.tsx`
- `src/client/api.ts`, `public/sw.js`
- `tests/e2e/community.spec.ts`, `src/server/community.test.ts`, `src/server/jobs.test.ts`
- Next's `Viewport` type: `interactiveWidget: 'resizes-visual' | 'resizes-content' | 'overlays-content'` exists in `node_modules/next/dist/lib/metadata/types/extra-types.d.ts`.

---

## 1. Decisions

**D1. Chat is one to one, between accepted friends only.** A pair can chat only while two things hold: they have a `friendships` row with `status='accepted'`, and there is no `blocks` row in either direction. The friend request is the only consent step Quasar already has. Both people agree to it, either can end it, a block deletes it, and support removal deletes it. Reusing it has three effects:
- strangers, including an adult who joined a school, cannot start a chat;
- there is no new "message request" flow;
- the existing cap of 30 pending requests already limits mass outreach.

*Owner can change:* allow message requests from verified schoolmates. That needs its own consent step and is not in this phase.

**D2. There are no class groups, school rooms or friend groups in this phase.** Class membership is self-declared free text, so anyone can type "Algebra II, period A" and join. A class room would let people scout and harass minors. The ux draft tried a room where each person sees only their friends' messages, which splits one room into different views ("Cara sees the question but not Bob's answer"). A school-wide room needs moderation that one owner cannot give. Groups would also roughly double the permission surface. *Owner can change:* a later phase can add friend groups of up to 10, where every member is friends with the creator and nobody in the group has blocked anyone else.

**D3. Verification is shown, not required.** Many pilot schools have no email domain, so requiring verification would leave chat empty. Every thread header shows the other person's "Verified" or "Not verified" chip. It also shows their full name under the phase-3 rule: only when both people are verified. *Owner can change:* set `CHAT.requiresVerification = true`. Both people must then be verified at their current schools to read or send.

**D4. Chats follow the friendship, not the school.** Phase-3 friendships survive a school change, and chat does the same. Support removal (`removeFromSchool`) deletes every friendship the removed student has, so it closes all of their chats. *Owner can change:* also require the same current school.

**D5. Chat is online only. Nothing about chat is stored on the device except one number.** Messages, drafts and unsent messages exist only in memory for the open tab. They never enter IndexedDB, the offline mutation queue, localStorage or the service-worker cache. The only chat data that lives on the device is in the cached workspace context: `unreadChats`, a number, plus its `unreadAt` timestamp and the `chatPush` flag. None of them contains any text. The badge is still hidden while offline, so it never shows a stale count as if it were current. Private messages must not outlive the session on a shared school computer.

**D6. Support sees chat text only through a report, and every view of it is audited.** A report freezes a snapshot of at most 30 messages from that one conversation. The owner has to press **Show messages** to see it. That button is a mutation, `admin.showEvidence`, which writes a `reports.view` row to `audit_log`. No admin procedure reads `chat_messages.body`. Support has no chat account and never sends messages. The owner's own Google account can chat like any student, and owner privileges add no chat reads. A router-shape test locks this in (§9).

**D7. A closed chat leaves a report-only row for 30 days.** A chat can close by unfriending, a block in either direction, or support removal. Both participants then keep a row in their list until 30 days after the last message. The row shows only the other person's display name, the text "Chat closed" and one **Report** button. It has no history and no composer. It looks the same whether the chat closed by unfriend, by block or by removal, so it cannot be used to check "did they block me?". This closes the harass-then-leave escape. `community.profile` returns `NOT_FOUND` when the other person blocked the viewer, and also when the two are not friends and not at the same school. Without this row, a victim would have no route to the evidence. This is the one deliberate exception to the phase-3 rule "a block hides both people from each other". The row shows only a display name the viewer already chatted with. It never links to a profile, and it reveals nothing new. The blocked person also keeps a row. The judges raised retaliatory reports against the blocker. That risk is accepted, for three reasons:
- the snapshot contains both sides, so the owner sees who started it;
- the report-history line flags people who report a lot;
- the per-thread and per-reporter report caps apply.

*Owner can change:* `CHAT.closedRowDays`.

**D8. Delete hides a message from both people at once, but the text is kept 30 days for reports.** This stops someone from sending a threat and deleting it before anyone reports it. The delete dialog says so. *Owner can change:* `CHAT.deletedTextDays`.

**D9. Messages are text only. `https://` links are clickable. Nothing is ever fetched.** There are no images, files, reactions or previews. An `https://` URL renders as `<a href target="_blank" rel="noopener noreferrer nofollow ugc">`, and the link text is always the full URL, so the host is always visible. `http://`, `javascript:`, `data:` and every other scheme stay plain text. The server never fetches a URL from a message. This follows two of the three judges. Copying Google Docs links by long-press is the kind of friction students leave apps over. *Owner can change:* `CHAT.linkify = false` renders links as plain text.

**D10. There is no presence, no typing indicator and no read receipts.** "Online now", "typing…" and "seen" tell a stalker or a pressuring friend exactly when a student is active. A schedule app gains nothing from them.

**D11. The phone dock keeps its 6 tabs. "Messages" is a top-bar icon on phones and a 7th sidebar item on desktop.** Both surfaces use the one name "Messages". The reasons are in §7.

**D12. Delivery is polling over the existing tRPC endpoint.** There is no SSE, no WebSocket and no tRPC subscription. The reasons are in §6.

**D13. Push notifications are generic, delayed, capped, quiet at night, and can be switched off two ways.**
- The payload has no names and no text. It always shows "You have new messages."
- A push goes out only for messages still unread 60 s after they arrive.
- At most 1 push per recipient every 10 minutes, and at most 20 per recipient per day.
- None between 22:00 and 07:00 in the school's time zone. The fallback is `America/New_York`.
- A student can mute one chat, or turn off "Message notifications" for the whole account.

**D14. Support's tools are, lightest first:**
- **Hide message**, which hides one reported message from both students;
- a **timed messaging pause** (1 day, 7 days, 30 days or until lifted);
- the existing **Remove from school**.

A paused student can still read, mute, block and report. There is no shadow-muting: the paused student is told exactly what happened.

**D15. Retention.**
- Messages are hard-deleted 180 days after they are sent.
- The text of deleted messages is erased 30 days after deletion.
- Report snapshots are cleared 180 days after the report is resolved.
- Threads with no message in 180 days are deleted. Their `chat_members` rows go with them through the cascade.

---

## 2. Permissions

Three checks are defined once in `src/server/chat.ts` and run inside the same transaction as the read or write. Nothing is cached, so the next call after any row change sees the new state.

- **`access(viewer, other)`** passes when all of the following hold:
  1. `service.ready(viewer)` passes (both names entered);
  2. `other` exists and is not the viewer;
  3. the pair's `friendships` row has `status='accepted'`;
  4. no `blocks` row exists in either direction;
  5. only when `CHAT.requiresVerification` is on: both are verified at their current schools.

  If it fails, the call throws `NOT_FOUND` "This chat is closed.", with the same wording for every cause.
- **`member(viewer, other)`** passes when a `chat_threads` row exists for the pair. The viewer is a member by construction, because a thread is keyed by the pair.
- **`notPaused(viewer)`** passes when there is no `chat_pauses` row for the viewer with `until IS NULL OR until > now`.

| Action | Who may | Checked how |
| --- | --- | --- |
| Start a conversation | Either friend | There is no separate step. The first successful `chat.send` (or `chat.mute`) creates the `chat_threads` row and both `chat_members` rows. `chat.send` requires `access` and `notPaused`; `chat.mute` requires only `access`, so a paused student can still mute (§3.4). The sender's first message in a thread counts toward the limit of 20 new conversations per day (§3). |
| Send | Either friend who is not paused | Order inside one transaction: self check and body validation → `access` → idempotency lookup on `(sender_id, id)` → `notPaused` → rate limits → insert. A retry of an already-stored message therefore never uses up quota, and it still succeeds after a pause starts, because the message was already sent. |
| Read a thread | Either friend, paused or not | `chat.thread` requires `access`. |
| List chats, count unread | The signed-in student | `chat.inbox` and the workspace `unreadChats` join `friendships` (`accepted`) and exclude blocks with `NOT EXISTS` inside the SQL, so a revoked pair leaves the open list on the very next poll. Closed rows (D7) come from `chat_members` plus `last_message_at`, with no text. |
| Mark read | Either friend | Requires `access`. Sets `last_read_seq = max(current, min(input, thread max seq))`, so it only moves forward and never past the end. |
| Mute or unmute a chat | Either friend | Requires `access`. It only affects this viewer's pushes and badge count for this thread. |
| Delete own message | The sender | Requires `access`, and the row must have `sender_id = viewer`. It sets `deleted_at` and `deleted_by='sender'` and bumps the revision. Calling it again is harmless. |
| Delete the other person's message | Nobody | The row doesn't match the query, so the call returns `NOT_FOUND` "This chat is closed." (the same wording, so there is no oracle). |
| Leave | Not a separate action for one-to-one chats | "Leaving" means Remove friend or Block. Both end `access` for both people at once and leave closed rows (D7). |
| Report a chat or a message | Either member, whether the chat is open or closed | Requires `member`, not `access`, so a student who blocked, was blocked or was unfriended can still report. A student removed by support can report too once they join another school, because the app shows onboarding to anyone with no school. The snapshot must hold at least one message with text; otherwise `BAD_REQUEST` "This chat has no messages to report.". Limits: 1 open chat report per (reporter, thread), which gives `CONFLICT`, and the existing 10 open reports per reporter, which gives `TOO_MANY_REQUESTS`. A message report's anchor must be the other person's message and must still have text. `block: true` also blocks, in the same transaction. |
| Block effects | Either person | The phase-3 `block` deletes the friendship, so `access` fails for both at once. The open row leaves both lists and the unread counts, and the worker's recheck drops pending pushes. Both people see a closed row (D7). Phase-3 `request` refuses to re-friend while the block exists. Unblocking alone does not reopen the chat; `chat.reopen` (added 2026-09-24) lifts the viewer's own block and sends the friend request in one step, and accepts a waiting request at once. After a new friendship, the old history (within retention) comes back. |
| Reopen | The viewer of a closed row | `chat.reopen({ userId })` → `{ unblocked, friendState: 'friends' \| 'requested' }`. Closed rows carry `reopen: 'unblock' \| 'friend' \| null`, computed only from the viewer's own block and the two schools, so a row never reveals whether the other person blocked the viewer; if they did, the request fails with the phase-3 "This member is not available." (the same answer People gives). The row shows "Unblock" or "Add friend" beside Report; the closed thread view shows the same button with an explanation. |
| Support removal effects | Owner | `removeFromSchool` deletes all of the student's friendships, so every one of their chats fails `access`. It already resolves every open report against them, chat reports included, as `removed`. Their messages stay until retention clears them, and their former friends keep closed rows for 30 days. |
| School change effects | Automatic | None on access (D4). The verified chip reflects the other person's current school. |
| Verification effects | Automatic | Display only: the chip and the full-name rule. With `CHAT.requiresVerification` on, losing verification ends `access` at once. |
| Pause messaging | Owner | `admin.pauseChat`. The paused student gets `FORBIDDEN` on `send`. They can still read, mute, block and report, and their friends can still send to them. Open reports against them resolve as `paused`. The action is audited. |
| Hide a reported message | Owner | `admin.redactMessage({ reportId, seq })`. The `seq` must be in that report's snapshot, otherwise `NOT_FOUND`. It sets `deleted_by='support'` and bumps the revision, and both students see "Hidden by support". The action is audited. |
| Read chat text outside a report | Nobody | No procedure exists for it. A test pins the admin procedure list (§9). |

**Every chat procedure is `accountScoped`, queries included.** That is stricter than the phase-3 queries, which are only `authenticated`. It means a tab left open on account A can never show account B's chats after an account switch in another tab. The four new admin mutations (`showEvidence`, `redactMessage`, `pauseChat`, `liftChatPause`) use a new `adminScoped = accountScoped.use(owner check)` middleware in `router.ts`, and `admin.tsx` passes `accountId: session.user.id` from the `api.session` result it already loads. An owner who switched accounts in another tab therefore can't write an evidence view to the audit log under the wrong account. The existing admin procedures and the new admin queries keep the plain `admin` middleware.

---

## 3. Moderation and safety

### 3.1 Reporting flow

**Entry points.** There are four:

| Where | What the snapshot holds |
| --- | --- |
| **Report** in the thread header | The latest 30 messages. |
| **Report message** on one of the other person's messages | 15 messages before it, the message itself (flagged `anchor`), and 14 after. This is the first scope cut (§8). |
| **Report** on a closed row in the list (D7) | The latest 30 messages. |
| People profile report panel, with the checkbox "Include our last 30 messages" checked | The latest 30 messages. The checkbox only shows when `profile.hasChat` is true (the pair's thread has `last_message_at IS NOT NULL`), and it is checked by default. When it is checked, the panel calls `chat.report` with `category: 'other'`, the typed reason as the `note`, and `block: false`. When it is unchecked, the panel sends the unchanged phase-3 `community.report`. |

**The report form** is a `Modal`:
1. The student picks a category from a `Segmented` (ToggleGroup) group. It is required. The options are:
   - `danger`: "Someone may be in danger"
   - `bullying`: "Bullying or harassment"
   - `sexual`: "Sexual content"
   - `spam`: "Spam or scam"
   - `other`: "Something else"
2. Choosing `danger` shows an info callout right away: "If someone is in immediate danger, call 911. For crisis support, call or text 988."
3. An optional note of 0–2000 characters. This matches the phase-3 `reportSchema` reason limit, so the profile panel's typed reason always fits.
4. A checkbox "Also block {name}", checked by default. It is hidden on closed rows, where the chat is already closed.

**What the server stores.** `chat.report` does all of this in one transaction:
- It inserts a row into the existing `reports` table:
  - `reported_id` is the other member;
  - `school_id` follows the existing rule: the reported student's school, else the reporter's;
  - `category`;
  - `reason` is the category label, plus `": " + note` when there is a note. The phase-3 `reason NOT NULL` column and the admin card keep working;
  - `thread_id`;
  - `evidence` is the frozen JSON snapshot.
- Each snapshot item is `{ seq, fromReported, body, createdAt, deletedBy, anchor }`. The snapshot:
  - holds both people's messages, because context matters and the reporter took part;
  - includes messages that were deleted but still have their text;
  - leaves out messages whose text was already erased.
- It is a copy, so later deletion, pruning or closing the chat cannot change it. The one exception is support's own **Hide message**, which also sets that item's `deletedBy` to `'support'` inside the snapshot, so the owner's view shows the tag without reading `chat_messages`.
- It stores no names. `admin.showEvidence` derives each item's `senderName` when the owner views it: the current display name of `reports.reported_id` when `fromReported` is true, otherwise that of `reports.reporter_id`.
- If it would be empty (every message pruned or erased), the report is refused with `BAD_REQUEST` "This chat has no messages to report.". The thread header hides **Report** while the loaded thread has no messages. **Block** stays.
- With `block: true`, it calls `CommunityService.block` inside the same transaction (a savepoint).
- The reported student is never told about the report.

### 3.2 What the owner sees and can do

**Member reports card** (existing `/admin` section), for chat reports only:
- the "Chat" chip and the category chip;
- the reason text;
- the reported student's display name and email, and the reporter's display name (all as today);
- the history line "{n} reports · {r} removals · {p} pauses":
  - `n` counts every report against the member;
  - `r` and `p` count `audit_log` rows `member.remove` / `chat.pause` whose `detail.userId` is the member. These come from the audit log, not `reports.outcome`, because one removal closes several reports at once.
- the current pause, if any: "Messaging paused until {date}" or "Messaging paused until lifted".

**Sort order.** Reports sort `danger` first, then oldest first.

**Show messages ({count}).** This button calls `admin.showEvidence`, which writes `audit_log` `reports.view` `{ reportId }` and returns the snapshot. Each line shows:
- "{sender display name} · {time}" and the text;
- the tag "Deleted by sender" or "Hidden by support" where it applies;
- a "Reported message" chip on the anchor.

**Actions**, all written to `audit_log`:

| Action | Effect | Audit entry |
| --- | --- | --- |
| **Dismiss** (existing) | Closes the report. | none |
| **Hide message**, per snapshot line | Hides that message from both students and marks the snapshot item `deletedBy: 'support'`. It works on open and resolved reports while evidence exists. It asks with `window.confirm()`: "Hide this message from both students?". `admin.tsx` already uses `prompt()` for removal, and the admin page is owner-only. | `chat.redact` `{ reportId, seq }` |
| **Pause messaging** | Opens a `Modal` with a `Select` "Pause length" (1 day / 7 days / 30 days / Until lifted) and a required reason (3–2000 characters). Resolves the member's open reports as `paused`. | `chat.pause` `{ userId, days, reason }` |
| **Remove from school** (existing) | Unchanged. | existing `member.remove` |
| **Lift pause**, in the new "Paused members" section | Ends the pause. | `chat.resume` `{ userId }` |

**What the owner can never see:**
- any message outside a report snapshot;
- anyone's conversation list, who talks to whom, message counts, or read or unread state;
- a live thread.

Section intro copy says so. One caveat is stated honestly in `docs/OPERATIONS.md`: messages are stored unencrypted in SQLite and its backups. The operations rule is that nobody queries `chat_*` tables directly except for restores.

### 3.3 Limits

| Limit | Value | Enforcement / error |
| --- | --- | --- |
| Message length | 1–1000 characters after normalization | `BAD_REQUEST` "Write a message first." / "Messages can be up to 1,000 characters." |
| Send rate | 20 per rolling minute per sender, across all chats | `count(*)` on `chat_messages(sender_id, created_at)`. `TOO_MANY_REQUESTS` "You’re sending messages too fast. Wait a minute and try again." |
| Daily volume | 500 per rolling 24 h per sender | Same index. `TOO_MANY_REQUESTS` "You reached today’s message limit. Try again tomorrow." |
| New conversations | 20 per rolling 24 h per sender (threads where this is the sender's first message ever) | `chat_members(user_id, first_sent_at)`. `TOO_MANY_REQUESTS` "You started 20 new chats today. Try again tomorrow." |
| Retrying a send | Never counts | The idempotency lookup runs before every limit |
| Chat reports | 1 open per (reporter, thread); 10 open per reporter across all report kinds | `CONFLICT` "You already reported this chat. Support will review it." / existing `TOO_MANY_REQUESTS` "You already have ten open reports. Wait for support to review them." |
| Friend requests (existing) | 30 pending | Limits how many people one account can reach |
| Push | 60 s delay; 1 per recipient per 10 min; 20 per recipient per 24 h; none 22:00–07:00; none for muted chats or `chat_push=0`; nothing older than 24 h | Worker (§6); skipped silently |

**Normalization** is `normalizeBody` in `src/domain/chat.ts`. `ChatService.send` applies it through `bodyError`/`parseBody` (§5), not through a zod transform. When tRPC rejects input, its message is the `ZodError` JSON. On `master` that reaches the student as raw JSON. The uncommitted UI sweep's `errorFormatter` replaces it with the generic "Some of this doesn't look right…". Neither is the specific fixed string the composer needs. The router input is only `body: z.string().max(4000)`. The composer calls the same `bodyError` to disable **Send**. The steps are:
1. Convert to NFC.
2. Convert `\r\n` and `\r` to `\n`.
3. Strip C0/C1 control characters except `\n` and `\t`.
4. Strip bidi and direction-override characters: U+202A–202E, U+2066–2069, U+200E, U+200F.
5. Collapse three or more consecutive newlines to two.
6. Trim.
7. Treat a message that is empty once zero-width characters (U+200B–200D, U+2060, U+FEFF) are ignored as empty.

**Error messages never echo message text.** The tRPC `onError` handler logs `error.message`. So every chat error message is a fixed string from the table in §5. The only zod-level body check is `max(4000)`. A zod 4 `too_big` issue carries no input, but it would show as JSON, and the composer's `maxLength={1100}` makes it unreachable from the UI. The handler's `onError` body moves unchanged into an exported `logTrpcError({ path, error })` in `src/server/trpc-log.ts`, so a test can call it. A test sends invalid bodies that contain a marker string and asserts that the marker is absent from the error message and from the logged line (§9).

**Reserved display names.** `Service.profile` rejects a display name that is new or changed if any of its words, after lowercasing and removing punctuation inside the word (so "s.u.p.p.o.r.t" becomes "support"), is one of `quasar`, `support`, `admin`, `administrator`, `moderator`, `staff` or `official`. The error is `BAD_REQUEST` "Choose a display name that doesn’t mention Quasar or support." A name that is already stored and unchanged is never rejected, so existing students can still save their full name. "Stafford" and "Badminton" pass, because only whole words are checked. This is the second scope cut (§8).

### 3.4 Mute and pause

**Mute** belongs to the student, per chat and per viewer:
- no pushes for that chat;
- the chat is excluded from the shell badge;
- the unread pill in the list turns grey instead of disappearing;
- the student can undo it at any time.

**Message notifications** (`users.chat_push`) is the account-wide switch. It turns every chat push off for every browser and leaves task reminders alone.

**Pause** is support's sanction, per account and across schools:
- Sending fails with `FORBIDDEN`. Everything else keeps working.
- It expires by time comparison, so no job is needed.
- The student sees "Support paused your messaging until {date}." or, with no end date, "Support paused your messaging."

### 3.5 Retention and deletion

The worker step `pruneChat(db, now)` runs every 60 s cycle, in one transaction. The first four statements use the indexes in §4 (`chat_messages_created`, `chat_messages_deleted`, the existing `reports_open(resolved_at, …)` and `chat_threads_last`). The last one scans `notification_deliveries`, which is small, because it holds only 2 days of chat rows plus reminder rows:

```sql
DELETE FROM chat_messages WHERE created_at < :now_minus_180d;
UPDATE chat_messages SET body='' WHERE deleted_at IS NOT NULL AND deleted_at < :now_minus_30d AND body <> '';
UPDATE reports SET evidence=NULL WHERE evidence IS NOT NULL AND resolved_at IS NOT NULL AND resolved_at < :now_minus_180d;
DELETE FROM chat_threads WHERE last_message_at < :now_minus_180d
  OR (last_message_at IS NULL AND created_at < :now_minus_180d);    -- cascades chat_members and any remaining chat_messages
DELETE FROM notification_deliveries WHERE entity_id='chat:messages' AND updated_at < :now_minus_2d;
```

`coalesce(last_message_at, created_at)` is not used, because it can't use `chat_threads_last`.

### 3.6 Links and media

- Text is rendered as React text nodes inside a `whitespace-pre-wrap break-words` element. There is no HTML and no markdown.
- `linkParts(text)` in `src/domain/chat.ts` splits the text on `/https:\/\/[^\s<>"]+/g`. It then:
  - strips trailing `.,;:!?)]}'"` from each match;
  - keeps a match as a link only if `new URL()` parses it with `protocol === 'https:'` and no username or password.
- There are no attachments and no fetching.

### 3.7 Abuse cases considered

| Case | Handling |
| --- | --- |
| A stranger or adult cold-messages a minor | Impossible without an accepted friendship. Requests go only to schoolmates, with a cap of 30 pending. The "Not verified" chip shows in every thread. There is no presence data (D10). |
| Harass, then block or unfriend the victim | The victim keeps a closed row with Report for 30 days (D7). The report needs only `member`. |
| Harass, then delete | The text is kept 30 days, and the snapshot includes it marked "Deleted by sender". A snapshot taken before the deletion is frozen. |
| Harassment after a block | `access` fails on every read and write. Phase-3 `request` refuses re-friending. |
| Block probing ("did they block me?") | Unfriend, block and removal all give "This chat is closed." and an identical closed row. |
| Flooding one person | 20/minute and 500/day. Pushes collapse to 1 per 10 minutes and 20 a day, and none at night. Mute. |
| Spraying many friends | 20 new conversations per day. |
| Retry storms or double taps creating duplicates | `UNIQUE(sender_id, id)` with client IDs. A retry returns the original message. |
| Phishing, tracking or `javascript:` links | Only `https` is clickable, and the full URL is visible. Nothing is fetched. There are no images. |
| Spoofed text (bidi overrides, invisible messages) | Stripped or rejected on the server. |
| Impersonating Quasar or support | Reserved-name rule. Support has no chat account. Help FAQ: "Can support read my messages?" |
| False, bombing or retaliatory reports | 1 open report per thread and 10 per reporter. The snapshot shows both sides. The history line shows patterns. The owner can dismiss. |
| Self-harm or threats | The `danger` category sorts first for the owner and shows 911/988 to the reporter. |
| A paused or removed student makes a new Google account | They must join the school and be accepted as a friend again. This is an accepted residual risk. The victim can report and block again. |
| Owner overreach | No browse API. Evidence views are audited. A router-shape test runs. Encryption at rest is a non-goal, stated honestly. |
| A push leaks content on a lock screen | The payload is `{"kind":"chat","tag":"quasar-chat"}`, and the service worker shows fixed text. |
| A shared computer | Nothing about chat persists on the device (D5). |
| Account switch in another tab | Every chat procedure is `accountScoped`. The workspace poll sends the tab back to sign-in within 15 s. |
| Grooming that moves to another app ("add me on snap") | Cannot be prevented. Report and block cover it. Keyword detection is a non-goal. |

---

## 4. Data model (migration 6)

Migration 6 goes in `openDatabase` right after migration 5, inside `db.transaction(() => { ... })()`. It is additive and safe to run twice (`IF NOT EXISTS`, plus `ALTER`s guarded by `pragma table_info`, as in migrations 4 and 5). It runs as three steps in this order, because the indexes on `reports` need the new columns:
1. `db.exec` the four `CREATE TABLE` statements and their indexes.
2. Run the guarded `ALTER`s.
3. `db.exec` the two `reports` indexes and the `schema_migrations` insert.

The naming follows the existing tables: snake_case, ISO-text timestamps, `REFERENCES users(id)` without `ON DELETE`, because no user row is ever deleted, and `ON DELETE CASCADE` only from child to parent inside the chat tables.

```sql
CREATE TABLE IF NOT EXISTS chat_threads (
  id TEXT PRIMARY KEY,
  user_low TEXT NOT NULL REFERENCES users(id),
  user_high TEXT NOT NULL REFERENCES users(id),
  revision INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(user_low, user_high),
  CHECK(user_low < user_high)
);
CREATE INDEX IF NOT EXISTS chat_threads_high ON chat_threads(user_high);
CREATE INDEX IF NOT EXISTS chat_threads_last ON chat_threads(last_message_at);

CREATE TABLE IF NOT EXISTS chat_members (
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  notified_seq INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  first_sent_at TEXT,
  PRIMARY KEY(thread_id, user_id)
);
CREATE INDEX IF NOT EXISTS chat_members_user ON chat_members(user_id);
CREATE INDEX IF NOT EXISTS chat_members_first_sent ON chat_members(user_id, first_sent_at) WHERE first_sent_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS chat_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT CHECK (deleted_by IN ('sender','support')),
  revision INTEGER NOT NULL,
  UNIQUE(sender_id, id)
);
CREATE INDEX IF NOT EXISTS chat_messages_thread_seq ON chat_messages(thread_id, seq);
CREATE INDEX IF NOT EXISTS chat_messages_thread_revision ON chat_messages(thread_id, revision);
CREATE INDEX IF NOT EXISTS chat_messages_sender_time ON chat_messages(sender_id, created_at);
CREATE INDEX IF NOT EXISTS chat_messages_created ON chat_messages(created_at);
CREATE INDEX IF NOT EXISTS chat_messages_deleted ON chat_messages(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS chat_pauses (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  until TEXT,
  actor_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Each guarded by pragma table_info(...):
ALTER TABLE reports ADD COLUMN thread_id TEXT;     -- no FK on purpose: pruning a thread must not be blocked by an old report
ALTER TABLE reports ADD COLUMN evidence TEXT;      -- frozen JSON snapshot; NULL for profile reports and after the 180-day purge
ALTER TABLE reports ADD COLUMN category TEXT;      -- 'danger'|'bullying'|'sexual'|'spam'|'other'; NULL for phase-3 profile reports
ALTER TABLE users ADD COLUMN chat_push INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS reports_thread ON reports(reporter_id, thread_id, resolved_at);
CREATE INDEX IF NOT EXISTS reports_reported ON reports(reported_id, resolved_at);
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(6, datetime('now'));
```

- **`chat_threads`** has one row per unordered pair, created lazily on the first send or mute. `revision` is the thread's change counter. It goes up on every insert, delete and support hide, and it is the cursor that thread polls resume from. `last_message_at` drives list order, the 30-day closed rows and pruning.
- **`chat_members`** holds each person's state in a thread:
  - `last_read_seq` drives unread counts;
  - `notified_seq` stops the same messages from being pushed twice;
  - `muted` switches off pushes and the badge;
  - `first_sent_at` enforces the 20-new-conversations limit.

  It is state, never a grant of access.
- **`chat_messages`** holds each message:
  - `seq` gives the global order and is used for ordering, the read marker, paging and report windows;
  - `id` is the client-generated UUID, and `UNIQUE(sender_id, id)` makes sends idempotent without letting one sender collide with another;
  - `revision` is the thread revision at insert or at the last delete or hide;
  - `body` survives deletion until the 30-day prune.
- **`chat_pauses`** is support's messaging pause, one row per student. `until IS NULL` means until lifted. An expired row is just ignored and gets replaced on the next pause.
- **`reports` (extended)**: chat reports reuse the phase-3 inbox, the 10-open cap and the removal flow.
  - `thread_id` marks a chat report.
  - `evidence` holds the snapshot.
  - `category` drives the sort and the chip.
- **`users.chat_push`** is the account-wide "Message notifications" switch.
- **`notification_deliveries` (reused, no schema change):**
  - Chat pushes claim rows with `entity_id='chat:messages'`. The colon cannot appear in a task ID (`/^[a-zA-Z0-9_-]{1,100}$/`), so these rows never collide with reminder rows.
  - `reminder_at` holds the ISO start of the 10-minute window.
  - `deliverDue` selects from `entities`, so it never touches these rows.

---

## 5. API

### Shared module: `src/domain/chat.ts` (used by client and server)

```ts
export const CHAT = {
  maxLength: 1000, perMinute: 20, perDay: 500, newChatsPerDay: 20,
  page: 50, maxChanges: 200, evidence: 30, evidenceBefore: 15, evidenceAfter: 14,
  retentionDays: 180, deletedTextDays: 30, evidenceDays: 180, closedRowDays: 30,
  pushDelayMs: 60_000, pushWindowMs: 600_000, pushPerDay: 20, quietStart: 22, quietEnd: 7,
  fallbackTimeZone: 'America/New_York', requiresVerification: false, linkify: true,
} as const;
export function normalizeBody(raw: string): string;          // §3.3
export function linkParts(text: string): Array<{ text: string; href?: string }>;  // §3.6
/** Fixed-string problem for a normalized body, or null. Used by the composer (disable Send) and by ChatService. */
export function bodyError(normalized: string): 'Write a message first.' | 'Messages can be up to 1,000 characters.' | null;
  // empty after ignoring U+200B–200D, U+2060, U+FEFF → 'Write a message first.'; length > CHAT.maxLength → the 1,000 message
/** Server side: normalizeBody + bodyError, throwing TRPCError BAD_REQUEST with the fixed string. Never echoes input. */
export function parseBody(raw: string): string;                   // lives in src/server/chat.ts (needs TRPCError)
export const rawBodySchema = z.string().max(4000);                // the only zod check on the body
export const reportCategorySchema = z.enum(['danger', 'bullying', 'sexual', 'spam', 'other']);
export const REPORT_CATEGORIES: Record<ReportCategory, { label: string; short: string }> = {
  danger: { label: 'Someone may be in danger', short: 'Danger' },
  bullying: { label: 'Bullying or harassment', short: 'Bullying' },
  sexual: { label: 'Sexual content', short: 'Sexual content' },
  spam: { label: 'Spam or scam', short: 'Spam' },
  other: { label: 'Something else', short: 'Other' },
};
```

### Types (`src/server/chat.ts`)

```ts
export type ChatPeer = { id: string; displayName: string; fullName: string | null; verified: boolean };
export type ChatMessage = { id: string; seq: number; fromMe: boolean; body: string | null; createdAt: string;
  deletedBy: 'sender' | 'support' | null };                       // body null when deleted or hidden
export type ChatPause = { until: string | null };                  // ISO; null = until lifted
export type InboxRow =
  | { state: 'open'; peer: ChatPeer; lastMessage: { fromMe: boolean; preview: string | null; createdAt: string;
      deletedBy: 'sender' | 'support' | null } | null;             // deletedBy picks "Message deleted" or "Hidden by support"
      unread: number; muted: boolean }                             // preview ≤ 120 chars, null when deleted
  | { state: 'closed'; userId: string; displayName: string; lastAt: string };
export type EvidenceItem = { seq: number; senderName: string; fromReported: boolean; body: string; createdAt: string;
  deletedBy: 'sender' | 'support' | null; anchor: boolean };
```

`ChatService` has the constructor `(service: Service, now = () => new Date())`, so tests control the clock. The router always builds it with the real clock (`new ChatService(ctx.service)`), so time-dependent tests call `ChatService` methods directly, and router-caller tests cover binding and permissions. `pruneChat(db, now)` is exported separately for the worker. Reads that return data together with a cursor (`thread`, `inbox`) run inside one `db.transaction`, so the returned `revision` matches the returned rows. `ChatPeer.verified` and `fullName` use `CommunityService.isVerified` and the phase-3 both-verified rule. `audit_log.school_id` is nullable, so chat audit rows write `reports.school_id`, or the member's current school, or `NULL`. They insert directly, because `Service.audit` is private and requires a school.

### Procedures

Every `chat.*` procedure is **`accountScoped`**, so every input also carries `accountId: z.uuid()`. Admin queries use the existing `admin` middleware. Admin mutations use `adminScoped` (§2), so their inputs also carry `accountId`. `userId` is always `z.uuid()`. A procedure with no input beyond `accountId` is written `accountScoped.query(...)` with no extra `.input`.

| Procedure | Kind | Input (plus `accountId`) | Returns |
| --- | --- | --- | --- |
| `chat.inbox` | query | none | `{ rows: InboxRow[]; unreadChats: number; unreadAt: string; pause: ChatPause \| null }`. `unreadAt` is the server's ISO time when the count was computed (§6). `rows` holds, in order: open rows with messages, newest first; closed rows (`last_message_at` within 30 days), newest first; then friends with no messages, by name. A thread with `last_message_at IS NULL`, created by `mute`, counts as "no messages" and never becomes a closed row. |
| `chat.thread` | query | `{ userId, after?: z.number().int().min(0), before?: z.number().int().positive() }`, with a refine that forbids both | `{ peer: ChatPeer; messages: ChatMessage[] /* ascending seq */; revision: number; lastReadSeq: number; hasEarlier: boolean; reset: boolean; muted: boolean; pause: ChatPause \| null }`. See the cursor rules after this table. |
| `chat.send` | mutation | `{ userId, clientId: z.uuid(), body: rawBodySchema }`, then `parseBody` in the service | `{ message: ChatMessage }`. **It deliberately returns no revision.** The client advances its cursor only from polls, so it can never skip the other person's messages. |
| `chat.delete` | mutation | `{ userId, messageId: z.uuid() }` | `{ deleted: true }` |
| `chat.read` | mutation | `{ userId, seq: z.number().int().min(0) }` | `{ unreadChats: number; unreadAt: string }` |
| `chat.mute` | mutation | `{ userId, muted: z.boolean() }` | `{ muted: boolean }` |
| `chat.report` | mutation | `{ userId, category: reportCategorySchema, note: z.string().trim().max(2000).default(''), seq: z.number().int().positive().optional(), block: z.boolean() }` | `{ blocked: boolean }`. With `seq`, the snapshot is the anchored window. Without it, the latest 30. |
| `chat.setPush` | mutation | `{ enabled: z.boolean() }` | `{ enabled: boolean }` |
| `admin.reports` | query (extended) | none | Each row gains `isChat: boolean; category: ReportCategory \| null; evidenceCount: number; history: { reports: number; removals: number; pauses: number }; pause: ChatPause \| null`. Rows sort `danger` first, then by `createdAt`. **It contains no message text.** |
| `admin.showEvidence` | mutation (`adminScoped`) | `{ reportId: z.uuid() }` | `{ items: EvidenceItem[] }`. Writes `audit_log` `reports.view`. Returns `NOT_FOUND` "This report has no messages." for non-chat or purged reports. |
| `admin.redactMessage` | mutation (`adminScoped`) | `{ reportId: z.uuid(), seq: z.number().int().positive() }` | `void`. Updates the message (`deleted_at`, `deleted_by='support'`, revision bump) and the snapshot item in one transaction. If the message was already pruned, only the snapshot changes. |
| `admin.pauseChat` | mutation (`adminScoped`) | `{ userId: z.uuid(), days: z.union([z.literal(1), z.literal(7), z.literal(30)]).nullable(), reason: z.string().trim().min(3).max(2000) }` | `void`. Upserts `chat_pauses`, resolves the member's open reports with `outcome='paused'`, and writes `chat.pause`. |
| `admin.liftChatPause` | mutation (`adminScoped`) | `{ userId: z.uuid() }` | `void`, with the audit entry `chat.resume` |
| `admin.chatPauses` | query (admin) | none | `Array<{ userId; displayName; email; until: string \| null; reason; createdAt }>` for active pauses only |

**`chat.thread` cursor rules:**
- With no cursor, it returns the latest 50 by `seq`.
- `before` (a `seq`) returns the 50 older messages.
- `after` (a revision) returns every message whose `revision > after`, which covers new, deleted and hidden messages.
- More than 200 changes returns `reset: true` with the latest page.
- A friend pair that has no thread yet returns empty with `revision: 0`.
- `after` greater than the thread's current revision (the thread was pruned and recreated, or never existed) returns `reset: true` with the latest page, so a stale cursor can never hide new messages.
- `hasEarlier` is meaningful only for pages: no cursor, `before`, or a `reset: true` response. An `after` poll without a reset always returns `hasEarlier: false`, and the client keeps its own value.

**Changes to existing procedures:**
- `community.profile` also returns `hasChat: boolean`, which is true when the pair's thread exists and has `last_message_at IS NOT NULL`.
- The workspace `community` summary gains `unreadChats: number` and `chatPush: boolean`. `unreadChats` is computed by the same SQL as `chat.inbox.unreadChats`: the number of accessible, unmuted threads that have at least one message with `sender_id <> me`, `seq > last_read_seq` and `deleted_at IS NULL`. It also gains `unreadAt` (server ISO time, §6). `summary()` also runs for students who are still onboarding, so this SQL must not call `service.ready()` and returns 0 for them.
- `Service.profile` gains the reserved-name check (§3.3).

**The `chat.send` transaction runs in this order:**
1. Reject a self-message (`BAD_REQUEST` "You cannot message yourself."). This runs before `access`, because `access` condition 2 would otherwise turn it into `NOT_FOUND`. The same order applies to `thread`, `read`, `mute` and `report`. Then `parseBody(body)`, because the idempotency check compares normalized bodies. Neither step reveals anything about the other person.
2. `access`.
3. The idempotency lookup on `(sender_id, clientId)`:
   - the same thread and the same normalized body returns the stored message, even if it has since been deleted;
   - anything else gives `BAD_REQUEST`.
4. `notPaused`.
5. Rate limits (minute, day, then new conversation if `first_sent_at IS NULL`).
6. Make sure the thread and both member rows exist.
7. Increment the thread's `revision` and insert the message with it.
8. Set the thread's `last_message_at`.
9. Set the sender's `last_read_seq` to the new `seq`, and fill `first_sent_at` if it is empty.

### Error codes

Messages are shown to the student exactly as written, and none of them contains message text.

| Code | Message | When |
| --- | --- | --- |
| `UNAUTHORIZED` | Existing account-change and sign-in messages | `accountId` mismatch, or not signed in |
| `NOT_FOUND` | "This chat is closed." | `access` or `member` fails; deleting a message you don't own; `chat.report` with a `seq` outside the thread |
| `NOT_FOUND` | "Member not found." | `admin.pauseChat` / `admin.liftChatPause` for an unknown user (existing wording from `removeFromSchool`) |
| `NOT_FOUND` | "This message is not in this report." | `admin.redactMessage` with a `seq` that is not in the snapshot |
| `NOT_FOUND` | "This report has no messages." | `admin.showEvidence` on a non-chat or purged report |
| `FORBIDDEN` | "Support paused your messaging." | Sender is paused. The client shows the date from `pause.until`. |
| `FORBIDDEN` | "Owner access is required." | Admin procedures (existing) |
| `TOO_MANY_REQUESTS` | "You’re sending messages too fast. Wait a minute and try again." | More than 20 per minute |
| `TOO_MANY_REQUESTS` | "You reached today’s message limit. Try again tomorrow." | More than 500 per day |
| `TOO_MANY_REQUESTS` | "You started 20 new chats today. Try again tomorrow." | A 21st new conversation in 24 h |
| `TOO_MANY_REQUESTS` | "You already have ten open reports. Wait for support to review them." | Existing report cap |
| `BAD_REQUEST` | "Write a message first." / "Messages can be up to 1,000 characters." | Body validation |
| `BAD_REQUEST` | "A retry ID cannot be reused for a different message." | `clientId` reused with a different body or thread |
| `BAD_REQUEST` | "This chat has no messages to report." | `chat.report` whose snapshot would be empty |
| `BAD_REQUEST` | "You cannot message yourself." | `userId` is the viewer |
| `BAD_REQUEST` | "You cannot report your own message." | The report anchor is the reporter's own message |
| `BAD_REQUEST` | "Choose a display name that doesn’t mention Quasar or support." | Reserved-name rule |
| `CONFLICT` | "You already reported this chat. Support will review it." | An open chat report for this (reporter, thread) already exists |

### Client transport: `src/client/api.ts`

```ts
links: [splitLink({
  condition: op => op.path === 'chat.send',
  true: httpLink({ url: '/api/trpc' }),
  false: httpBatchLink({ url: '/api/trpc' }),
})]
```

A send is never batched with a poll. With `httpBatchLink` alone, the URL could be `/api/trpc/workspace,chat.send?batch=1`. With the split, the send's `AbortSignal.timeout(15_000)` and Playwright's `page.route('**/api/trpc/chat.send*')` both hit exactly one request.

**Through the Cloudflare tunnel and the service worker.** Queries stay GET requests through `httpBatchLink`. Each poll is one short request, and there is no long-lived connection for the tunnel's idle timeout to cut. `route.ts` already sends `Cache-Control: no-store` on every tRPC response, so neither Cloudflare nor the browser HTTP cache stores chat data. `public/sw.js` never intercepts `/api/` (its fetch handler only touches navigations to `/` and `/admin` and public static assets), and that stays unchanged.

---

## 6. Delivery

### Transport: polling

SSE, WebSockets and tRPC subscriptions were rejected for five reasons:
1. Production runs through a Cloudflare tunnel, and the dev server through tailnet `serve`. Long-lived streams there need heartbeats inside proxy idle limits, and every deploy drops them. A reconnect-and-catch-up path is needed either way. Building only that path gives one code path to test, not two.
2. Push runs in a separate worker process (`scripts/worker.ts`). A stream would need an in-process event bus that breaks as soon as there are two server processes.
3. A Next 16 route handler can return a streaming `Response`, but it would bypass tRPC's `accountScoped` middleware, and every event would need a fresh permission recheck.
4. `httpSubscriptionLink` would add a second transport with its own failure modes.
5. A thread poll is one indexed range read plus three small permission lookups, which SQLite handles trivially at pilot scale.

The `revision` cursor is already the right shape for `Last-Event-ID`. If streaming is added later, the data model does not change and polling stays as the fallback.

### Poll schedule

`src/components/use-chat.ts` exports `useChatInbox` and `useChatThread`.

| What | Interval | Runs only when |
| --- | --- | --- |
| Open thread: `chat.thread({ after: revision })` | 4 s | The thread is mounted, `document.visibilityState === 'visible'` and `state.online` |
| List: `chat.inbox` | 10 s | The list pane is mounted (desktop: always inside Messages; phone: when no thread is open), visible and online |
| Badge everywhere else | 15 s | The existing workspace `synchronize` loop (`community.unreadChats`) |

**Scheduling and backoff:**
- Polls use a chained `setTimeout`, not `setInterval`, with a single in-flight guard. An `AbortController` cancels the request when the thread changes or the view unmounts.
- A transport error doubles the delay (4 → 8 → 16 → 30 s cap for the thread; 10 → 20 → 30 s for the list). The delay resets on success.
- After 2 consecutive failures the header shows "Reconnecting…".

**An immediate poll fires on:**
- `visibilitychange` to visible;
- `state.online` turning true. This is an effect dependency, not a raw `online` listener, because `use-workspace` flips `online` in its own listener and a raw listener would race it and skip the poll;
- opening a thread;
- a successful send;
- the `quasar:chat-activity` window event. Tracker dispatches it when the service worker posts `{ type: 'CHAT_ACTIVITY' }`, and also calls `session.synchronize()` so the badge updates.

**Special responses:**
- `reset: true` replaces the local message list with the latest page.
- **Merging `after` results:** each changed message replaces the local one with the same `seq`, or is inserted in `seq` order. A change whose `seq` is below the lowest loaded `seq` while `hasEarlier` is true is dropped, because it belongs to a page that isn't loaded and will arrive fresh when that page loads. The local `revision` becomes the response's `revision`.
- `NOT_FOUND` switches the thread to the closed state (§7).
- `UNAUTHORIZED` calls `state.refresh()`, which goes to sign-in through the existing flow.
- Several tabs can poll at once safely, because `chat.read` stores a `max()`.

### Send and reconcile (the composer's state machine)

**State and ordering:**
- Each outgoing message is `{ clientId, body, status: 'pending' | 'failed', error?, retryable }`, held in the `use-chat` module map and keyed by `${accountId}:${userId}`. It survives switching threads, but not a reload. When `use-chat` mounts with a different `accountId` from the one in the map, it clears the whole map (pending sends and drafts). Sign-out and account switches therefore never leave another account's text in memory.
- Sends go one at a time, in order, with `signal: AbortSignal.timeout(15_000)`.
- On success, the pending bubble becomes the server message, deduplicated by `id`.

**Failures:**

| Failure | What happens |
| --- | --- |
| Network error, timeout or 5xx (classified with `isTransportFailure` from `api.ts` where it exists, otherwise a `TRPCClientError` with no `data`, or an `AbortError`/`TimeoutError`) | One automatic retry after 2 s with the same `clientId`. If that fails too: "Not sent." with **Retry** and **Discard**. |
| `TOO_MANY_REQUESTS` | **Retry** and **Discard**, with the server message. |
| `NOT_FOUND`, `FORBIDDEN` or `BAD_REQUEST` | **Discard** only, with the server message. |

- A failure also marks every message queued behind it as failed, which preserves order. **Retry** resends all failed messages in order.
- Only **Retry** and reconnecting resend a failed message. Sending a new message never does, so a message the student left at "Not sent." is never sent behind their back. While a retryable failed message exists, a new message joins the queue as failed ("Not sent.", with Retry and Discard) behind it, and **Retry** sends them all in order.
- When `state.online` turns from false to true, messages that failed for network reasons retry automatically, in every thread of the account, not only the open one (`resumeChatSends(accountId)` in `use-chat.ts`, called by Tracker). This is safe because their IDs are unchanged. A new message queued behind them joins that retry only when everything ahead of it failed for network reasons, so it can never overtake a rate-limited message. Opening a thread never resends anything.
- **Lost response:** if a poll returns a message whose `id` equals a pending or failed `clientId`, that bubble becomes sent.

### Unread counts and the badge

**The count is conversations, not messages.** It is the number of accessible, unmuted chats with at least one unread incoming message. The labels are "1 unread chat" and "{n} unread chats", and the badge shows "99+" above 99.

**Sources.** Tracker keeps `chatUnread = { n, at }` and takes the one with the latest `at` from three sources:
- the workspace context (`context.community.unreadChats` / `context.community.unreadAt`);
- `chat.inbox` (`unreadChats` / `unreadAt`);
- `chat.read`'s return value (`unreadChats` / `unreadAt`).

Every `unreadAt` is stamped **by the server** (`new Date().toISOString()`) when it computes the count. There is one server and one SQLite writer, so a later stamp always reflects every write committed before it. A workspace response computed before a newer `chat.read` cannot bring back a stale count, whatever order the responses arrive in. `use-workspace.ts` needs no change. Equal stamps keep the current value.

**Marking read.** The thread calls `chat.read` with the highest incoming `seq` when three things hold: new incoming messages have rendered, the page is visible, and the log is scrolled within 80 px of the bottom.

**Offline.** The badge is hidden while offline, on both the top-bar icon and the sidebar item.

### Push notifications (inside the existing single worker cycle)

`jobs.ts` stays **one sequential loop**: `calendar.refreshDue` → `notifications.deliverDue` → `notifications.deliverChat` → `notifications.deliverSupport` → `chat.prune`. Each step is wrapped in its own `try`, and the last two report `onError('chat')`. The `Jobs` type gains `notifications.deliverChat` and `chat.prune`, and `startJobs`' default wires in `new NotificationService(db)` and `{ prune: now => pruneChat(db, now) }`. There is no second loop and no `stop()` change.

`NotificationService.deliverChat(now = new Date())` reuses VAPID, `sendPush`, `push_subscriptions`, the claim SQL and the 404/410 cleanup. It returns `{ sent, failed }` and does nothing when VAPID is off. For each recipient R with at least one subscription and `users.chat_push = 1`:

1. **Quiet hours.** Skip R if the local hour in R's school `schedule.timeZone` (fallback `America/New_York`) is in [22, 7). The messages wait until 07:00.
2. **Rate.** Look at R's `notification_deliveries` rows with `entity_id='chat:messages'` and `status='sent'`. Skip R if the latest `updated_at` is under 10 minutes ago, or if `count(DISTINCT reminder_at)` in the last 24 h is 20 or more.
3. **Candidates.** R's threads where the pair has `access`, R's `muted = 0`, and a message from the other person has:
   - `seq > max(last_read_seq, notified_seq)`;
   - `deleted_at IS NULL`;
   - `created_at <= now − 60 s` and `created_at >= now − 24 h`.

   If there are none, skip R.

   Muted threads, a recipient with no school (quiet hours use the fallback zone) and a recipient with no `chat_members` row (no thread yet) are all simply absent from this query.
4. **Claim.** Per subscription, claim `(R, 'chat:messages', windowStart = floor(now / 10 min) as ISO, subscription_id)` with the exact existing `INSERT … ON CONFLICT DO UPDATE … WHERE status!='sent' AND attempts<5 AND updated_at<leaseCutoff` statement. If the claim is not granted, skip that subscription, because another worker has it or it was already sent in this window.
5. **Recheck, then send.** Re-run the candidate query so that a read, mute, unfriend or block that happened meanwhile wins. Then send `{"kind":"chat","tag":"quasar-chat"}` with `TTL: 3600`, `urgency: 'normal'` and `timeout: 15_000`. Mark the row `sent`, or `failed` with an error code but no text. If the recheck finds no candidates, delete the claimed row, so an empty window never counts toward the 10-minute or 20-a-day caps. A 404/410 deletes the subscription, as `deliverDue` does.
6. **Record.** After at least one successful send to R, set `notified_seq` to the highest candidate `seq` in each candidate thread, so the same messages are never pushed twice, even after a restart.

**`public/sw.js` changes:**
- The shown text comes from a fixed table keyed by `payload.kind`. Anything unknown, including today's reminder payload, falls back to the reminder text.

  | `kind` | Title | Body | Tag | URL |
  | --- | --- | --- | --- | --- |
  | `chat` | "Quasar" | "You have new messages. Open Quasar to read them." | `quasar-chat`, with `renotify: true`, so a push that replaces an older one still alerts. The server already limits pushes to one per 10 minutes. | `/#messages` |
  | reminder (unchanged) | "Quasar reminder" | "You have a task reminder. Open Quasar to view it." | payload tag | `/#tasks` |

- On a `chat` push, the worker also runs `clients.matchAll({ type: 'window' })` and sends `postMessage({ type: 'CHAT_ACTIVITY' })` to each client, so an open tab refreshes the badge at once (`session.synchronize()`). The thread and list pollers also poll at once, but only if the tab is visible. The notification is still shown, because `userVisibleOnly` requires it. Tracker listens with `navigator.serviceWorker?.addEventListener('message', …)` only when `serviceWorkerEnabled` (as `use-workspace` does). Without a service worker, the badge simply waits for the 15 s poll.
- `notificationclick` opens `event.notification.data.url` only if it is in `['/#tasks', '/#messages']`. Otherwise it opens `/#tasks`.

**End-to-end latency:**
- inside an open thread: about 4 s;
- the badge elsewhere in the app: about 15 s, or immediately after a push arrives in that browser;
- a push: about 1–2 minutes (60 s delay plus the 60 s worker cycle), then at most 1 per 10 minutes.

---

## 7. UI

### Where chat lives

**Phone (below `lg`).** A **Messages** icon link (icon `message`, a 40 px circle) sits in the sticky top bar between the status pill and the account avatar. The unread badge sits on its top-right corner: `absolute -right-0.5 -top-0.5`, the same pill classes as the dock badges. The link gets `bg-primary-soft` and `aria-current="page"` while on Messages. The 6-tab dock is unchanged.

**Badge accessibility** copies whatever the Tasks and People badges do when this is implemented, so all three read the same way.
- On `master`, the badge span carries `aria-label="1 unread chat"`.
- The uncommitted UI sweep in this worktree moves counts into hidden spans referenced by `aria-describedby` (`COUNT_IDS`). With that, add `messages: 'nav-chat-count'` to `COUNT_IDS`, render one hidden `<span id="nav-chat-count" hidden>` with "1 unread chat" / "{n} unread chats" beside the existing ones, and have both the top-bar link and the sidebar link point at it.

The Playwright locator follows the same choice (§7, Accessible names).

Why not the alternatives:
- **A 7th tab:** it would give about 52 px per tab at 390 px, and "Schedule" at 10.5 px bold barely fits in that.
- **A sub-view of People:** it would hide the most-used social action behind the least-used one (the directory), and mix friend-request and message badges.
- **Replacing Classes:** it would bury setup, which PLAN.md treats as the heart of the product.

A top-bar messages icon is the pattern students know from Instagram, and it can be reached in one tap from every view. The status pill is already icon-only below 480 px, so the space exists (about 110 + 28 + 40 + 32 px plus gaps).

**Desktop (`lg` and up).** Messages is a 7th sidebar item after People (`VIEW_ICONS.messages = 'message'`), with a `SidebarMenuBadge` like the ones on Tasks and People.

**Routing.** The `View` union gains `'messages'`. The `VIEWS` element type gains an optional `dock?: boolean`, and `VIEWS` gains `{ id: 'messages', label: 'Messages', dock: false }` last. `TabBar` renders `VIEWS.filter(v => v.dock !== false)`, and the sidebar still maps all of `VIEWS`. `parseHash` already resolves any `VIEWS` id, so no routing code changes. `Shell` gains the props `chatUnread: number | null` (`null` while offline, which hides both badges), `immersive: boolean` and `chatPush: boolean`. The routes are `#messages` (the list) and `#messages?with=<userId>` (a thread).

**Inside a thread on the phone.** The dock is hidden. Tracker passes `immersive = view === 'messages' && params.has('with')`, and `TabBar` isn't rendered then.
- `app-main` becomes `flex flex-col pb-0` with `height: var(--chat-h, calc(100dvh - 3.5rem))`. Shell's own banners (session error, sync failure) stay first in the column. The thread is `min-h-0 flex-1`, so a banner shrinks the log instead of pushing the composer off screen.
- `--chat-h` is set on `document.documentElement` by `useChatViewport()` in `use-chat.ts`, only while a phone thread is mounted. It holds `visualViewport.height − document.querySelector('.app-topbar').offsetHeight` in px. The top bar's height includes `env(safe-area-inset-top)` once `viewportFit: 'cover'` is on, so it is measured instead of hard-coded. The value is updated on `visualViewport` `resize` and `scroll`, and the property is removed on unmount. iOS Safari ignores the `interactive-widget` viewport key, so this hook is what keeps the composer above the iOS keyboard. On Android it is harmless either way. `layout.tsx` needs no chat change. (An uncommitted UI sweep in this worktree adds `interactiveWidget: 'resizes-content'` and `viewportFit: 'cover'` globally. Chat neither depends on that nor conflicts with it.)
- The composer sits at the bottom with `pb-[max(8px,env(safe-area-inset-bottom))]`.
- On the Messages view (list or thread, any width), Shell hides its generic offline callout ("Schedule and task changes stay saved…"), because the chat view shows its own offline callout (§7 States). That avoids two stacked offline banners in a small viewport.

**Desktop layout.** Two panes inside `app-main`, which on the Messages view is `lg:flex lg:h-dvh lg:flex-col lg:pb-8`. The pane grid is `min-h-0 flex-1 lg:grid lg:grid-cols-[320px_1fr]`. Only the message log and the list scroll.

**Other entry points.** Both navigate to `#messages?with=<id>`:
- a **Message** button (icon `message`) on each People → Friends row, before "See day";
- a primary **Message** button in the profile-sheet footer for friends.

### Chat list (`#messages`)

- `h1` "Messages".
- **Section "Recent"**, `ul aria-label="Chats"`, holds open rows with messages and closed rows.
  - **An open row** is a button with `aria-label="Open chat with {name}"`. It shows:
    - the avatar (the phase-3 `MemberAvatar` pattern);
    - the name, with a verified tick;
    - a one-line preview: "You: {text}", "{text}", "Message deleted", "Hidden by support" or "No messages yet";
    - the time: "now", "{m}m", "4:12 PM" today, "Yesterday", "Mon" within 6 days, otherwise "Sep 3", all in `state.timeZone`. `format.ts` only has date-only helpers, so it gains `instantParts(iso, timeZone): { date: string; time: string }` (via `Intl.DateTimeFormat` with `hourCycle: 'h23'`) and `chatTime(iso, timeZone, now)`. Both reuse `formatTime`, `formatDate` and `todayIn`. Bubble times, day separators and pause dates use the same helpers;
    - an unread pill with `aria-label` "1 unread message" / "{n} unread messages". It is primary colour, or grey when muted.
    - a muted icon `bellOff` with `aria-label="Notifications muted"`.

    An unread row has a bold name.
  - **A closed row** is not a link. It shows the name, the muted text "Chat closed", and a ghost Button "Report" (`aria-label="Report {name}"`) that opens the report modal in chat mode, without the block checkbox.
- **Section "Friends"**, `ul aria-label="Start a chat"`, holds friends with no messages yet. Each row is a button `aria-label="Open chat with {name}"` with the preview "No messages yet".
- **Desktop right pane with nothing selected:** "Pick a chat."

### Thread (`#messages?with=<userId>`)

**Header:**
- IconButton "Back to chats" (phone only, icon `arrowLeft`).
- The name is a button, `aria-label="Open {name}’s profile"`, that goes to `#people?member={id}`. Under it, a small line with the Chip "Verified" (success) or "Not verified" (outline), plus the full name when the phase-3 rule allows.
- IconButton "Mute notifications" / "Unmute notifications" (icon `bellOff` / `bell`).
- Ghost Buttons "Report" and "Block". "Report" is hidden while the thread has no messages (§3.1).
- While polling fails: Hint `role="status"` "Reconnecting…".

**Log:**
- `ol role="log" aria-live="polite" aria-label="Messages with {name}"`, one `li` per confirmed message. While "Load earlier messages" is prepending a page, the log is `aria-live="off"`, so a screen reader doesn't read the whole older page.
- Unsent messages (pending and failed) render after the log in `ul aria-label="Unsent messages"`, inside the same scroller. They sit outside the live region, so a sent message is announced once, when its confirmed copy joins the log. "Not sent." is `role="alert"`, so failures are still announced.
- "Load earlier messages" keeps the reader's place by anchoring on the oldest loaded message, and only when the older page actually lands (a poll that lands first leaves the anchor alone).
- At the top when `hasEarlier`: Button "Load earlier messages" (`busy` while loading).
- Day separators: "Today", "Yesterday", `formatDate(date, { weekday: 'short' })`.
- A divider "New messages" sits above the first message with `seq > lastReadSeq` from the moment the thread opened.
- **Bubbles:**
  - mine: right-aligned, `bg-primary text-primary-foreground`, links `underline decoration-primary-foreground/60`;
  - theirs: left-aligned, `bg-muted text-foreground ring-1 ring-inset ring-foreground/[0.04]`;
  - both: max width 80%, `rounded-2xl`, `whitespace-pre-wrap break-words`, 15 px text;
  - a time ("4:12 PM", xs, muted) under the last bubble of a run and after gaps longer than 10 minutes;
  - `title` on each bubble gives the full timestamp.

  Only theme tokens are used, so light and dark mode both work.
- Deleted: an italic muted "Message deleted" in a dashed-ring transparent bubble. Hidden: "Hidden by support", styled the same way.
- Links are rendered with `linkParts` (§3.6).
- **Message actions:**
  - Each `li` has an IconButton "Message actions" (icon `more`). It shows on hover or focus-within with a fine pointer. On touch, tapping the bubble toggles it.
  - It toggles an inline action row under the bubble. There is no popover.
  - Own messages: Button "Delete" (`aria-label="Delete message"`).
  - Theirs: Button "Add as task" and Button "Report message".
- **Add as task** calls `state.saveTask(crypto.randomUUID(), { title, dueDate: null, dueTime: null, classId: null, notes: '', completed: false })` through the **existing offline queue**. The title is the body with whitespace collapsed to single spaces, trimmed, then cut to its first 120 characters. The row then shows `role="status"` "Added to Tasks."
- **Scrolling:** the log auto-scrolls only when it is already within 80 px of the bottom. Otherwise a floating Button "New messages" (icon `arrowDown`, `aria-label="Jump to new messages"`) appears.
- **Pending:** the bubble is at 60% opacity with a `clock` icon and the caption "Sending…".
- **Failed:** a danger ring, "Not sent." plus the server message when there is one, and Buttons "Retry" (`aria-label="Retry sending"`) and "Discard".

**Focus:** on phones, opening a thread unmounts the list, so focus moves to the thread region ("Chat with {name}", `tabIndex={-1}`). Going back to the list focuses the row of the chat just left, or the "Messages" heading (`tabIndex={-1}`) when that row is gone. Leaving after a block, or a report with block, focuses the heading on every screen size.

**Empty thread:**
- "No messages yet."
- Hint: "Only you and {name} can read this chat. Support sees messages only if one of you reports them."

**Closed:** `NOT_FOUND` from `chat.thread`, or `send` failing with "This chat is closed.", shows an `EmptyState` (icon `lock`) with the title "This chat is closed." and two actions:
- Button "Report", shown only if the inbox has a closed row for this `userId`;
- Button "All chats".

**Paused:** the composer is replaced by the Hint "Support paused your messaging until {date}." or "Support paused your messaging." `{date}` is `formatDate(..., { weekday: 'short' })` plus the time, in `state.timeZone`.

**Composer:**
- `Textarea` from primitives, `aria-label="Message {name}"`, `rows={1}`, `className="min-h-10 resize-none"`, which overrides the primitive's `min-h-24` through `cn`/tailwind-merge. It grows to 5 lines (`max-h-[7.5rem]`, auto-height from `scrollHeight` on input).
- `text-base` (16 px) so iOS doesn't zoom on focus.
- `autoComplete="off"`, `maxLength={1100}`. The server enforces 1000 after normalization.
- Placeholder: "Message", or "Offline" when offline, where the composer is also disabled.
- **Enter:** Enter sends only when `matchMedia('(pointer: fine)').matches`, `!event.nativeEvent.isComposing`, `event.keyCode !== 229` and `!event.shiftKey`. Otherwise Enter inserts a newline. `enterKeyHint` is `"send"` on fine pointers and `"enter"` on coarse pointers, because on a phone a key labelled Send that inserts a newline would be wrong. Phone users send with the button, as the student judge asked.
- IconButton "Send" (icon `send`, filled primary, 40 px circle). It is disabled when `bodyError(normalizeBody(draft))` is not null (empty, zero-width only, or over 1,000), offline, or paused.
- Counter at 100 or fewer characters left: "{n} left".
- **Drafts** are kept per thread in the `use-chat` module map, in memory only, so switching threads doesn't lose them. After a send, the draft clears and focus stays in the textarea.

### Dialogs

Student-facing confirmations use `Modal`, not `confirm()`.

**Delete:**
- Title "Delete for both of you?"
- Body "It disappears from this chat now. Support can still see it for 30 days if this chat is reported."
- Buttons "Cancel", "Delete" (danger).

**Block:**
- Title "Block {name}?"
- Body "You won’t see each other anywhere in Quasar, and this chat closes."
- Buttons "Cancel", "Block" (danger).
- Afterwards the app returns to the list with the success status "{name} is blocked."

**Report:**
- **Title:** "Report {name}" for the chat, or "Report message" for a message.
- **Description:**
  - chat: "Support sees your report and the last 30 messages in this chat. {name} isn’t told who reported."
  - message: "Support sees your report, this message and the messages around it. {name} isn’t told who reported."
- `Segmented` with `label="What’s wrong?"` and `className="w-full flex-col items-stretch"`. Its options are the five `REPORT_CATEGORIES` labels, and nothing is selected at first. `Segmented` requires a `value`, so it is typed `Segmented<ReportCategory | ''>` with `value=''` initially. Radix `ToggleGroup` shows no item as on for an unknown value, and `onChange` never sends `''` back.
- With `danger` selected: an info Callout `role="status"` "If someone is in immediate danger, call 911. For crisis support, call or text 988." The note field's `aria-describedby` points at it, so a screen reader hears it when choosing Danger and again when tabbing to the note.
- The category options are 44 px tall on touch screens.
- `Field` "Anything else? (optional)" wrapping `Textarea id="chat-report-note"` (`maxLength={2000}`).
- `Checkbox` from `ui/checkbox` labelled "Also block {name}", checked by default. It is hidden when the chat is closed.
- Buttons "Cancel", "Send report" (danger). "Send report" is disabled until a category is chosen.
- **Result:**
  - without block: a success Callout `role="status"` "Report sent to support.";
  - with block: back to the list with "Report sent. {name} is blocked.";
  - from a closed row: "Report sent to support."

### States

| State | Copy and presentation |
| --- | --- |
| Offline (list and thread) | Neutral Callout, icon `cloudOff`, `role="status"`: "You’re offline. Messages load when you reconnect." Loaded messages stay visible, the composer is disabled with placeholder "Offline", and drafts are kept. The badge is hidden. |
| Loading | Hint `role="status"` "Loading chats…" (list) / "Loading messages…" (thread) |
| Load error | Danger Callout `role="alert"` with the server message, and Button "Try again" |
| No friends | EmptyState, icon `users`, title "No friends to message yet", body "Chats open once a schoolmate accepts your friend request.", action Button "Find friends", which goes to `#people` |
| Paused (list banner) | Warning Callout: "Support paused your messaging until {date}. You can still read your chats." / "Support paused your messaging. You can still read your chats." |
| Buttons in flight | `busy`, and disabled offline, as in people.tsx |

Background polls never reset an open composer, the report form, or scroll position when the student is not at the bottom.

### People view additions

- Friends row: Button "Message" (icon `message`). Below `sm` it is icon-only (the text stays for screen readers), so friends' names keep their room at 390 px.
- Profile footer for friends: Button "Message" (primary).
- Profile report panel: `Checkbox` "Include our last 30 messages", shown when `hasChat` and checked by default (§3.1).

### Account sheet

- The `Eyebrow` "Reminders" becomes "Notifications".
- `NotificationSettings` gains the props `chatPush` and `onChatPush`, and a `Toggle` labelled "Message notifications" with the description "Uses this browser’s reminder alerts. Never shows names or messages." The Toggle is rendered whenever the server has push configured (`config?.enabled`), below the existing reminder controls. The setting is account-wide, so the config loads whenever the student is online, even on a browser that can't receive push itself, and the switch shows there too. Chat pushes go only to browsers enrolled for reminders (non-goal §10).
- It calls `chat.setPush` and then `session.synchronize()`. It is disabled offline.

### Help (`src/components/help.tsx` FAQ)

| Question | Answer |
| --- | --- |
| "Who can message me?" | "Only friends. Removing a friend or blocking closes the chat for both of you." |
| "Can support read my messages?" | "Only messages attached to a report. A report shares up to 30 messages from that one chat with support. Nobody at Quasar browses chats." |

### Admin (`/admin`)

- The Member reports description gains: "Chat reports include messages from that one chat only, and opening them is logged. Other chats stay private."
- The chat report card has:
  - the Chip "Chat" and the category Chip (`REPORT_CATEGORIES[c].short`, danger tone for `danger`);
  - the history line "{n} reports · {r} removals · {p} pauses", using `pluralize` for each count;
  - the pause line "Messaging paused until {date}" / "Messaging paused until lifted". Admin dates use `instantParts` in the browser's time zone (`browserTimeZone()`), because `/admin` has no `AppState`.
- Button "Show messages ({count})". Its result is `ol aria-label="Reported messages"`, where each line shows "{sender} · {time}" and the text, the tags "Deleted by sender" / "Hidden by support", the Chip "Reported message" on the anchor, and Button "Hide message".
- Button "Pause messaging" opens a Modal:
  - title "Pause {name}’s messaging";
  - `Field` "Pause length" with a `Select` (`aria-label="Pause length"`) offering "1 day", "7 days", "30 days", "Until lifted";
  - `Field` "Reason for the audit log" with `Textarea`;
  - buttons "Cancel" and "Pause messaging".
- New Section "Paused members", description "These accounts can read their chats but cannot send messages.", empty text "Nobody is paused." Each row reads "{name} · until {date}" or "{name} · until lifted", with Button "Lift pause" (`aria-label="Lift pause for {name}"`, so each row's button is distinct).

### Icons (`icon.tsx`)

Add `message: MessageCircle`, `send: SendHorizontal` and `bellOff: BellOff`.

**Form controls rule (AGENTS.md):** Textarea, Select, Segmented (ToggleGroup) and Toggle come from `primitives.tsx`, and Checkbox from `ui/checkbox`. There are no raw inputs.

### Accessible names Playwright uses

| Element | Locator |
| --- | --- |
| Nav (top bar on phone, sidebar on desktop) | `getByRole('link', { name: 'Messages' })` |
| Badge | `master` pattern: `getByLabel('1 unread chat', { exact: true })`. `aria-describedby` pattern: `expect(getByRole('link', { name: 'Messages' })).toHaveAccessibleDescription('1 unread chat')`. The "badge is gone" checks then assert an empty description. Use whichever matches the Tasks and People badges in `community.spec.ts` at the time. |
| Heading | `getByRole('heading', { name: 'Messages', exact: true })` |
| Lists | `getByRole('list', { name: 'Chats' })`, `getByRole('list', { name: 'Start a chat' })` |
| Rows | `getByRole('button', { name: 'Open chat with Bob' })`, closed row `getByRole('button', { name: 'Report Bob' })`, text "Chat closed" |
| Thread | `getByRole('region', { name: 'Chat with Bob' })`, `getByRole('log', { name: 'Messages with Bob' })`, `list 'Unsent messages'` (pending and failed bubbles), `button 'Back to chats'`, `button 'Open Bob’s profile'`, `button 'Mute notifications'`, `button 'Report'`, `button 'Block'`, `button 'All chats'` |
| Composer | `getByRole('textbox', { name: 'Message Bob' })`, `button 'Send'` |
| Message actions | `button 'Message actions'`, `button 'Delete message'`, `button 'Add as task'`, `button 'Report message'`, `button 'Retry sending'`, `button 'Discard'`, `button 'Load earlier messages'`, `button 'Jump to new messages'` |
| Dialogs | `dialog 'Report Bob'` / `dialog 'Report message'` with `radiogroup 'What’s wrong?'` → `radio 'Someone may be in danger'`, `textbox 'Anything else? (optional)'`, `checkbox 'Also block Bob'`, `button 'Send report'`; `dialog 'Delete for both of you?'` → `button 'Delete'`; `dialog 'Block Bob?'` → `button 'Block'` |
| People | `button 'Message'`, `checkbox 'Include our last 30 messages'` |
| Account | `switch 'Message notifications'` |
| Admin | `button /^Show messages/`, `list 'Reported messages'`, `button 'Hide message'`, `button 'Pause messaging'`, `combobox 'Pause length'`, `heading 'Paused members'`, `button 'Lift pause for Bob'` (a plain `'Lift pause'` substring match also works) |
| Statuses | "Report sent to support.", "Report sent. Bob is blocked.", "Added to Tasks.", "Reconnecting…", "This chat is closed." |

---

## 8. File plan

| File | Change | Est. lines |
| --- | --- | --- |
| `src/domain/chat.ts` (new) | `CHAT` constants, `normalizeBody`, `bodyError`, `linkParts`, `rawBodySchema`, `reportCategorySchema`, `REPORT_CATEGORIES` | 45 |
| `src/server/db.ts` | Migration 6 (§4), with guarded `ALTER`s | +45 |
| `src/server/chat.ts` (new) | `ChatService`: `access`, `member`, `notPaused`, `inbox` (open and closed rows), `thread`, `send`, `delete`, `read`, `mute`, `report` (latest 30 or anchored window, optional block), `setPush`, `unreadChats`; admin `showEvidence`, `redactMessage`, `pauseChat`, `liftChatPause`, `chatPauses`; `pruneChat(db, now)` | 290 |
| `src/server/notifications.ts` | `deliverChat(now)`: quiet hours, 10-minute and 20-a-day caps, 60 s delay, claim, recheck, `notified_seq` | +60 |
| `src/server/jobs.ts` | `deliverChat` and `chat.prune` in the one sequential cycle; `onError('chat')`; `Jobs` type | +10 |
| `src/server/community.ts` | `summary()` gains `unreadChats` and `chatPush`; `profile.hasChat`; `reports()` gains `isChat`, `category`, `evidenceCount`, `history`, `pause` and the danger-first sort | +28 |
| `src/server/service.ts` | Reserved display names, checked on new or changed names only | +10 |
| `src/server/router.ts` | `adminScoped` middleware; `chat` sub-router (8 procedures, all `accountScoped`); admin `showEvidence`, `redactMessage`, `pauseChat`, `liftChatPause` (`adminScoped`) and `chatPauses` (`admin`) | +31 |
| `src/server/trpc-log.ts` (new), `src/app/api/trpc/[trpc]/route.ts` | Move the `onError` body into the exported `logTrpcError`, unchanged, so the no-echo test can call it | +8 |
| `src/client/api.ts` | `splitLink`: `chat.send` goes through `httpLink` | +6 |
| `src/lib/format.ts` | `instantParts(iso, timeZone)` and `chatTime(iso, timeZone, now)` | +15 |
| `src/components/app-state.ts` | `'messages'` view, `dock` flag, `chatUnread` and `setChatUnread` on `AppState` | +6 |
| `src/components/tracker.tsx` | Route `messages`; newest-wins unread state by server `unreadAt`; service-worker `CHAT_ACTIVITY` listener; `immersive` | +20 |
| `src/components/shell.tsx` | Top-bar Messages link and badge; sidebar badge; dock filter; `immersive` hides the dock and makes `app-main` a fixed-height column; generic offline callout hidden on Messages; `chatPush` passed to settings; "Notifications" eyebrow | +36 |
| `src/components/use-chat.ts` (new) | Visibility- and online-aware pollers with backoff and abort, the revision cursor, the ordered send queue, lost-response reconcile, drafts and pending sends in a module map (cleared on account change), `useChatViewport` (`--chat-h` from `visualViewport`) | 130 |
| `src/components/views/messages.tsx` (new) | `MessagesView` (list and two panes, closed rows), `Thread`, `Bubble` with `linkParts`, `Composer`, `ReportModal`, delete and block modals, all states | 260 |
| `src/components/views/people.tsx` | Message buttons; "Include our last 30 messages" checkbox | +15 |
| `src/components/admin.tsx` | Chat chips, history line, Show messages, Hide message, Pause modal, Paused members section; keeps `session.user.id` for `adminScoped` calls | +62 |
| `src/components/notification-settings.tsx` | "Message notifications" Toggle | +12 |
| `src/components/icon.tsx` | `message`, `send`, `bellOff` | +3 |
| `src/components/help.tsx` | Two FAQ entries | +2 |
| `public/sw.js` | Text table by `kind`; `CHAT_ACTIVITY` postMessage; click URL allow-list | +16 |
| `PLAN.md`, `docs/ARCHITECTURE.md`, `docs/FABLE_HANDOFF.md`, `docs/OPERATIONS.md` | Phase-4 decisions and exit gate; "Phase 4: chat" architecture section (access predicate, polling, push rules, retention, owner-visibility guarantee); component-map rows for `messages.tsx` and `use-chat.ts` (chat is outside the offline contract); rule against querying `chat_*` tables | +40 |
| `src/server/chat.test.ts` (new) | Server rules (§9) | 230 |
| `src/server/notifications.test.ts` | `deliverChat` cases | +50 |
| `src/server/jobs.test.ts` | Existing fakes gain `deliverChat` and `prune`; order and error isolation | +12 |
| `src/server/community.test.ts` | Summary `toEqual` gains `unreadChats: 0, chatPush: true, unreadAt: expect.any(String)` | +2 |
| `tests/e2e/chat.spec.ts` (new) | Browser scenarios (§9) | 180 |
| **Total** | | **≈ 1,640** (about 1,110 app code, 40 docs, 490 tests) |

This is above the ~1,420 the judges accepted for the base spec, and above the ~1,300 phase-3 size, because of the grafts and the review fixes. The cuts below are ordered and explicit. Make them in order if the session runs long:

1. **Per-message "Report message" with the anchored window** (−45). The header Report and the closed-row Report still send the latest 30.
2. **Reserved display names** (−25, including their test).
3. **"Add as task"** (−15).
4. **"Jump to new messages" pill** (−15). The log always auto-scrolls instead.
5. **Desktop two-pane layout** (−30). Desktop uses the phone's single pane.
6. **Help FAQ entries** (−2).
7. **Open-ended pauses and the "Paused members" section** (−45: `admin.liftChatPause`, `admin.chatPauses`, the section and their tests). `days` becomes `z.union([z.literal(1), z.literal(7), z.literal(30)])`, not nullable, so every pause expires by itself. Escalation beyond 30 days is **Remove from school**.

Cuts 1–3 bring the total to about 1,555, cuts 1–5 to about 1,510, and cuts 1–7 to about 1,465. The session should plan for cuts 1–3 from the start.

These are never cut:
- `access` on every call, and `accountScoped` everywhere;
- closed rows and `member`-only reports;
- frozen evidence and the audited `showEvidence`;
- pauses;
- every rate and push cap;
- `splitLink` and `UNIQUE(sender_id, id)`;
- no revision returned from `send`;
- the router allowlist test and the revocation tests.

---

## 9. Tests

### Vitest: `src/server/chat.test.ts`

**Setup:**
- It reuses the `fixture()` pattern from `community.test.ts`: alice and bob at Community High, outsider at Other High, owner.
- It adds cara at Community High.
- A `befriend(a, b)` helper uses `request` and `respond`.
- `new ChatService(service, () => clock)` gets an injectable clock, and `caller(id)` uses `appRouter.createCaller`. Cases that move the clock (4, 6, 11, 13) call `ChatService` directly. Cases about binding, scope and the admin surface (1, 10, 12) go through `caller`.

**Cases:**

1. **Scope.**
   - Accepted friends can send and read.
   - A pending request, a schoolmate who isn't a friend, and the outsider each get `NOT_FOUND` "This chat is closed." on `thread`, `send`, `read` and `mute`.
   - Messaging yourself gives `BAD_REQUEST`.
   - After bob joins Other High, the friends can still chat, and `peer.verified` reflects his new school.
   - The owner's `chat.thread` on the alice–bob pair gives `NOT_FOUND`.
2. **Idempotent send.**
   - The same `clientId` and body sent twice gives one row and the same `seq`.
   - The same `clientId` with a different body, or to a different friend, gives `BAD_REQUEST`.
   - Two different senders using the same `clientId` both succeed (`UNIQUE(sender_id, id)`).
   - A retry succeeds after the per-minute limit is used up, and after a pause starts.
   - A retry of a message deleted since returns it as deleted.
3. **Body rules and no echo.**
   - Whitespace-only and zero-width-only bodies are rejected, and so is a 1001-character body.
   - `‮` and control characters are stripped. `\n` is kept, `\r\n` is normalized, and three or more newlines collapse to two.
   - For each rejected body containing the marker `ZX-SECRET-42`, the caught `TRPCError.message` does not contain the marker.
   - `logTrpcError({ path: 'chat.send', error })`, with `console.error` spied, logs a line that doesn't contain it either.
   - A 5,000-character body containing the marker fails zod's `max(4000)`, and neither the error message nor the logged line contains the marker.
4. **Rate limits.**
   - 20 sends in a minute pass, and the 21st gives `TOO_MANY_REQUESTS`. After the clock moves forward 61 s, sending passes again.
   - 500 seeded rows in 24 h trigger the daily message.
   - With 21 friends, the 21st new conversation in 24 h fails. A 21st message in an existing chat passes.
5. **Revocation (the exit-gate core).** After messages exist:
   - (a) `community.remove`: `thread` and `send` give `NOT_FOUND` for both, the open rows leave `inbox`, and `workspace().community.unreadChats` drops to 0 immediately.
   - (b) Becoming friends again brings the history back.
   - (c) A block in either direction gives `NOT_FOUND` for both. After unblocking, it is still `NOT_FOUND` until they are friends again.
   - (d) After `removeFromSchool(bob)`, every chat of bob's gives `NOT_FOUND`, and open chat reports against him end with `outcome='removed'`.
6. **Closed rows.**
   - After an unfriend, both inboxes show `{ state: 'closed' }` with no preview and no text field.
   - After a block, both inboxes show a closed row, and the rows are deep-equal in shape to the unfriend case: no field reveals the cause.
   - With the clock 31 days after the last message, the rows are gone.
   - **Bob harasses Alice, then Bob blocks Alice.** Alice's inbox still shows the closed row. `chat.report({ userId: bob, category: 'bullying', block: false })` succeeds, and the evidence contains Bob's messages.
7. **Unread and read.**
   - Bob sends 3 messages in one chat and cara sends 1 in another, so alice's `unreadChats` is 2 (chats, not messages).
   - `read` of the 2nd message leaves that row's `unread` at 1 and `unreadChats` at 2. Reading the last message makes it 1.
   - A lower `seq` is ignored, and a `seq` past the end is capped.
   - Your own messages and deleted messages never count.
   - A muted chat is excluded from `unreadChats` but keeps its row `unread`.
8. **Delete and cursors.**
   - Only the sender can delete: bob deleting alice's message gives `NOT_FOUND`.
   - Both people see `body: null, deletedBy: 'sender'`.
   - `thread({ after: previous revision })` returns the deletion.
   - `send` returns no `revision` key.
   - With 120 messages: the first page is the latest 50 with `hasEarlier`; `before` walks back until `hasEarlier` is false; more than 200 changes returns `reset: true`. `after` greater than the thread's revision (and `after: 5` on a pair with no thread) also returns `reset: true`.
9. **Reports.**
   - The header report holds the latest 30 from both people, including one deleted before the report (text present, `deletedBy: 'sender'`). A message whose text was erased is excluded.
   - The anchored report (`seq`) holds 15 before, the anchor with `anchor: true`, and 14 after. Anchoring on your own message gives `BAD_REQUEST`.
   - A second open report on the same thread gives `CONFLICT`, and reports count toward the cap of 10.
   - `block: true` blocks in the same call.
   - A deletion after the report leaves the snapshot unchanged.
   - `category` is stored, `reason` equals "Bullying or harassment: {note}", and `danger` reports sort first in `admin.reports`.
   - A report on a thread with no messages (created by `mute`) gives `BAD_REQUEST` "This chat has no messages to report.", and no `reports` row is written.
   - A report whose `block: true` fails after the insert leaves neither the report nor the block (one transaction).
10. **What the owner can see.**
    - `Object.keys(appRouter._def.procedures).filter(k => k.startsWith('admin.'))` equals the expected list exactly: today's 11 (`schools`, `update`, `requests`, `resolveRequest`, `verificationRequests`, `decideVerification`, `reports`, `resolveReport`, `removeMember`, `proposals`, `decideProposal`) plus `showEvidence`, `redactMessage`, `pauseChat`, `liftChatPause` and `chatPauses`. This key shape was checked against tRPC 11.18 in this repo.
    - `admin.reports` output, serialized, contains no message text.
    - `admin.showEvidence` returns only the reported thread's snapshot and writes an `audit_log` `reports.view` row.
    - A second, unreported alice–cara chat's text (a marker string) appears in the serialized output of no admin procedure.
    - Non-owners get `FORBIDDEN`.
    - `redactMessage` with a `seq` outside the snapshot gives `NOT_FOUND`. With a `seq` inside it, both students see `deletedBy: 'support'`, and a second `showEvidence` shows that item as `deletedBy: 'support'`.
    - Every owner action writes `audit_log`, and the history line counts reports, removals and pauses correctly.
11. **Pause.**
    - After a 7-day pause, bob's `send` gives `FORBIDDEN` "Support paused your messaging.", while `inbox`, `thread`, `mute`, `report` and `community.block` still work, and `pause.until` is set.
    - Friends can still send to him.
    - Open reports against him resolve as `paused`.
    - With the clock past `until`, he can send again. `days: null` lasts until `liftChatPause`.
12. **Account binding.** `caller(alice).chat.send({ accountId: bob, … })` and `caller(alice).chat.inbox({ accountId: bob })` give `UNAUTHORIZED`, and so does `caller(null).chat.inbox(…)`. `caller(owner).admin.showEvidence({ accountId: alice, reportId })` gives `UNAUTHORIZED` and writes no `audit_log` row.
13. **Retention.** Running `pruneChat(db, now)`:
    - deletes a 181-day-old message;
    - erases the text of a message deleted 31 days ago;
    - clears the evidence of a report resolved 181 days ago, while the report row stays;
    - deletes a thread idle for 181 days, along with its members;
    - removes chat delivery rows older than 2 days.
14. **Reserved names.** `profile.save` rejects "Quasar Support", "s.u.p.p.o.r.t" and "Admin Team". It accepts "Stafford" and "Badminton Bob". A stored reserved name that stays unchanged can still be saved with a new full name.
15. **Migration.** Opening the same database file twice is safe. `schema_migrations` contains 6. `reports` has `thread_id`, `evidence` and `category`, and `users` has `chat_push`.

### Vitest: `src/server/notifications.test.ts` (`deliverChat`)

- a. No push before 60 s, and exactly one after. The payload equals `{"kind":"chat","tag":"quasar-chat"}` and doesn't contain the text or either display name.
- b. A new `NotificationService` instance (a restart) doesn't push the same messages again. A new message within 10 minutes gives no push, and after 10 minutes gives one.
- c. With a message every 11 minutes over a day, the 21st push in 24 h is withheld.
- d. No push in these cases, each checked again right before sending:
  - the message was read;
  - the chat is muted;
  - `chat_push=0`;
  - the pair unfriended or blocked;
  - it is 23:00 in `America/New_York` for a student with no school (07:05 pushes);
  - the message is more than 24 h old.
- e. Two `deliverChat` calls running at the same time send once. A 410 response deletes the subscription.
- f. `deliverDue` ignores `chat:messages` rows.

### Vitest: `src/server/jobs.test.ts`

- The existing tests' fakes gain `deliverChat` and `prune`.
- One cycle runs `refreshDue` → `deliverDue` → `deliverChat` → `prune` in order, with no overlap.
- A failing `deliverChat` reports `onError('chat')`, `prune` still runs, and the next cycle retries.

### Playwright: `tests/e2e/chat.spec.ts`

**Setup.** It copies `seed()`, `authenticate()` and `signedIn()` from `community.spec.ts`, and adds:
- `seed({ friends: [['alice','bob'], ['bob','cara'], ['alice','cara']] })`, which inserts accepted `friendships` rows and a third user, Cara;
- `phone(browser, id)`, which opens a context with `viewport: { width: 390, height: 844 }`, `hasTouch: true` and `isMobile: true`, so the pointer is coarse;
- a local copy of the `choose()` select helper;
- `seed({ messages: [['bob','alice','text'], …] })`, which stores messages through `new ChatService(service).send(...)` with fresh `clientId`s, so seeded rows have valid `seq`, `revision` and `last_message_at`. Scenarios 4 and 5 use it;
- `badge(page)`, which returns the Messages badge assertion target for the pattern in §7 (label or accessible description).

There is no worker in the e2e server, so push is covered by Vitest only.

1. **"friends chat, the badge counts unread chats, and deletion reaches both sides."**
   - Alice (desktop) opens `#messages`. `list 'Start a chat'` contains Bob. She clicks "Open chat with Bob" and sees the privacy hint "Only you and Bob can read this chat."
   - She fills `Message Bob` with "Hi Bob", presses Enter, and "Sending…" appears and then clears.
   - Bob (phone) is on `#today`. `.tabbar a` has count 6. The Messages badge reads "1 unread chat" within 20 s (`badge(page)`).
   - He taps link "Messages" and then "Open chat with Alice". `log 'Messages with Alice'` contains "Hi Bob", `.tabbar` is hidden, and `Message Alice` is inside the viewport.
   - He opens "Message actions" on "Hi Bob" and taps "Add as task". "Added to Tasks." appears.
   - He types "Hey" and presses Enter; the textbox value contains a newline, because the pointer is coarse. He taps "Send".
   - Alice sees "Hey" within 10 s without reloading.
   - Alice uses "Delete message" and then "Delete" in `dialog 'Delete for both of you?'`. Bob sees "Message deleted" within 10 s.
   - Bob goes back to `#tasks`, where a task "Hi Bob" exists, and the badge is gone.
   - Screenshots of the list and the thread at 390×844 and at desktop size, in light and dark (`emulateMedia({ colorScheme: 'dark' })`).
   - At 390 px there is no horizontal overflow.
2. **"a failed send keeps the text and retries without duplicating."**
   - `page.route('**/api/trpc/chat.send*', r => r.abort())`, then send "Math at 3?". After the automatic retry the bubble shows "Not sent." Unroute, then "Retry sending" delivers it.
   - Lost response: route `chat.send` with `async r => { await r.fetch(); await r.abort(); }`, so the server stores the message but the browser never sees the answer, then send "See you there". **Don't assert the in-between "Not sent." state.** The 4 s thread poll may reconcile the bubble before the automatic retry gives up, so that assertion would be flaky. Assert the end state: within 15 s the bubble shows neither "Sending…" nor "Not sent.". If it does show "Not sent.", that is still fine, as long as it clears by itself on the next poll without **Retry**. Then unroute.
   - Reload: `getByText('Math at 3?')` and `getByText('See you there')` each have count 1. On Bob's side, each also appears once.
3. **"offline shows the connect state and recovers."**
   - Seed one unread message from Cara to Alice first, so the badge has something to hide. `context.setOffline(true)`: "You’re offline. Messages load when you reconnect." shows, and Shell's generic offline callout does not. The composer has placeholder "Offline" and is disabled, the typed draft stays, and the badge is hidden.
   - Bob sends a message meanwhile.
   - `setOffline(false)`: the composer is enabled again, the draft is still there, and Bob's message appears without a reload.
   - **Nothing on the device (D5).** Alice sends "ZX-DEVICE-7", and Bob replies "ZX-DEVICE-8". After both show, a `page.evaluate` reads every record of every object store in the `whatsnext-offline-v1` IndexedDB database (the open pattern from `tracker.spec.ts`'s sign-out test), all of `localStorage` and `sessionStorage`, and every Cache Storage entry's body. It asserts that neither marker appears. "Add as task" isn't used in this scenario, so a task can't carry the text legitimately.
4. **"the harasser blocking first still leaves the victim a report path, and support sees only that chat."**
   - Seed: Bob sends Alice three messages. Alice and Cara have a separate chat containing "secret plans".
   - Bob blocks Alice through the thread's "Block" and then "Block" in the dialog. Bob sees "Alice is blocked." and his list shows Alice under "Chat closed".
   - Alice's list shows Bob with "Chat closed". Alice clicks "Report Bob", chooses `radio 'Someone may be in danger'`, and the 911/988 callout is visible. She adds a note and clicks "Send report", then sees "Report sent to support."
   - The owner opens `/admin`. The first report card shows "Chat" and "Danger" and the history line "1 report · 0 removals · 0 pauses". "Show messages (3)" reveals `list 'Reported messages'` with Bob's three texts, and the page never contains "secret plans".
   - The owner clicks "Pause messaging", chooses "7 days" in "Pause length", enters a reason and confirms. "Paused members" lists Bob.
   - Bob opens his chat with Cara and sees "Support paused your messaging until …", and there is no "Send" button.
5. **"reporting a message with block closes the chat identically for both."**
   - Bob sends Alice two messages.
   - Alice opens "Message actions" on the second, clicks "Report message", chooses "Bullying or harassment", leaves "Also block Bob" checked and sends. She sees "Report sent. Bob is blocked." and a "Chat closed" row for Bob.
   - Bob's open thread shows "This chat is closed." at the next poll, with no `Message Alice` textbox. His list shows "Chat closed", the same presentation as in scenario 4.
   - The owner's "Show messages" marks the second message "Reported message".

**How the exit gate is covered:**

| Area | Vitest | Playwright |
| --- | --- | --- |
| Who can message whom | 1, 5, 12 | 1, 5 |
| Immediate revocation and closed rows | 5, 6 | 4, 5 |
| Abuse handling | 3, 4, 9, 10, 11, 13, 14 and the push tests | 4, 5 |
| Reliability | 2, 8 | 2, 3 |

---

## 10. Non-goals for this phase

- Group chats beyond the single global room in §11: friend groups, class groups, school-wide rooms. Messages or message requests from people who aren't friends.
- Images, files, voice, stickers, GIFs, reactions, replies or quotes, forwarding, editing (delete and resend instead), pinning, search, export.
- Link previews, link reputation checks, and any server fetch of message content. Clickable `http://` and other non-https schemes.
- Read receipts, typing indicators, online presence, "last seen" (D10).
- SSE, WebSockets, tRPC subscriptions, and any new service (Redis, an external chat provider). In-app sounds, and desktop notifications while the tab is open.
- Offline chat: no IndexedDB, no offline-queue sends, no service-worker caching, no persisted unsent messages or drafts. "Add as task" is the only chat action that goes through the offline queue, because it creates a task.
- Names or message text in push notifications, and any email or SMS alerts. Per-browser chat settings separate from reminder enrollment. The controls are the account toggle and per-chat mute.
- Automated moderation in one-to-one chat: keyword filters, ML classifiers, crisis-content detection. (The global room has a slur filter, §11.) Moderation by students or teachers, parent accounts, age checks.
- Encrypting messages at rest, or end to end. The guarantee is that no product or API path shows unreported chats, and that evidence views are audited.
- Owner tools beyond reports: browsing chats, message analytics, appeal workflows, notifying the reported student, penalties for abusive reporters.
- A support or Quasar chat account, and owner broadcast messages.
- Account deletion and data export. The retention rules in §3.5 are the only deletion.
- Verification-gated chat. It exists as `CHAT.requiresVerification`, off by default.
- Changing the six-tab phone dock, a Today-view chat widget, or an unread count in the document title.

## 11. Global chat (migration 7)

Added 2026-09-24. One room, **Global chat**, that every member with names entered can read and post in, across schools. It is public by design, so the rules are the opposite of one-to-one chat in two places: there is no privacy guarantee toward the owner, and the owner moderates it directly.

**Where it lives.** The chat list (`#messages`) starts with a **Group chats** section holding one row, "Global chat", above Recent and Friends. It opens at `#messages?room=global`, which is immersive on phones like a thread. The row shows the newest message as "Name: text", the viewer's unread count and a mute icon. The room counts as one unread chat in the badge when it has unread messages from others and is not muted (`countUnreadChats`).

**Push.** `deliverChat` treats the room as one more candidate (`GLOBAL_CANDIDATE_SQL`, keyed `'global'`) under the §6 rules: the same 60 s delay, 10-minute and daily caps, quiet hours, the account's Message notifications switch, the room's own mute, and `global_members.notified_seq` so nothing is pushed twice. The payload is the same generic one.

**Thread.** Each run of someone else's bubbles carries the sender's display name (with the verified check when they are verified). Mute is per member. There is no Block, Report or closed state. The empty state says who can read it and that slurs are blocked.

**Filter (`src/domain/chat-filter.ts`).** `hasSlur` matches a fixed list of slurs as whole words after normalization (lowercase, accents stripped, leetspeak mapped, censor marks treated as wildcards, repeated letters allowed, spaced-out letters joined). Ordinary swearing passes. The composer disables Send and shows the reason (`SLUR_ERROR`, a fixed string) while the draft has a slur in it, and the server refuses the send or edit with the same string. Message text is never echoed.

**Owner tools.** Every bubble's actions menu offers the owner **Edit** and **Remove** (on their own messages, Delete). Both take an optional reason (200 characters) that everyone sees: a removed message reads "Removed by the owner: reason"; an edited one keeps the new text and reads "Edited by the owner: reason" under it. Both are recorded in `audit_log` (`global.edit`, `global.delete`) with the seq, sender and reason. A sender can delete their own message ("Message deleted", no reason). Nobody else can edit.

**The ICE prank.** Under any room message that mentions "immigrant" or "immigrants", the client renders a deadpan joke line: "📞 Name said “immigrants”. Incident forwarded to the ICE hotline. Case #ICE-000042. Status: line busy, hold music playing, estimated response time never." The case number is the message seq, and the never-answered status is the tell; it deliberately stops short of a realistic notice with no tell, which could frighten a student with immigrant family. It is computed on the client from the message text (`mentionsImmigrants`, `icePrankNotice`); nothing is stored, sent or reported anywhere.

**Data (migration 7).** `global_chat` (one row: `revision`, `last_message_at`), `global_messages` (`seq`, `id`, `sender_id`, `body`, `created_at`, `edited_at`, `deleted_at`, `deleted_by` in `sender|owner`, `reason`, `revision`, unique on `(sender_id, id)`), `global_members` (`user_id`, `last_read_seq`, `notified_seq`, `muted`). Retention matches §3.5 (`pruneGlobalChat`: 180 days, deleted text emptied after 30) and runs in the worker's chat step. Messaging pauses (§3.4) and the per-minute and per-day limits (§3.3) apply to the room; new-chat limits do not.

**API (`global` router, all account-scoped).** `thread({ after? | before? })` returns `{ peer: null, room: { members, canModerate }, messages, revision, lastReadSeq, hasEarlier, reset, muted, pause }`, the same page shape as `chat.thread`, so `useChatThread` drives both with a `ChatTarget` (`{ kind: 'peer', userId }` or `{ kind: 'global' }`). `send({ clientId, body })`, `delete({ messageId, reason })`, `edit({ messageId, body, reason })` (owner, `adminScoped`), `read({ seq })`, `mute({ muted })`. `chat.inbox` gains `global: { lastMessage, unread, muted }`. Messages carry `sender: { id, displayName, verified }`, `editedAt` and `reason`.

**Tests.** `src/domain/chat-filter.test.ts` (swearing passes, slurs and obfuscations fail, innocent words pass), `src/server/global-chat.test.ts` (access, filter, delete and edit permissions with reasons and audit rows, revision polling, paging, unread and mute, limits and pauses, retry IDs, retention, account scoping) and the "global chat" test in `tests/e2e/chat.spec.ts`.
