# Mockups

Three current sets. Older rounds (countdown hover, classmates popup, landing) are in git history.

## Phone Messages entry

Five ways to open Messages on a phone instead of the bare icon in the top bar's corner. The owner picked 4 with
2's raised button holding Home, and School folded into Classes so the dock is symmetric (`?v=b`), which shipped
as the `phone-dock` beta.

Open `messages-entry.html?v=0` (before) and `?v=1` through `?v=5`, plus `?v=a` and `?v=b` for the two dock layouts:

| `v` | Direction |
| --- | --------- |
| 1 | Seventh tab: "Chats" joins the dock. |
| 2 | Centre bubble: a raised round Messages button in the middle of the dock. |
| 3 | Split dock: a separate round Messages button beside the six-tab dock. |
| 4 | Chats inside People: a Chats / Friends switch on the People tab. |
| 5 | Peek bar + sheet: the newest unread message above the dock; tapping it slides Messages up as a sheet. |
| a | Home in the middle, two tabs left, three right. |
| b | Home in the middle, School folded into Classes, two and two. |

## Sidebar count badges

Five replacements for the bright filled pill on the sidebar's Tasks, People and Messages counts.

Open `nav-badge.html` for all five side by side, or `nav-badge.html?v=1` through `?v=5` for one:

| `v` | Direction |
| --- | --------- |
| 1 | Quiet number: the digits alone, dim, brighter on hover. |
| 2 | Soft chip: the selected row's tint with a flat 1px ring. |
| 3 | Neutral chip: a grey chip that blends into the sidebar. |
| 4 | Inline: the count follows the label ("Tasks · 17"). |
| 5 | Dot: a small dot; the number shows on hover. |

The Messages row is drawn in its hover state in every column.

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
