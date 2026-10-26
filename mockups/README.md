# Classmates popup mockups

Five directions for what opens when you tap the "With Hunter, Liam and 1 more" chip on a Today timeline row.
(The landing page mockups that used to live here are in git history.)

| File | Direction |
| ---- | --------- |
| `1-popover.html` | Small popover anchored under the chip. Avatar, name and classes in common per row; "Open People" at the bottom. |
| `2-sheet.html`   | Bottom sheet on phones, side sheet from 768px. Class facts on top, each friend with where they go next plus Message and See day buttons. |
| `3-inline.html`  | No overlay. The chip gets a caret and unfolds a tray of name pills inside the row. |
| `4-roster.html`  | Centered dialog with a grid of large avatar tiles, search past five friends, and a group chat button. |
| `5-next.html`    | The chip becomes a face stack. The popover shows faces, then groups friends by their next class. |

`index.html` is the chooser: side rail, iframe preview, viewport width presets,
and `1`–`5` / `←` `→` keyboard shortcuts.

All five load `assets/today.css` (the app's dark tokens) and `assets/today.js` (fake timetable and
friends, the timeline renderer, and the same "With …" wording as `src/lib/classmates.ts`). Each page
opens its popup on the Digital Design row at load. English 10 has seven friends to show a longer list.

## Serving

```sh
./serve.sh   # python3 http.server on 127.0.0.1:3005, loopback only
```

Review happens through screenshots taken against the local server, not a shared link.
Stop it with `fuser -k 3005/tcp`.
