# Move to getquasarapp.com

The new production origin is `https://getquasarapp.com`. Keep `quasar.ziona.dev` routed to the same server so it can show the move notice. This is a domain change on the existing installation, with the same database, Google client, owner settings, session secret, and VAPID keys.

## Before switching

1. Let users sync pending edits on the old address. IndexedDB, cookies, installed PWAs, and notification permissions belong to each origin. They cannot transfer automatically. Keep old browser data if any edits have not synced.
2. Add `https://getquasarapp.com/api/auth/callback/google` to the existing Google OAuth web client's authorized redirect URIs. Add `https://getquasarapp.com` to authorized JavaScript origins if used. Update the consent screen's application URLs and authorized domain to `getquasarapp.com` where required. Keep the old callback during the transition.
3. In the new Cloudflare zone, create a proxied CNAME for `@` targeting `e6f068b1-f5e7-4a4e-af45-d4baae493414.cfargotunnel.com`. The existing server certificate is scoped to the old zone. Running `cloudflared tunnel route dns quasar getquasarapp.com` with that certificate creates a name under `ziona.dev`, so use the new zone's dashboard or credentials instead.
4. Add both ingress entries from [the example](../deploy/cloudflared.example.yml) to the live tunnel config, preserving its real UUID and credentials file. Keep the final 404 catch-all. Validate with `cloudflared tunnel --config ~/.cloudflared/quasar.yml ingress validate`.
5. Confirm HTTPS certificates are active. Enable Always Use HTTPS for the new zone. Bypass caches for authenticated HTML, `/api/*`, and `/sw.js`.
6. Take a verified SQLite backup using the existing backup service. Preserve `DATABASE_PATH` and `NEXTAUTH_SECRET`. Changing the secret also affects encrypted calendar feed URLs.

## Switch and verify

Build with `NEXTAUTH_URL=https://getquasarapp.com`, then set that value in the production `.env.local` and restart the app and tunnel. Keep other environment values intact. The build must use the new origin because root layout metadata is evaluated during the build.

The Next.js configuration rewrites page requests whose Host is `quasar.ziona.dev` to the move notice when built with `NEXTAUTH_URL` set to `https://getquasarapp.com`. It keeps assets, the service worker, and API routes reachable. Existing old-origin mutations fail the API origin check. The notice never clears browser storage. No automatic cross-domain redirect interrupts a user's chance to read it.

Verify through the public domains, not only loopback:

- New `/` and `/help` show the app. Canonical links, Open Graph, structured data, `/robots.txt`, and `/sitemap.xml` name `getquasarapp.com`.
- `/api/health` succeeds. `/api/auth/providers` advertises `https://getquasarapp.com/api/auth/callback/google`.
- Old `/`, `/schedule`, and `/admin` show "Quasar has moved" with a working link to the new domain. The page has noindex and no-store headers. Test a browser previously controlled by the old service worker too.
- Complete Google sign-in with the same account. Confirm an existing schedule and task, create an edit, reload, and confirm persistence. Verify `/admin` still requires the owner.
- Enable browser reminders and test actual delivery on the new domain. Reinstall the PWA there. Retire old push subscriptions deliberately after migration to avoid reminders opening the old origin.

Verify the new domain in Search Console, submit its sitemap, and update public links. The old address intentionally displays a notice instead of issuing a permanent redirect.

## Rollback

Restore `NEXTAUTH_URL=https://quasar.ziona.dev` in the environment, rebuild with that origin, and restart the app. The move notice then stops intercepting the old host. Keep both DNS routes and ingress entries available while investigating. Do not restore an older database just to undo a domain change, since that would discard new writes.

References: [Cloudflare tunnel DNS](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/), [Google web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).
