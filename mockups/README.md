# Mockups

One current set. Older rounds (phone Messages entry, sidebar count badges, countdown hover, classmates popup, landing) are in git history.

## School page redesign

Second round. The owner dropped the first round's Today board (it repeated the Today tab) and rotation grid (it repeated Classes), and asked for five mixes of the other three: tabs, a side rail, and list plus detail. The page stays about the school, not the student's day. Each mockup is responsive: the sidebar shell at desktop widths, the phone shell with the dock under 1024px.

Open `school.html?v=1` through `?v=5`:

| `v` | Direction |
| --- | --------- |
| 1 | Tabs with a rail: Schedule, Lunch and Changes tabs in the main column, the school card, setup and links in a fixed right rail. Lunch tab shown. |
| 2 | Expanding list with a rail: grouped rows that open in place, with the same right rail. Proposed changes is open. |
| 3 | School card as the menu: the school card and a list of sections on the left, the chosen section on the right. Rotation shown. Phones show the left column alone. |
| 4 | Overview tab: tabs across the top, and the first tab is the whole page as three columns of summary rows. |
| 5 | Summary tiles as tabs: four tiles that each show a live value and switch the content below. Setup shown. |

The sample data is Monday, November 9, Day 3 of a six-day rotation.

## Serving

```sh
./serve.sh   # python3 http.server on 127.0.0.1:3005, loopback only
```

Review happens through screenshots taken against the local server, not a shared link.
Stop it with `fuser -k 3005/tcp`.
