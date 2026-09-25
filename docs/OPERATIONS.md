# Deployment and pilot operations

The production installation is available at https://quasar.ziona.dev/ through Cloudflare Tunnel. Quasar's former Tailscale route has been removed. See [Cloudflare Tunnel deployment](CLOUDFLARE.md) for services, recovery instructions, and remaining Google authentication checks. The general deployment instructions below also support a separate Docker installation. Google sign-in with a second account has been verified by the owner. Actual device push delivery still requires interactive pilot verification.

## Configure and deploy

1. Choose a domain and configure HTTPS at the existing reverse proxy. Set `NEXTAUTH_URL=https://your-domain` and add `https://your-domain/api/auth/callback/google` to the Google OAuth web client's redirect URIs. The OAuth consent screen must permit your pilot accounts; a client left in testing only admits configured test users.
2. Populate `.env.local` from `.env.example`. Keep a strong stable session secret, Google client credentials and the owner email outside Git. Restrict this file's permissions. Changing the secret signs out current online sessions; pending offline changes remain local until the same user signs in again. The secret must be at least 32 characters, because it also derives the key that encrypts calendar feed URLs: with a shorter or missing one, no feed can be read, the worker's calendar step logs a `PRECONDITION_FAILED` error each cycle and a manual Refresh reports "Calendar encryption is not configured."
3. Build and start `docker compose up -d --build`. The included compose file binds the app to localhost port 3000 and persists SQLite in a named Docker volume. Mounts must be on local disk. Ensure Docker's storage location is local too.
4. Proxy the domain to `127.0.0.1:3000`. Forward `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto` and `X-Forwarded-For` correctly; preserve the browser's `Origin`. Limit request bodies to 5 MB (a timetable scan can carry three photos) and add normal connection/request rate limits. Do not cache `/api/*`, OAuth, or dynamic HTML at the proxy. Immutable `/_next/static/*` assets may be cached. HTTPS is required for service workers outside localhost. Redirect every `http://` request to `https://` at the proxy (with Cloudflare, turn on SSL/TLS > Edge Certificates > Always Use HTTPS): the app sends `Strict-Transport-Security`, but browsers only honor it after one visit over HTTPS. `next.config.ts` also sets a Content-Security-Policy and Permissions-Policy on every response; the proxy should pass them through unchanged.
5. Check `/api/health`, complete Google sign-in, enter both names, create/select a school, and visit `/admin` with the owner account. Check a different Google account cannot access admin RPCs. Check failed saves retain form contents.
6. Run the pilot checks below before inviting students. Keep the Google client secret and session secret backed up separately from the database.

Example nginx site fragments (substitute your TLS configuration/domain):

