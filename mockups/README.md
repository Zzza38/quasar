# Quasar landing page mockups

Ten self-contained landing page directions, plus a chooser shell.

**Round 2** — bred from Switch (4) and Pocket (5), which the owner picked:

| File | Direction |
| ---- | --------- |
| `6-verdict.html`    | The straight hybrid: Switch's blunt argument, Pocket's warmth and live phone. |
| `7-receipts.html`   | Proof-driven. Four weird days, each flippable between "usually" and "with Quasar". |
| `8-aurora.html`     | Pocket's phone-first layout in a dark neon treatment. Same demo, different mood. |
| `9-scoreboard.html` | Interactive: score your current app out of 11, live meter and verdict. |
| `10-week.html`      | Scroll-driven story of one weird week; the sticky phone updates per chapter. |

**Round 1**:

| File | Direction |
| ---- | --------- |
| `4-switch.html` ★  | Blunt and conversion-led. Names the pain, comparison table, straight answers. |
| `5-pocket.html` ★  | Playful, phone-centred. Animated live phone demo, bento features, soft colours. |
| `1-nebula.html`   | Dark, cosmic, premium. Plays on the name; glowing hero, starfield, phone mock. |
| `2-daylight.html` | Light, product-first SaaS. Big app screenshot, feature grid, FAQ. |
| `3-bell.html`     | Editorial. The page is laid out as a school day on a time rail, serif headlines. |

`index.html` is the chooser: a grouped side rail, an iframe preview, viewport
width presets, and `1`–`9`/`0` / `←` `→` keyboard shortcuts.

## Product copy note

Schedule sharing with chosen friends is a planned feature, so no page claims
schedules are never shared. "No ads, no trackers, nothing sold about you"
stays. Round 2 pages frame it positively as "share with the people you
choose"; say the word and that can be dropped until it ships.

Each page is one HTML file with inline CSS and no build step or network
dependency. The only shared asset is the logo.

## Serving

```sh
./serve.sh   # python3 http.server on 127.0.0.1:3005 + tailscale serve
```

Live at https://home-server.tail210f05.ts.net:3005/ (tailnet only).
To take it down: `tailscale serve --https=3005 off` and `pkill -f "http.server 3005"`.

## Swapping the logo

All five pages reference `assets/logo-mark.svg` (the glyph alone, inherits
`color`) and `index.html` also uses `assets/logo.svg` as the favicon. Replace
those two files and every page picks it up on reload. The current files are
placeholders. If the real logo is a PNG, drop it in as
`assets/logo-mark.png` and change the five `<img src>` references.
