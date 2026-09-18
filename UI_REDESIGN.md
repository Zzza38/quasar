# Quasar UI redesign

Complete replacement of the presentation layer. The domain (`src/domain`), server (`src/server`), typed client (`src/client`), authentication and the offline queue are kept as they are; every screen, style and interaction is rebuilt.

## Why the previous UI was untestable

- Creating a school, building a personal schedule, editing overrides, admin review, device conflicts and school-change review all required hand-editing raw JSON in textareas.
- The whole app was one long scrolling page; the "navigation" was anchor links.
- No way to see what a rotation or exception actually produces before saving it.
- Marketing-style filler copy everywhere instead of information.

## Design direction

- Phone-first with a bottom tab bar; sidebar on desktop. Light and dark appearance plus selectable accent palettes from one token set; the choice is stored on the device.
- Five views behind hash routes so the offline shell keeps working: **Today**, **Schedule**, **Tasks**, **Classes**, **School**. Owner-only **Admin** stays at `/admin`.
- Today answers two questions instantly: what is happening now / next (with countdown and progress) and what is due.
- Every schedule concept gets a structured editor with a live preview computed by the real `resolveDay` engine.
- Saving, waiting to sync, syncing, saved, failed and conflict states are always visible in one status pill.

## Plan

### Foundation
- [x] Design tokens, dark mode, base styles, form controls, buttons, cards, dialogs, layout (`src/app/globals.css`)
- [x] Expanded icon set (`src/components/icon.tsx`)
- [x] Formatting and ID helpers: 12-hour times, relative dates, week ranges, countdowns, class colours (`src/lib/format.ts`)
- [x] UI primitives: Button, Field, Select, Modal (dialog), Toggle, Segmented, Chip, EmptyState, Callout (`src/components/primitives.tsx`, built on shadcn/ui in `src/components/ui/`)

### Schedule editing (replaces all JSON editors)
- [x] Structured school schedule editor: time zone, school/advance weekdays, periods (class/lunch/other), rotation days with ordered time slots, anchor, exceptions (closure/replacement/reset), validation with readable errors, live date preview (`src/components/schedule-editor.tsx`)
- [x] Templates for new schools (simple weekly, A/B, rotating cycle) so a student never starts from an empty form
- [x] Personal overrides editor: close/reopen a date, shift times, custom periods for a date, custom periods for a cycle day, optional private custom schedule (`src/components/overrides.tsx`)

### Screens
- [x] Sign-in welcome screen (`Welcome` in `src/components/shell.tsx`)
- [x] Onboarding wizard: names → find or create school (template + structured editor) → explicit schedule choice with preview → done (`src/components/onboarding.tsx`)
- [x] App shell: sidebar / tab bar, sync status pill with retry, offline banner, account sheet with safe sign-out (`src/components/shell.tsx`, `src/components/tracker.tsx`, session logic in `src/components/use-workspace.ts`)
- [x] Today view: now/next card with countdown and progress, today's timeline, due-soon tasks with quick add (`src/components/views/today.tsx`)
- [x] Schedule view: day navigation, week strip with cycle-day labels, full day list, rotation overview with next occurrence, per-date and per-cycle-day adjustments (`src/components/views/schedule.tsx`)
- [x] Tasks view: quick add, grouped by due date, class filter, edit sheet with quick due dates, completed section (`src/components/views/tasks.tsx`)
- [x] Classes view: class cards with colours, period assignment grid with "meets on" hints, stale-assignment cleanup, adjustments and private schedule entry points (`src/components/views/classes.tsx`)
- [x] School view: status and lock explanation, schedule source, shared schedule summary/preview, structured shared editor with stale-revision handling, correction requests (`src/components/views/school.tsx`)
- [x] Readable device-conflict resolution (field comparison, keep mine / use other) and school-change review (what changed + affected personal settings) (`src/components/conflicts.tsx`)
- [x] Admin: schools table with status, correction inbox, structured editor in a review sheet, approve and lock (`src/components/admin.tsx`)

### Cleanup and verification
- [x] Remove `json-editor.tsx`, `draft-change.tsx` and the old `schedule.tsx` / `tasks.tsx` components
- [x] `npm run typecheck`, `npm test` (76 tests), `npm run build`
- [x] Rewrite browser tests for the new screens and run them: 8 Chromium tests pass (`npx playwright install chromium` was needed)
- [x] Visual check of desktop and mobile layouts, light and dark, from the test screenshots
- [x] Update README and handoff docs to describe the new UI

## Progress log

