# Competition Control repository

This repository is the source of the Competition Control application used to
run PSC Robotics competitions.

## Project layout

```
src/
  server.ts          entry point: schema upgrade, start-up, background jobs, graceful shutdown
  app.ts             buildApp(): the Fastify app with every route (no listening, so tests can drive it)
  config.ts          environment variables (validated)
  cli.ts             server-side admin commands (passkey invites, list users)
  auth/              sessions, OIDC client (lazy, retrying), passkey relying party, security hooks
  db/                connection pool and transactions, audit log, schema and migrations
  domain/            pure logic with unit tests: scheduler, playoffs, standings, displays,
                     SR adapters, bracket diagram
  services/          database-backed logic shared by routes: league standings, schedule re-flow,
                     match clock, conflicts, playoffs, public display data, SR data, change feed
  routes/            one file per area of the API (live, scores, delays, schedule, playoffs, ...)
  lib/               small helpers (HTML escaping, paths)
test/                integration tests against a real PostgreSQL (fuzz, auth, passkeys, live, chaos)
public/index.html    the admin portal (single page, no build step)
public/srcomp/       vendored SRComp screens, Polymer components and polyfills (MIT; see
                     public/srcomp/LICENSE). public/srcomp/node_modules/ holds the two scripts
                     they load (moment 2.29.4, moment-duration-format) and is committed on purpose.
docs/                operations guide, this file, original system plan
compose.yaml         PostgreSQL 17 + app
Dockerfile           production image; compiles TypeScript in the build stage
.env.example         configuration checklist (never commit .env)
```

`dist/` is build output (`npm run build`) and is not committed; the Docker build produces its own.

### How requests flow

Routes validate input with zod, then do their work inside `transaction()`, which locks the
competition row first so concurrent operations on the same competition run one at a time.
Anything that changes the timetable calls `reflowSchedule()` (services/reflow.ts), which keeps
same-arena order and spacing, makes playoff heats follow their feeder heats, and moves everything
around timed events. Writing an audit record marks the transaction as a data change; after commit
the change feed (services/changes.ts) notifies connected dashboards and displays. The match clock
(services/clock.ts) runs every second in services/background.ts.

## Local development

```sh
npm ci
cp .env.example .env
npm test
npm run typecheck
```

Integration tests need a throwaway PostgreSQL:

```sh
docker run -d --name cc-test-db -e POSTGRES_DB=competition -e POSTGRES_USER=competition \
  -e POSTGRES_PASSWORD=testpw -p 55432:5432 postgres:17-alpine
TEST_DATABASE_URL=postgres://competition:testpw@127.0.0.1:55432/competition npm run test:integration
```

They are skipped when `TEST_DATABASE_URL` is not set. Never point them at a real database.

The application requires PostgreSQL and, for sign-in, OIDC settings. For a
complete local stack, configure `.env` and run:

```sh
docker compose up -d db
npm run dev
```

The schema is created and upgraded automatically on start-up.

## Local end-to-end testing

To exercise the API and displays against a real database without an identity
provider, use a throwaway PostgreSQL container and a test session. **Only do
this against a local test database.**

```sh
docker run -d --name cc-test-db -e POSTGRES_DB=competition -e POSTGRES_USER=competition \
  -e POSTGRES_PASSWORD=testpw -p 55432:5432 postgres:17-alpine
DATABASE_URL=postgres://competition:testpw@127.0.0.1:55432/competition \
  COOKIE_SECRET=local-test-secret-at-least-32-characters COOKIE_SECURE=false PORT=18080 \
  npx tsx src/server.ts
# in another shell: create an admin session for the cookie value "localtesttoken"
HASH=$(printf %s localtesttoken | shasum -a 256 | cut -d' ' -f1)
docker exec cc-test-db psql -U competition -d competition -c \
  "INSERT INTO admin_sessions (token_hash, email, expires_at) VALUES ('$HASH', 'tester@local', now() + interval '1 day')"
curl -b competition_session=localtesttoken http://localhost:18080/api/admin/me
```

In a browser at `http://localhost:18080`, set the same cookie
(`document.cookie = 'competition_session=localtesttoken; path=/'`) and reload.
Remove the container with `docker rm -f cc-test-db` when finished.

Things worth checking after scheduling or playoff changes:

- generate a league schedule across two arenas, then playoffs across both
  arenas, and confirm independent heats share a start time;
- delay a league match and a heat, use **Delay all upcoming…**, add a lunch
  event, and confirm later items move but nothing moves earlier;
- start, finish and score a heat and confirm entrants advance;
- turn on auto-run and confirm a ready heat starts on its own;
- open every display type (`/display/{slug}`) and its JSON
  (`/api/public/display/{slug}`).

## Deployment

The production deployment runs from `/opt/competition-control` on the
competition host (a Docker host on the LAN). That directory is a plain copy of
the repository, not a git checkout. To deploy:

```sh
# from the repository: copy every tracked (or new, non-ignored) file. COPYFILE_DISABLE
# stops macOS adding ._* metadata files. Files deleted locally are not removed remotely.
git ls-files -z --cached --others --exclude-standard \
  | COPYFILE_DISABLE=1 tar --null -T - -czf - \
  | ssh root@<host> 'tar -xzf - -C /opt/competition-control'
ssh root@<host> 'cd /opt/competition-control && docker compose up -d --build app && \
  sleep 5 && curl -fsS http://127.0.0.1:8080/health'
```

Only the `app` service is rebuilt. Do not remove the `postgres_data` volume:
competition data is stored in PostgreSQL and is deliberately not committed.
Take a database backup before deploying during an event, for example:

```sh
ssh root@<host> 'cd /opt/competition-control && docker compose exec -T db \
  pg_dump -U competition competition' > backup-$(date +%Y%m%d-%H%M).sql
```

The host's root disk is small; each rebuild leaves Docker build cache behind.
Reclaim it occasionally with `docker builder prune -f` (this does not touch
images in use or the database volume).

## Data and secrets

The repository contains application source, display assets, tests, and
documentation only. OIDC client secrets, session secrets, database passwords,
logos uploaded through the admin portal, and live competition data must remain
outside Git. Use `.env.example` as the configuration checklist.

## Operational notes

The admin portal is the authenticated control interface. Public displays use
the read-only display/API routes. See [operations-guide.md](operations-guide.md)
for running the event (playoff formats, delays, displays) and the
[README](../README.md) for the full feature reference.
