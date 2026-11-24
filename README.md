# Team Next Steps workspace

A working first version for TNS at The Porch. The public team workspace includes published posts, a name filter, multi-date absence reporting, calendar, resources, and updates. One shared admin login manages the roster, trimester partners, Disciple classes and external co-leads, draft posts, publication, and workspace configuration.

The posts board follows the supplied TNS schedule sheet: navy headings, Barlow Semi Condensed, role columns with names underneath, and a separate flow-of-the-night table. The original TNS logo was extracted unchanged from the spreadsheet. Historical assignments and pairings were not imported into the 2027 season. A fresh checkout starts with a fictional 30-person roster and sample assignments. The current local workspace has the imported roster and leadership roles in its ignored database; those personal records are not in the source repository. Class dates remain provisional.

## Run locally

Requires Node.js 24 or later; no npm packages are needed.

```sh
npm start
```

Open http://127.0.0.1:4173. Data persists in `.data/workspace.sqlite`, outside the frontend build. A fresh local workspace has a one-time passphrase setup screen. Choose the shared passphrase yourself; the distributable source has no preconfigured password. The minimum length is 12 characters. Subsequent admin sessions use a server-verified password and an HttpOnly cookie, with an eight-hour lifetime.

```sh
npm test
npm run build
```

Tests cover assignment constraints, absence privacy, review/publication, partner preferences, class continuity, sessions, password rotation, concurrency, roster replacement, and SQLite persistence. The build copies only public assets into `dist`; it does not include research, database files, passwords, or absence reasons.

## Hosting

GitHub Pages can host the public frontend and a custom domain. It cannot run the database, password verification, shared edits, or scheduled draft generator. The app therefore includes a separate backend. A static deployment with no backend is not a functioning shared workspace.

Two supported deployment shapes:

1. **One Cloudflare Worker with D1 and static assets.** All pages and API requests share one origin. This is the simplest setup and can use a custom domain.
2. **GitHub Pages frontend plus the same Worker/D1 backend.** The team opens the Pages/custom-domain URL. Admin opens on the backend's origin, keeping its session cookie first-party. Public data and the absence form use the API across origins.