- 2026-09-11 (first session): tokens, icons, formatting helpers, UI primitives, structured school schedule editor with templates and live preview, personal overrides sheets, readable conflict/review components, Today and Tasks views, `app-state.ts`.
- 2026-09-11 (second session): extracted the account/offline/sync logic from the old `tracker.tsx` into `use-workspace.ts` unchanged in behavior; added the shell with hash routes (`#today`, `#schedule?date=…`, `#tasks?edit=…`, `#classes`, `#school`), status pill, banners and account/sign-out sheets; welcome screen; onboarding wizard with structured school creation (templates → editor → create, explicit approved/community/private choice with preview); Schedule, Classes and School views; admin rewrite; removed every JSON editor. `Toggle` became a real `role="switch"` button. Custom CSS moved into `@layer base` / `@layer components` so Tailwind utilities can override component styles (this had silently broken responsive `hidden` classes and heading sizes). Browser tests rewritten and extended with a shared-schedule editing test and a screenshot sweep of every screen.

- 2026-09-11 (themes): appearance (System / Light / Dark) and seven accent palettes (Ocean default, Indigo, Grape, Forest, Sunset, Rose, Graphite) chosen from the account sheet, with a one-tap light/dark toggle on the welcome screen. Preferences are device-level in `localStorage` (`quasar.appearance`, `quasar.accent`), applied by an inline boot script in `layout.tsx` before first paint, and driven entirely by `data-appearance` / `data-accent` attributes on `<html>` (`src/lib/theme.ts`, `src/components/theme-picker.tsx`). Browser test covers choosing, applying and persisting a theme.

- 2026-09-17 (shadcn/ui): the presentation layer now runs on [shadcn/ui](https://ui.shadcn.com) (Radix base, lucide icons, `components.json`, `src/components/ui/*`). The ~460 lines of hand-written component CSS were replaced by shadcn components plus Tailwind utilities; only the drag-and-drop time canvas keeps custom CSS. The light/dark + seven-accent theme system is unchanged for users (same `data-appearance` / `data-accent` attributes and `localStorage` keys) but is now expressed through shadcn's variables (`--primary`, `--muted`, `--card`, `--sidebar`, …) so every shadcn component follows the chosen accent automatically. Notable component mappings: shell → `Sidebar` (icon-collapsible, tooltips, ⌘/Ctrl+B) with a mobile top bar and bottom tab bar below `lg` (1024px); sheets → `Dialog` (`Modal`) and the account panel → `Sheet`; chips → `Badge`; callouts → `Alert`; toggles → `Switch`; task checkboxes → `Checkbox`; schedule editor sections → `Tabs`; single-choice pickers (appearance, grades, day mode, exception type) → `ToggleGroup` (radios); multi-select pickers (weekdays, copy-to grades, class filter) → `Toggle`; diff and admin tables → `Table`; period progress → `Progress`; avatars → `Avatar`. `src/components/ui.tsx` became `primitives.tsx`. Browser tests were updated for the new ARIA roles (`tab`, `radio`, `radiogroup`) and the 1024px layout breakpoint; all 18 pass.

- 2026-09-18 (visual revamp): every signed-in screen, onboarding, dialogs and admin were restyled on the same shadcn foundation. Typography is Manrope, self-hosted through `next/font/google` (`src/app/layout.tsx`) and exposed as `--font-sans`. Tokens gained layered shadows (`--shadow-card`, `--shadow-float`, `--shadow-pop`), a larger radius scale, a page backdrop (`.app-canvas`), frosted bars (`.glass`) and a `hero-card` treatment. Shell: gradient brand mark, filled active nav item, floating bottom dock on phones, gradient initial avatars, grouped account sheet. Today: a hero now/next card with a display-size countdown and period progress, three stat tiles (tasks due, periods left, rotation day), a timeline with a live "Now" marker, and task rows with due/priority/class chips. Schedule: pill week strip, day header chips, rotation days as a card grid with next-occurrence buttons. Tasks: coloured group headers, pill filters, sectioned edit form. Classes: class cards with gradient initials and single-line room/teacher text, restyled drag-and-drop canvas. School: crest header and icon-led fact rows. Dialogs open as bottom sheets under 640px. New composites in `src/components/primitives.tsx`: `PageHeader`, `StatTile`, `Section` icon/eyebrow. Every ARIA name and CSS hook the browser tests rely on was preserved; all 24 Chromium scenarios and 181 unit tests pass.

## Routes and screens

| Route | Screen |
| --- | --- |
| `/` signed out | Welcome with Google sign-in |
| `/` without names or school | Onboarding wizard (online only; offline shows a retry screen) |
| `/#today` | Now/next card, today's timeline, due-soon tasks |
| `/#schedule` (`?date=YYYY-MM-DD`) | Week strip, day list, rotation overview, adjustments |
| `/#tasks` (`?edit=<id>`) | Task groups, quick add, edit sheet |
| `/#classes` | Classes, period assignments, adjustments, private schedule |
| `/#school` | School status, shared schedule, correction requests |
| `/admin` | Owner-only inbox and school review |

Device conflicts and school-correction reviews render above whichever view is open. The status pill shows saving / syncing / waiting / failed / needs a choice / offline / saved and is clickable when a retry or a choice is possible.
