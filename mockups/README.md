# Mockups

Two current sets. Older rounds (countdown hover, classmates popup, landing) are in git history.

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

## Serving

```sh
./serve.sh   # python3 http.server on 127.0.0.1:3005, loopback only
```

Review happens through screenshots taken against the local server, not a shared link.
Stop it with `fuser -k 3005/tcp`.
