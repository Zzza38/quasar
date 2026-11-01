# Sidebar count badge mockups

Five replacements for the bright filled pill on the sidebar's Tasks, People and Messages counts.
(The countdown hover mockups that used to live here are in git history.)

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