```nginx
server {
    listen 443 ssl;
    server_name your-domain;
    # ssl_certificate and ssl_certificate_key supplied by your TLS setup
    client_max_body_size 5m;
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

Install dependencies with npm only. `package-lock.json` is the only committed lockfile, and it is what CI and the Dockerfile install, so `npm ci` is the one reproducible install. Do not run `pnpm install` or plain `npm install` in a deployed checkout: pnpm resolves transitive versions without a lockfile, and mixing it with npm leaves a hybrid `node_modules` that no lockfile describes. If a checkout's `node_modules` contains a `.pnpm` directory, stop the services, run `rm -rf node_modules && npm ci`, then rebuild before restarting, because the build's file traces point at the old `node_modules/.pnpm` paths.

## Backups and restoration

Use SQLite's online backup API; do not copy only a live main database file while WAL writes are occurring.

For a direct install, export `DATABASE_PATH` (the script does not load `.env.local`) and run:

```sh
DATABASE_PATH=/local/path/quasar.sqlite npm run db:backup -- /secure/backups/quasar-2026-09-11.sqlite
```

The script writes the copy under a temporary `<destination>.<random id>.partial` name in the destination directory, switches it out of WAL mode, checks it with `PRAGMA integrity_check`, restricts it to mode 600, and only then renames it to the destination, so a failed run never leaves a file that looks like a verified backup. The destination must not be the live database or one of its -wal/-shm/-journal files. If the process is killed with SIGKILL, it can leave a `*.partial` file behind, which is safe to delete. For Docker, create a consistent snapshot inside the persistent volume, then copy it to protected backup storage:

```sh
docker compose exec app node -e "const D=require('better-sqlite3');const d=new D(process.env.DATABASE_PATH,{readonly:true});d.backup('/app/data/backup.sqlite').then(()=>d.close()).catch(e=>{console.error(e.message);process.exit(1)})"
docker compose cp app:/app/data/backup.sqlite /secure/backups/quasar.sqlite
chmod 600 /secure/backups/quasar.sqlite
```

Automate daily backups before pilot launch, retain daily copies for 14 days and weekly copies for at least four weeks, and keep an encrypted off-server copy. These are initial operating defaults; adjust them to actual recovery needs and disk capacity. Snapshot files contain student names and personal tasks.

Restore procedure:

1. Stop the application and background worker, then preserve the existing database plus `-wal` and `-shm` files as a recovery copy.
2. Verify the backup with SQLite `PRAGMA integrity_check` using a read-only connection; expect `ok`.
3. Replace the application's database with the backup while stopped. Remove the old companion WAL/SHM files only after preserving them; they must not be reused with the restored database. Restore the service user's ownership and restrictive file permissions.
4. Restart, check health, sign in, inspect a known schedule/task and check queued sync. A restored older database can lack device base revisions; preserve those device queues and resolve them through a deliberate export/recovery workflow instead of clearing browser data. The current API rejects unknown base revisions to avoid silent overwrites.
5. Test restoration into a separate disposable instance before pilot launch and periodically thereafter. Never rehearse by overwriting the live pilot database.

## Chat data

Chat messages and report evidence are stored unencrypted in SQLite, so every backup contains them. Protect backups as you would the live database. Nobody queries the `chat_*` or `global_*` tables or `reports.evidence` directly, including the owner, except during a restore or its verification. The owner reads one-to-one chat text only through Show messages on a report in `/admin`, which writes an audit entry. The `global_*` tables hold the public Global chat room ([CHAT.md §11](CHAT.md#11-global-chat-migration-7)); every member, the owner included, reads those messages in the app, and the owner's edits and removals there are audited. The worker deletes old chat data on the schedule in [ARCHITECTURE.md](ARCHITECTURE.md#phase-4-chat); a restored older backup brings back messages that were already pruned until the next worker cycle removes them again. The 5 MB proxy body limit above also covers chat, whose messages are small.

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

The owner must supply Google OAuth credentials, owner email, domain/TLS configuration, local persistent storage and backup destination; set up uptime alerts; establish what evidence support accepts; and run the pilot against the actual school's schedule. UI polish is assigned to Fable; structured schedule editing has shipped (see [ARCHITECTURE.md](ARCHITECTURE.md#scheduling-rules)). Community features (member directories, verification, friends, voting and chat) have shipped in phases 3 and 4; their permissions are described in [ARCHITECTURE.md](ARCHITECTURE.md) and [CHAT.md](CHAT.md).

## Phase 2 background processing

Run `npm run worker` under a service manager alongside Next.js. It loads `.env.local` and must use the same database and session secret as the app. Docker Compose starts both services automatically. Stop both processes for database restoration. Monitor worker restarts and calendar status in the app as well as web health. A step that throws logs `Quasar <step> background job failed (<error name>, code <code>, status <status>); retrying next cycle.` with only the error's class name, its `code` (for example `SQLITE_BUSY` or `SQLITE_CONSTRAINT_FOREIGNKEY`) and an HTTP `statusCode` when present, never the message, which can quote a feed URL or push endpoint. The same line every minute means the step fails each cycle; the code says why.

Set the VAPID variables in `.env.local` (see `.env.example`). Keep the private key backed up and outside Git. Enabling server support does not request browser permission: each user must open Account and choose Enable browser reminders. Verify an actual reminder on every supported device before relying on it. If the three values are not a valid, matching VAPID configuration, the server treats push as not configured (Account shows it as unavailable) and logs `Quasar push notifications are disabled: …` once per process, without the values. The worker logs `Quasar <step> push step: N deliveries failed.` when pushes fail. The count includes browsers the provider reports as gone (404/410) or that fail validation; those are removed rather than retried. After rotating keys, rows for browsers enrolled with the old key fail until those users open Account. Opening Account removes the old enrollment and shows reminders as off, so each user must choose Enable browser reminders again; tell users to re-enable after a rotation.

The existing host now uses persistent user services `quasar.service` and `quasar-worker.service`, with unit files in `deploy/systemd/`. Inspect with `systemctl --user status`, and restart both after a verified build. The worker runs from source while the web service runs the built `.next` output, so after updating the checkout, build first and then restart both together; a worker restarted alone on newer source applies that source's migrations under the older web bundle (they are written to stay backward compatible, but keep the two in step). Cloudflare Tunnel forwards `quasar.ziona.dev` to loopback port 3003. Quasar's Tailscale route has been removed; other services' routes remain unchanged.

## Upgrading an existing installation to Quasar

New installations use `quasar.sqlite`, `quasar-data`, and `QUASAR_STANDALONE=1`. Existing installations must keep `DATABASE_PATH` pointing to their current database until it is migrated using the backup and restoration procedure above. The local environment file retains that explicit path. Do not rename a live SQLite file.

For an existing Docker deployment, set `QUASAR_DATA_VOLUME` to the actual existing volume name and `DATABASE_PATH` to the existing database path inside the container in the Compose environment (shell or `.env`) before recreating services. Compose interpolation does not read the service's `.env.local` file. This reuses the saved data instead of starting with an empty volume.

The browser database retains its legacy `whatsnext-offline-v1` storage key to preserve unsynced edits and compatibility with already-open tabs. An open tab or a resumed phone app keeps the JavaScript it loaded until it reloads, so it talks to a newer server after a deploy. The server shapes task data for bundles that do not send `clientVersion` (they never see `completedAt`), and a request missing a field every current client sends (`accountId` on account-scoped procedures, `summaries` on `school.list`) is answered with "Quasar has been updated. Reload the page, or close and reopen the app, to continue." After a deploy that adds task fields, reload any tab you have open. An older tab open at the same time as a newer one on the same device shares its IndexedDB store, so until it reloads it can show newer tasks as hidden or as local conflicts. The pages at `/` and `/admin` are rendered per request for the signed-in account, so a proxy must not cache them (the app sends `Cache-Control: no-store` for them). Quasar uses its new name for public shell caches and removes obsolete caches when the service worker activates. When a shell refresh finds a new deployment, cached `/_next/static/` files that no saved shell references, either directly or through a url() in one of its saved stylesheets (such as lazily loaded font subsets), are deleted, so old deployments do not pile up. Saving a bundle copy is best effort: a full storage quota never turns a successful network response into an error. The worker also precaches the two brand lockup SVGs under `/brand/` (served network first like the bundles), so the offline "Connect to get started" notice still shows the logo; failing to fetch them never fails the install.
