# Deployment and pilot operations

The existing private installation is available at https://home-server.tail210f05.ts.net:3003/. The general deployment instructions below also support a separate Docker installation. Real Google sign-in and device push delivery still require interactive pilot verification.

## Configure and deploy

1. Choose a domain and configure HTTPS at the existing reverse proxy. Set `NEXTAUTH_URL=https://your-domain` and add `https://your-domain/api/auth/callback/google` to the Google OAuth web client's redirect URIs. The OAuth consent screen must permit your pilot accounts; a client left in testing only admits configured test users.
2. Populate `.env.local` from `.env.example`. Keep a strong stable session secret, Google client credentials and the owner email outside Git. Restrict this file's permissions. Changing the secret signs out current online sessions; pending offline changes remain local until the same user signs in again.
3. Build and start `docker compose up -d --build`. The included compose file binds the app to localhost port 3000 and persists SQLite in a named Docker volume. Mounts must be on local disk. Ensure Docker's storage location is local too.
4. Proxy the domain to `127.0.0.1:3000`. Forward `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto` and `X-Forwarded-For` correctly; preserve the browser's `Origin`. Limit request bodies to 2 MB and add normal connection/request rate limits. Do not cache `/api/*`, OAuth, or dynamic HTML at the proxy. Immutable `/_next/static/*` assets may be cached. HTTPS is required for service workers outside localhost.
5. Check `/api/health`, complete Google sign-in, enter both names, create/select a school, and visit `/admin` with the owner account. Check a different Google account cannot access admin RPCs. Check failed saves retain form contents.
6. Run the pilot checks below before inviting students. Keep the Google client secret and session secret backed up separately from the database.

Example nginx site fragments (substitute your TLS configuration/domain):

```nginx
server {
    listen 443 ssl;
    server_name your-domain;
    # ssl_certificate and ssl_certificate_key supplied by your TLS setup
    client_max_body_size 2m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

For a direct Node process, use `npm ci`, `npm run build`, `npm start` under a service manager, with `DATABASE_PATH` set to a local persistent directory. Next reads `.env.local`; the standalone `server.js` process expects actual environment variables (compose supplies them). Bind/proxy it appropriately. The container runs as the unprivileged `node` user. Container build and live OAuth are separate deployment checks; see implementation validation notes in the README/handoff.

## Backups and restoration

Use SQLite's online backup API; do not copy only a live main database file while WAL writes are occurring.

For a direct install, export `DATABASE_PATH` (the script does not load `.env.local`) and run:

```sh
DATABASE_PATH=/local/path/whatsnext.sqlite npm run db:backup -- /secure/backups/whatsnext-2026-09-11.sqlite
```

The script checks the copied database and restricts the resulting file to mode 600. For Docker, create a consistent snapshot inside the persistent volume, then copy it to protected backup storage:

```sh
docker compose exec app node -e "const D=require('better-sqlite3');const d=new D(process.env.DATABASE_PATH,{readonly:true});d.backup('/app/data/backup.sqlite').then(()=>d.close()).catch(e=>{console.error(e.message);process.exit(1)})"
docker compose cp app:/app/data/backup.sqlite /secure/backups/whatsnext.sqlite
chmod 600 /secure/backups/whatsnext.sqlite
```

Automate daily backups before pilot launch, retain daily copies for 14 days and weekly copies for at least four weeks, and keep an encrypted off-server copy. These are initial operating defaults; adjust them to actual recovery needs and disk capacity. Snapshot files contain student names and personal tasks.

Restore procedure:

1. Stop the application and background worker, then preserve the existing database plus `-wal` and `-shm` files as a recovery copy.
2. Verify the backup with SQLite `PRAGMA integrity_check` using a read-only connection; expect `ok`.
3. Replace the application's database with the backup while stopped. Remove the old companion WAL/SHM files only after preserving them; they must not be reused with the restored database. Restore the service user's ownership and restrictive file permissions.
4. Restart, check health, sign in, inspect a known schedule/task and check queued sync. A restored older database can lack device base revisions; preserve those device queues and resolve them through a deliberate export/recovery workflow instead of clearing browser data. The current API rejects unknown base revisions to avoid silent overwrites.
5. Test restoration into a separate disposable instance before pilot launch and periodically thereafter. Never rehearse by overwriting the live pilot database.

## Monitoring and capacity

Probe `/api/health` every minute and alert after three failures. Review container restarts, application errors, request latency, disk capacity and backup age. Alert when backups are older than 26 hours and when the data volume exceeds 75% usage. Do not log task content or OAuth tokens. Keep request/error logs limited and protected.

Initial migration/reassessment triggers: persistent API p95 latency over 500 ms under ordinary pilot use, recurring SQLite busy errors, disk use approaching 75%, need for multiple application hosts, or inability to restore within the owner's recovery target. Measure before choosing cloud infrastructure. Do not run several hosts against the same SQLite file across a network filesystem.

## Pilot acceptance checks

Automated unit/integration tests cover schedule cases, persistence, server authorization, merge and queue semantics. The following require configured Google accounts and representative school data before launch:

- Use a real full rotation, including weekends, a closure that pauses advancement, a closure that advances it, special bell times, a reset/term change and dates around DST. Confirm next/current class and lunch against the published timetable.
- Add multiple classes, split periods and lunch waves; assign periods, edit times, reload and restart the browser. Saved data should remain intact.
- Visit the app while signed in and allow offline preparation to complete. Disconnect, reload, edit a class/lunch override, create/edit/complete/delete tasks, reload again and reconnect. Check saved states and absence of duplicates.
- Disconnect two devices. Change distinct task fields and separate class entries; reconnect and check automatic merging. Change the same title, then test edit-versus-delete; check both competing values remain visible until a choice is made.
- While one device has personal overrides, correct/lock the school as owner. Confirm the overrides survive, affected targets are flagged, and review acknowledgment does not erase them.
- Join ten distinct accounts; repeated joins count once. Verify member edits are blocked and remain blocked after a member leaves. Verify owner correction succeeds and forged admin/nonmember requests fail.
- Sign out with an empty queue and check local data is cleared. With pending edits, check the save/resolve/discard choice. Sign into a different account and confirm no previous account's data is displayed or uploaded.
- Rehearse database backup and restoration, HTTPS/auth failures, an expired session with pending edits, unavailable storage, and a brief server outage.

## Remaining launch inputs

The owner must supply Google OAuth credentials, owner email, domain/TLS configuration, local persistent storage and backup destination; set up uptime alerts; establish what evidence support accepts; and run the pilot against the actual school's schedule. UI polish and structured schedule editing are assigned to Fable. Later-phase community permissions remain deliberately unimplemented.

## Phase 2 background processing

Run `npm run worker` under a service manager alongside Next.js. It loads `.env.local` and must use the same database and session secret as the app. Docker Compose starts both services automatically. Stop both processes for database restoration. Monitor worker restarts and calendar status in the app as well as web health.

Set the VAPID variables in `.env.local` (see `.env.example`). Keep the private key backed up and outside Git. Enabling server support does not request browser permission: each user must open Account and choose Enable browser reminders. Verify an actual reminder on every supported device before relying on it.

The current host uses user services `whatsnext.service` and `quasar-worker.service`. Inspect with `systemctl --user status`, and restart both after a verified build. Transient services created with `systemd-run` must be recreated after reboot; install persistent units before an unattended pilot. The private Tailscale route remains on port 3003; the other existing routes are unrelated.