The project uses the public `abp-builds/TNS` repository and the Cloudflare `tns` Worker with its private `tns-workspace` D1 database. Production roster records and the existing admin password hash are migrated directly into D1; they are excluded from the source and Pages build. A custom domain can be connected later. Review current provider plans and quotas before changing the hosting: [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/about-github-pages), [Cloudflare Workers](https://developers.cloudflare.com/workers/platform/pricing/), and [D1](https://developers.cloudflare.com/d1/platform/pricing/).

### Worker / D1 setup

Use the official Cloudflare Wrangler CLI under the account that should own the ministry's app. Wrangler is pinned as a development dependency; install it with `pnpm install --frozen-lockfile` or `npm install`, then run `npx wrangler login`.

```sh
cp wrangler.toml.example wrangler.toml
npx wrangler d1 create tns-workspace
```

Put the returned database ID into `wrangler.toml`. If using Pages, set `PUBLIC_ORIGIN` to the exact public origin, for example `https://your-team.github.io` or your custom domain. It is an origin, without the repository path. If serving everything from the Worker, the variable can be removed.

For this existing local workspace, carry over the real roster and the current admin password hash privately:

```sh
npm run export:d1
npx wrangler d1 execute tns-workspace --remote --file .data/deployment/production-import.sql
npx wrangler deploy
```

Run that database import only against a new database or an untouched sample workspace. The export includes the workspace and existing salted password hash, excludes browser sessions, and lives in an ignored private directory. It does not overwrite an existing real workspace or an already configured remote password. Regenerate it immediately before the actual migration if local data has changed. The existing shared password continues to work when migrating into a fresh database. Do not upload this SQL file to GitHub.

For a completely new workspace instead, set a random bootstrap token as a Worker secret:

```sh
npx wrangler secret put BOOTSTRAP_TOKEN
npx wrangler deploy
```

Open the Worker's `/#admin` page and personally enter the bootstrap token and your chosen shared passphrase. The initial database schema and sample workspace are created automatically. After successful setup, remove the one-time bootstrap secret:

```sh
npx wrangler secret delete BOOTSTRAP_TOKEN
```

The Worker bundle and D1 adapter passed local Cloudflare-runtime checks for password setup, sessions, draft generation, publication, and private absence handling using disposable records. The Pages workflow checks the production backend before publishing. Check login and review the first real schedule on the hosted URL before inviting the team.

### GitHub Pages setup

Deploy the Worker first. Build the frontend with the backend's HTTPS origin:

```sh
TNS_API_BASE=https://your-worker.workers.dev npm run build
```

The repository includes `.github/workflows/deploy-pages.yml` for automatic publication:

1. Create or select the GitHub repository and push the source to `main`.
2. In **Settings → Pages**, choose **GitHub Actions** as the publishing source.
3. In **Settings → Secrets and variables → Actions → Variables**, add `TNS_API_BASE` with the Worker's HTTPS origin. Add `TNS_PUBLIC_ORIGIN` with the exact public Pages/custom-domain origin. Both are non-secret URLs.
4. Set the Worker's `PUBLIC_ORIGIN` to the same public origin. For a project site, use `https://OWNER.github.io`, without `/REPOSITORY`.
5. Run the deployment workflow. It verifies the backend connection, CORS origin, real roster, and admin configuration, then runs the tests, builds `dist`, and publishes that folder only.

The workflow stops if the backend URL is missing or still serving fictional sample data. It runs again on later pushes to `main`, and can also be run manually. All asset paths are relative and navigation uses hashes, so repository subpaths work. If using a custom domain, configure it in Pages settings and set its DNS records using GitHub's custom-domain instructions.

Do not put an admin password, bootstrap token, database, backup, or meeting-context files in the Git repository. The public `config.js` contains only the non-secret backend origin.

## Scheduling rules

- Season: Tuesdays January 19–December 7, 2027; flexible season dates, weekday, breaks, events, times, and rooms in Settings.
- Team time: 6–6:45 PM; first-Tuesday all-leader meeting in Stage Two.
- Engine Room: 3 men and 3 women during the message, ending at the piano-man cue. Those leaders can serve afterward. Suggestions prefer someone else for each room's prayer lead.
- Disciple is allocated first. Three provisional, movable eight-session classes have five men's and five women's tables. Each class stores the fixed TNS leader and external co-lead, confirmation, and known external absences.
- A present external co-lead covers a table when its TNS leader is absent. If both are unavailable, suggest a matching one-night substitute without changing the class commitment.
- Disciple's two hosts come from its table leaders. Next Steps gets the remaining team: five men's tables, five women's tables, and four hosts/care leaders (two men, two women). Required coverage comes before preferred second table leaders. Trimester partners are used where staffing permits.
- Team leads submit absences but are excluded from posts; STLs are included. Gender/staffing group is configured explicitly, never inferred from a name.
- Optional seasonal overflow posts can be activated in Settings.
- History is used to spread general rotation posts. Suggestions expose shortages rather than pretending every required slot is covered. A leader must review and publish.

Local draft generation runs once per minute while the Node process is running. The Worker cron checks every 15 minutes. Both use the configured IANA timezone and create an unpublished draft on the serving morning at or after the review time. If a draft already exists, the job leaves it for leadership to manage; it does not overwrite edits or automatically publish.

## First real season and handover

1. Import the real roster from the Admin Roster CSV dialog, or enter people individually. The sample-replacement option archives sample people, clears fake schedules and absences, and clears fictional class pairings. Import only name, team, staffing group, and role; private context notes are not needed.
2. Confirm subteams, program names/rooms, posts, seasonal dates, and the three class date sets. Configure trimester partners in the roster and confirmed external co-leads in each class.
3. Add real calendar/Partiful links, approved curriculum links, and announcements. Meeting notes are context only and are not stored in the app.
4. Review a suggested night and any staffing gaps before publishing. Later absences immediately remove the absent person's published allocation and mark uncovered posts. Refresh/review/publish the revised draft.
5. Export a workspace backup regularly from Settings. Backups include private absence reasons: keep them in a leadership-controlled location. Password hashes and sessions are excluded. Restore through Admin Settings when needed.
6. Archive departing leaders and add incoming leaders as new records. Reusing a person's record for someone else rewrites that record's identity. Published names and program labels are frozen in each publication.
7. Transfer the repository, hosting account, domain, and backup ownership to the next team leads. Rotate the shared passphrase in Settings. Shared admin actions cannot be attributed to an individual.

The absence form is deliberately open: a person chooses a roster name without verifying identity. A leadership member can clear incorrect reports. Reasons and unpublished drafts stay in the admin API. There is an in-app Monday reminder and copy-to-GroupMe controls; automatic messages, email, SMS, and chatbot integration are not connected. Resources use external links or short text guides; binary file uploads are not included in this version.

## Files and data

- `public/`: static frontend and original logo/font assets.
- `core/`: scheduling rules and fictional sample workspace.
- `server/`: API, password/session handling, optimistic concurrency, SQLite persistence.
- `worker/`: Cloudflare Worker and D1 adapter entry point.
- `test/`: domain and API tests using disposable databases.
- `research/`: ignored discovery materials; never part of the public build.

Barlow Semi Condensed is redistributed under its bundled SIL Open Font License. TNS logo use is limited to this team's project. The app does not include a church brand guide or claim an official endorsement.
