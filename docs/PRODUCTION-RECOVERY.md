# Production source recovery, November 10, 2026

The release source is `/home/zion/.cache/quasar-ai-schoology-recovery`, on branch `recovery/ai-schoology-20261110`. It combines current live school release `2ff1be9` with the original AI and Schoology implementation at `0db76f0` and the preserved working changes from `/home/zion/.t3/worktrees/quasar/t3-b9a933a4`.

Use this source as the base for future deployments. The production checkout `/srv/NAS/Private/GitHub/quasar` runs the built `.next` files but its source is older. Building that checkout directly would remove the restored features again.

The School hub, school logos, lunch menu, phone navigation, and saved countdown remain from the live school release. The AI and Schoology gates use `ai-tools` and `schoology-connect`; the old keys were retired. Join codes live only in the production beta registry, managed through `pnpm run beta` in the production checkout.

The deployment script is `/home/zion/.cache/quasar-ai-schoology-recovery-deploy.sh`. It holds `/tmp/quasar-production-deploy.lock`, requires the expected old build, keeps a rollback copy, and checks local health, public health, and exact public JavaScript assets. The original expected build is `zIGJ4DrDlchYttiuhhSYa`. Update the guard only after verifying the current live source.

The production worker still runs source from the production checkout. Preserve its two optional `workLocation` and `workLocationSource` task schema fields until a future source update includes them. This release does not change the worker checkout, push a branch, or merge master.

## Later releases on this base

Other releases have gone on top of the recovery since. Each one is a branch that contains the one before it, so the newest branch is the base for the next deployment:

1. `recovery/ai-schoology-20261110` at `6454125`, the recovery described above.
2. `release/now-split-20261110` at `d992222`, which adds the second-school-day release and the `now-card-split` beta.
3. `release/logo-votes-20261110` at `3a0ff65`, which adds school logo votes (migration 35).
4. `release/rotation-dates-20261110` at `b4e95cc`, which merges master (the second school day for everyone, PR #82) and adds rotation day dates to the school hub.
5. `release/grades-20261110`, in the worktree `/home/zion/.cache/quasar-grades-release`, which adds Classes → Grades to the `schoology-connect` beta.
6. `release/classes-board-20261110`, in the worktree `/home/zion/.cache/quasar-classes-board-release`, which merges `t3/classes-page-five-mockups`: the Classes page as one board (class list beside one week of the timetable) for the public `classes-board` beta. Its merge keeps the Grades tab: the board replaces only the Timetable tab's cards and stacked weeks.

`/home/zion/.cache/quasar-LIVE-SOURCE.txt` names the build that is live and the worktree it came from. Every session that deploys rewrites it, so read it first: several sessions deployed within an hour on November 10, and the live build changed three times while the Grades release was being built.

## Classes → Grades, November 10, 2026

The Grades release is deployed with `/home/zion/.cache/quasar-grades-deploy.sh` (`build`, then `swap`). The script refuses to run unless the live `BUILD_ID` is the one it expects and the release branch contains the live source. It holds `/tmp/quasar-production-deploy.lock`, keeps a rollback copy of the previous `.next`, and rolls back by itself if local health, public health, or a byte-for-byte check of the public JavaScript fails.

What it changes in production:

- A new table, `schoology_grade_goals`, created with `IF NOT EXISTS` when the app starts. It holds one goal per member and Schoology section. No migration number is used, for the same reason as the other Schoology tables. The worker's older source does not know the table and does not need to.
- No grade is stored anywhere. The gradebook cache lives in the app process's memory and is empty after a restart.
- `schoology-connect` is a public beta from this release on: members join it in Account → Betas with a tap. It was made public with `pnpm run beta -- public schoology-connect` in the production checkout, after the deploy. It had no members at that moment, so nobody carried over from the old code. `ai-tools` stays private and keeps its code.
- `SCHOOLOGY_API_URL` is for the browser tests only and must stay unset in production.

The worker still runs the production checkout's source with its two optional task fields, unchanged by this release.

### What went live

The swap ran on November 10, 2026 at 10:47 EST. Production went from build `O3kaNUvK7R31y9s9PxnxB` to `YyuNf9EwDoUDDRcYl3GQb`, built from `release/grades-20261110` at `84a8afd`. Commits after `84a8afd` on that branch change this document and one browser test only, so the live build still matches the branch's application code. The previous build is kept at `/home/zion/.cache/quasar-next-rollback-O3kaNUvK7R31y9s9PxnxB`.

Checked after the swap:

- Local and public `/api/health` answered 200, and the public page named the new build.
- The 17 JavaScript files the public page loads matched the build byte for byte. So did the chunks that carry Grades, the school hub, logo votes, the lunch menu, the saved countdown, `now-card-split` and the AI task helpers.
- The production database went from 78 tables to 79. The new one is `schoology_grade_goals`, empty. No other table lost a row because of the release.
- `pnpm run beta -- list` shows `schoology-connect`, `school-hub` and `now-card-split` public, and `ai-tools` private.

Checked before the swap, on the build that shipped: typecheck, 1435 of 1435 unit tests, and 140 of 142 browser tests with one worker, including all four in `grades.spec.ts`. The two failures were rerun against the previous live build and fail there the same way, so this release did not cause them:

- `parent-summary.spec.ts` looks for "Share a weekly summary with a parent" in Account. Nothing renders `ParentSummarySettings` since the recovery (`6454125`); the preserved working changes took it out of the AI settings and out of the Plus feature list. The server side and `/summary/[token]` are still there. The spec stays red until the switch comes back or the spec is retired.
- `plan.spec.ts` had three assertions the preserved working changes left behind: the Heavy days button's name now carries the estimate, the seeded test is called "Study for Unit 4 Test", and a task with no notes gets no estimate. The app was right each time. The assertions were corrected after the swap and the spec passes on the shipped build.

Not verified on production: whether a student other than the API key's owner can finish connecting Schoology. The one connection in production belongs to the owner.
