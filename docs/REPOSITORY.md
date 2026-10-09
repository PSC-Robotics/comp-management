# Competition Control repository

This repository is the source of the Competition Control application used to
run PSC Robotics competitions.

## Project layout

- `src/server.ts` - Fastify server: schema setup, admin API, live match clock
  loop, public display rendering and the SRComp-compatible API.
- `src/scheduler.ts` - pure scheduling logic: balanced league generation,
  delay cascades, moving matches around timed events, and playoff heat timing
  (dependency- and arena-aware).
- `src/playoffs.ts` - pure playoff logic: bracket plans for every route to the
  final (double elimination, single elimination, straight to the final, final
  size, seeded byes), seeding, heat ranking, advancement and loss tracking.
- `src/display.ts` - public display option schema and shared clock/cue helpers.
- `src/srcomp.ts` - adapters from Competition Control data to SRComp shapes.
- `src/*.test.ts` - unit tests for the modules above (`npm test`).
- `public/index.html` - the admin portal (single page, no build step).
- `public/srcomp/` - vendored SRComp screens, Polymer components and
  polyfills (MIT, see `public/srcomp/LICENSE`). `public/srcomp/node_modules/`
  holds the two vendored scripts the screens load (`moment` 2.29.4 and
  `moment-duration-format`); it is deliberately committed even though other
  `node_modules/` folders are ignored.
- `docs/` - operations guide, this file, and the original system plan.
- `compose.yaml` - Docker Compose services (PostgreSQL 17 + app).
- `Dockerfile` - production image; compiles TypeScript inside the build stage.
- `.env.example` - required environment variable template. Never commit `.env`.

`dist/` is build output (`npm run build`) and is not committed; the Docker
build produces its own.

## Local development

```sh
npm ci
cp .env.example .env
npm test
npm run typecheck
```

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
