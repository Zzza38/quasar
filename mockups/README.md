# Mockups

Two current sets. Older rounds (School page, phone Messages entry, sidebar count badges, countdown hover, classmates popup, landing) are in git history.

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

## Next class on the Now card

Five ways to show the class after the current one, in place of the small "Then … at …" arrow line at the foot of
Today's Now card. Each is drawn at desktop width and at 390px.

Open `next-class.html?v=0` (the card as it ships) and `?v=1` through `?v=5`:

| `v` | Direction |
| --- | --------- |
| 1 | Next row: the arrow line becomes a full-width row with the class, the room and the time. |
| 2 | Split card: now and next share the card, each in its own class colour. |
| 3 | Day rail: the next stops of the day sit inside the card. |
| 4 | Handoff: for the last 5 minutes and the passing period the card turns into directions to the next class. |
| 5 | Everywhere: a next-class strip on every page, in the sidebar on desktop and under the top bar on a phone. |

The owner picked 2 and asked for the split to follow the clock. `?v=6` (desktop) and `?v=7` (phone) show six moments
of that: the card spans the time from the current class's start to the next class's start, the current class keeps
what is left of it, a grey band is the passing time, and the next class grows from the far edge.

`?v=8` to `?v=10` put the progress bar back on it: `8` keeps the bar inside the current class's part, `9` runs one
bar along the bottom of the whole card, `10` is the phone. The owner picked the bar that crosses all three parts
(`9`); `?v=11` is that bar on a phone, running down the left edge. Its fill is white mixed with 35% of the hue
of the part it is over (current class, grey, next class), with that hue taken at one fixed brightness so the fill
stays equally bright across the card. Mixing in the part's own dark colour made the fill look see-through.
`?v=12` compares tint strengths from 14% to 60%.

## Serving

```sh
./serve.sh   # python3 http.server on 127.0.0.1:3005, loopback only
```

Review happens through screenshots taken against the local server, not a shared link.
Stop it with `fuser -k 3005/tcp`.
