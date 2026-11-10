# Mockups

One current set. Older rounds (School page, phone Messages entry, sidebar count badges, countdown hover, classmates popup, landing) are in git history.

## Lunch menu redesign

The Lunch menu section of the redesigned School page. The owner picked the week list (one row per day previewing a dish from each station; tap a row for the full menu) and asked for the inside of an open day to be redesigned, so this set is five ways to draw that inside. Every one is drawn from the generic menu shape (days, each with notes and stations, each station with dishes), and never assumes which station is the main one or what the stations are called.

Open `lunch.html?v=1` through `?v=5`. Add `&view=phones` for three phone frames side by side, one per sample school, or `&d=fa`, `&d=fw` or `&d=edge` to pick the school in the desktop view.

| `v` | Inside an open day |
| --- | ------------------ |
| 1 | Lead dish: each station's first dish as a headline, the rest as one quieter line. |
| 2 | Station tiles: each station is a small tile, packed in columns. |
| 3 | Dish chips: every dish is a chip under its station. |
| 4 | Menu card: the station name with a rule beside it, dishes listed under it. |
| 5 | Ruled table: station on the left, dishes on the right, a hairline between stations. |

The sample menus are the week of November 9, 2026: Friends Academy (`fa`, real), a Fort Worth ISD high school (`fw`, real), and a made-up worst case (`edge`: a day with no station names, a nine-station day with a long dish name, a note-only day, an empty day and a weekend day).

## Serving

```sh
./serve.sh   # python3 http.server on 127.0.0.1:3005, loopback only
```

Review happens through screenshots taken against the local server, not a shared link.
Stop it with `fuser -k 3005/tcp`.
