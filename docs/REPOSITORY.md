# Competition Control repository

This repository is the source of the Competition Control application used to
run PSC Robotics competitions.

## Project layout

- `src/` - TypeScript backend, scheduling logic, playoff logic, SR-compatible
  display adapters, and tests.
- `public/` - admin portal, public displays, and bundled SRComp-compatible
  display assets.
- `docs/` - system planning and operational documentation.
- `compose.yaml` - local/production Docker Compose services.
- `Dockerfile` - reproducible production image build.
- `.env.example` - required environment variable template. Never commit `.env`.

## Local development

```sh
npm ci
cp .env.example .env
npm test
npm run build
```

The application requires PostgreSQL and OIDC settings. For a complete local
stack, configure `.env` and run:

```sh
docker compose up -d db
npm run dev
```

## Deployment

The production deployment currently runs from `/opt/competition-control` on the
competition host. Copy the repository there, create a production `.env`, and
deploy only the application service:

```sh
docker compose up -d --build app
```

Do not remove the `postgres_data` volume. Competition data is stored in
PostgreSQL and is deliberately not committed to this repository.

## Data and secrets

The repository contains application source, display assets, tests, and
documentation only. OIDC client secrets, session secrets, database passwords,
logos uploaded through the admin portal, and live competition data must remain
outside Git. Use `.env.example` as the configuration checklist.

## Operational notes

The admin portal is the authenticated control interface. Public displays use
the read-only display/API routes. The scheduler supports equal-appearance
league schedules, live score entry, delays and undelays, timer resets,
multi-arena staging, and double-elimination playoff heats. See
`README.md` and `docs/competition-management-system-plan.md` for the full
feature and operations reference.
