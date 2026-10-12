<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Dev servers use a production database copy

Every time you launch a dev or branch preview server, first create a fresh copy of the production database and use that copy as the server's `DATABASE_PATH`. This includes previews served through Tailscale and branch previews run with `next start`.

Read the production database path from `/srv/NAS/Private/school-schedule-tracker/.env.local`. Use SQLite's backup API to create a consistent snapshot, including committed data still in the WAL. Do not copy the live database file with `cp`.

Keep the copy in the dev checkout's ignored `data/` directory. Stop any dev server using the destination before replacing it. Never point a dev server at the production database or overwrite the production database. If the production database is unavailable, report the blocker instead of launching with an empty database.

Production snapshots contain private account data. Bind preview servers to loopback and expose them only on the owner's private Tailscale network, with the app's Google sign-in and account authorization checks intact. Keep snapshot files at mode `0600`; never commit them or include them in CI artifacts. When retiring a preview, stop its server and remove its snapshots, archived copies, and SQLite companion files from the dev checkout. Production database copies are not authorized for public preview links.

# UI rule: every form control is shadcn/ui

**Never write a raw `<input>`, `<select>`, `<textarea>`, or `<option>`-driven native dropdown in app code.** Native controls render OS-drawn popups (light-theme lists on a dark app, wrong fonts, no theming), so any `<input>` you are tempted to write MUST be replaced with the shadcn/ui equivalent:

| Native | Use instead |
| --- | --- |
| `<input type="text/email/date/time/…">` | `Input` from `src/components/primitives.tsx` (wraps `ui/input`) |
| `<select>` / `NativeSelect` | `Select` from `src/components/primitives.tsx` (wraps `ui/select`, the Radix popover select). It still accepts `<option>` children and `event.target.value`, so authoring is unchanged. |
| `<textarea>` | `Textarea` from `src/components/primitives.tsx` |
| `<input type="checkbox">` | `Checkbox` from `src/components/ui/checkbox.tsx`, or `Toggle` from primitives for on/off settings |
| `<input type="radio">` | `Segmented`, `ChoiceGroup` + `OptionCard`/`ChoiceItem` from primitives (Radix ToggleGroup, so arrow keys work) |
| `<input type="range">` | `Slider` from `src/components/ui/slider.tsx` |
| `<input type="color">` | `ColorPicker` from `src/components/ui/color-picker.tsx` |

The only allowed raw input is a visually hidden `<input type="file" className="sr-only">` that a shadcn `Button` triggers, because shadcn/ui has no file picker. Do not re-add `ui/native-select.tsx`; it was removed on purpose.

Need a component that is not in `src/components/ui`? Add it with `npx shadcn@latest add <name>` and wrap it in `primitives.tsx` rather than hand-rolling markup. In Playwright tests, drive selects with the `choose(locator, 'Label')` helper in `tests/e2e/tracker.spec.ts`, not `selectOption`.
