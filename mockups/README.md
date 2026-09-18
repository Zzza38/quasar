# Quasar landing page mockups

Five self-contained landing page directions, plus a chooser shell.
(The earlier ten rounds live in git history before this commit.)

| File | Direction |
| ---- | --------- |
| `1-countdown.html` | The home screen is the pitch. A huge live timer and a period rail; the demo day runs at 200×. Almost no copy. |
| `2-spec.html`      | Brutalist, monospace spec sheet. The eleven behaviours as numbered requirements with SHIPPED stamps. |
| `3-airplane.html`  | Interactive offline demo. Flip the Wi‑Fi off, add a task, flip it back; click through a conflict. |
| `4-notebook.html`  | Student voice on ruled notebook paper. Marker highlights, sticky-note features, a syllabus checklist. |
| `5-split.html`     | Full-bleed before/after hero with a draggable divider, then paired "their app / Quasar" rows. |

`index.html` is the chooser: side rail, iframe preview, viewport width presets,
and `1`–`5` / `←` `→` keyboard shortcuts.

## Product copy note

Schedule sharing with chosen friends is a planned feature, so no page claims
schedules are never shared. "No ads, no trackers, nothing sold about you"
stays. Pages frame sharing positively as "share with the people you choose".

Each page is one HTML file with inline CSS and no build step or network
dependency. The only shared asset is the logo.

## Serving

```sh
./serve.sh   # python3 http.server on 127.0.0.1:3005 + tailscale serve
```

Live at https://home-server.tail210f05.ts.net:3005/ (tailnet only).
To take it down: `tailscale serve --https=3005 off` and `pkill -f "http.server 3005"`.

## Swapping the logo

All pages reference `assets/logo-mark.svg` (the glyph alone, inherits
`color`) and `index.html` uses `assets/logo.svg` as the favicon. Replace
those two files and every page picks it up on reload.
