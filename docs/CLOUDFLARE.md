# Quasar through Cloudflare Tunnel

Quasar stays on the existing server with SQLite and its background worker. Cloudflare provides the public HTTPS route; the server must remain powered on and connected. No Vercel deployment or database conversion is needed.

## Live on this host

- App: persistent `quasar.service`, listening only on `127.0.0.1:3003`.
- Worker: persistent `quasar-worker.service`.
- Connector: `quasar-tunnel.service`, using `~/.cloudflared/quasar.yml`.
- Named tunnel: `quasar`, UUID `e6f068b1-f5e7-4a4e-af45-d4baae493414`.
- Database: the existing `.env.local` still points to `./data/whatsnext.sqlite`. Preserve this path and `NEXTAUTH_SECRET` (also used for calendar-feed encryption).
- Verified pre-cutover backup: `data/backups/quasar-before-cloudflare-2026-09-17.sqlite`.
- Daily backup timer: `quasar-backup.timer`, at 03:00 UTC plus up to 15 minutes of jitter. Backups are verified and kept in `data/backups/`; they are not automatically pruned or copied off-server.
- User lingering is enabled, so services can start without an interactive login. Reboot recovery has not been tested.

Public URL: https://quasar.ziona.dev. DNS and hostname ingress are configured, `NEXTAUTH_URL` is updated, and Quasar's Tailscale port-3003 route has been removed. Other Tailscale routes are unchanged. The public homepage, health endpoint, auth-provider callback URL, and service worker were verified on 2026-09-17. The owner confirmed successful sign-in with a second Google account and that a task created in DevTools offline mode persisted after returning to the page. Reconnection/upload and actual reminder delivery still need device verification.

## Cutover procedure and remaining owner checks

1. The selected hostname is `quasar.ziona.dev`; the infrastructure steps below have been applied. Google OAuth configuration and interactive user checks remain.
2. In the Google OAuth web client matching `GOOGLE_CLIENT_ID`, add `https://quasar.ziona.dev/api/auth/callback/google` to authorized redirect URIs. If using authorized JavaScript origins, add `https://quasar.ziona.dev`. Ensure the consent screen audience permits intended users. Keep the old callback until the transition is complete.
3. Browser storage and installed PWAs do not move between origins. If a device still has unsynced edits on the old URL, preserve its browser data and arrange a temporary recovery window using the rollback procedure below. Do not clear that browser storage.
4. Add the hostname ingress rule from `deploy/cloudflared.example.yml` to `~/.cloudflared/quasar.yml`, retaining the real tunnel UUID and credential path. Keep the final 404 catch-all. Validate and publish:

   ```sh
   cloudflared tunnel --config ~/.cloudflared/quasar.yml ingress validate
   cloudflared tunnel route dns quasar quasar.ziona.dev
   ```

   Do not overwrite an existing DNS record without checking what it serves.

5. Set `NEXTAUTH_URL=https://quasar.ziona.dev` in `.env.local`, preserving all other values. Restart `quasar.service` and `quasar-tunnel.service`.
6. The public homepage and `/api/health` have passed. Still verify Google sign-in, existing data, owner permissions, saves, offline sync, calendar refresh, and a real reminder. The API rejects writes from origins that differ from `NEXTAUTH_URL`.
7. Quasar's Tailscale route has been removed with:

   ```sh
   tailscale serve --https=3003 off
   tailscale serve status
   ```

   Other Tailscale routes are for unrelated services. Do not reset all Serve routes or stop the host's Tailscale daemon.
8. Users sign in at the new URL, enable browser reminders there, and reinstall the PWA as needed. After transition, remove the old Google OAuth callback. Retire old push subscriptions deliberately to avoid reminders targeting the old origin.

## Cloudflare and ongoing operations

- Do not apply cache-everything rules to Quasar. Bypass caching for `/api/*`, authenticated HTML, and `/sw.js`; honor origin cache headers. Immutable Next.js assets can be cached.
- Turn on SSL/TLS > Edge Certificates > Always Use HTTPS for the zone. The tunnel otherwise answers `http://quasar.ziona.dev` with the app over cleartext; check that `curl -sI http://quasar.ziona.dev/` returns a 301 to `https://`. The app's own `Strict-Transport-Security` header (set in `next.config.ts` with its Content-Security-Policy and Permissions-Policy) only takes effect after a browser has loaded the HTTPS origin once.
- Use the app's Google login for students. A Cloudflare Access policy on the hostname adds another login gate and must be configured deliberately if desired.
- Add an external uptime check for `/api/health`, monitor service failures and backup age, and arrange encrypted off-server backup copies. Local backups alone do not cover server loss.
- Keep the tunnel credentials, `.env.local`, and database out of Git. Keep `cloudflared` updated; the service disables automatic binary updates.
- Unit files in `deploy/systemd/` are for this host's paths. Install into `~/.config/systemd/user/`, run `systemctl --user daemon-reload`, and enable the app, worker, tunnel, and backup timer.

```sh
systemctl --user status quasar quasar-worker quasar-tunnel quasar-backup.timer
journalctl --user -u quasar -u quasar-worker -u quasar-tunnel --since '30 minutes ago'
systemctl --user start quasar-backup.service
```

For rollback before accepting new traffic, restore the former `NEXTAUTH_URL`, restart the app, and re-enable the old route with `tailscale serve --bg --https=3003 http://127.0.0.1:3003`. The database stays in place, so no database restore is needed. Avoid concurrent use of old and new origins.

Cloudflare reference: https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/


## Directory rollout (2026-09-18)

The school directory and grade onboarding are deployed. With the owner's explicit approval, nine classes were published from their saved account into Friends Academy's directory. Personal class IDs, colors, assignments, tasks, and school schedules were preserved; directory references were added through versioned sync. A verified backup was taken immediately before deployment.

Validation: 179 unit/integration tests, 24 browser tests, TypeScript, production build, and database integrity checks passed. Browser checks covered directory selection, placement into periods, local edits, and the second rotation week's grade-specific lunches. The existing owner's saved timetable also displayed lunch on every day from Day 6 through Day 10. The test account had no grade and used the old default schedule, which lacks most lunches; it now receives a grade-selection prompt. Refresh already-open pages to load the new controls.
