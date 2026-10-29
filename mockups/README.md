# Countdown hover mockups

Five ways for the Now card's "Ends in 14 min" to show the exact time ("13:42") on hover, focus or tap.
(The classmates popup mockups that used to live here are in git history.)

Open `countdown.html?v=1` through `?v=5`:

| `v` | Direction |
| --- | --------- |
| 1 | Fade: the minutes blur out and the seconds blur in, in the same spot. |
| 2 | Roll: the value rolls up like a ticker, and each changed digit rolls in every second. |
| 3 | Flip: a split-flap turn on the X axis. |
| 4 | Cascade: characters drop out and rise in one after another. |
| 5 | Subline: "14 min" stays; "13:42 exactly" fades in on a reserved row under it. |

All five fix the hover flicker the same way. Both forms sit in one grid cell, so the button is always
as wide as the wider form and nothing under the pointer changes size.

## Serving

```sh
./serve.sh   # python3 http.server on 127.0.0.1:3005, loopback only
```

Review happens through recordings taken against the local server, not a shared link.
Stop it with `fuser -k 3005/tcp`.
