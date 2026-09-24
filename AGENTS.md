<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# UI rule: every form control is shadcn/ui

**Never write a raw `<input>`, `<select>`, `<textarea>`, or `<option>`-driven native dropdown in app code.** Native controls render OS-drawn popups (light-theme lists on a dark app, wrong fonts, no theming), so any `<input>` you are tempted to write MUST be replaced with the shadcn/ui equivalent:

| Native | Use instead |
| --- | --- |
| `<input type="text/email/date/time/…">` | `Input` from `src/components/primitives.tsx` (wraps `ui/input`) |
| `<select>` / `NativeSelect` | `Select` from `src/components/primitives.tsx` (wraps `ui/select`, the Radix popover select). It still accepts `<option>` children and `event.target.value`, so authoring is unchanged. |
| `<textarea>` | `Textarea` from `src/components/primitives.tsx` |
| `<input type="checkbox">` | `Checkbox` from `src/components/ui/checkbox.tsx`, or `Toggle` from primitives for on/off settings |
| `<input type="radio">` | `ToggleGroup` / `OptionCard` from primitives |
| `<input type="range">` | `Slider` from `src/components/ui/slider.tsx` |
| `<input type="color">` | `ColorPicker` from `src/components/ui/color-picker.tsx` |

The only allowed raw input is a visually hidden `<input type="file" className="sr-only">` that a shadcn `Button` triggers, because shadcn/ui has no file picker. Do not re-add `ui/native-select.tsx`; it was removed on purpose.

Need a component that is not in `src/components/ui`? Add it with `npx shadcn@latest add <name>` and wrap it in `primitives.tsx` rather than hand-rolling markup. In Playwright tests, drive selects with the `choose(locator, 'Label')` helper in `tests/e2e/tracker.spec.ts`, not `selectOption`.
