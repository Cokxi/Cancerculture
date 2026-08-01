# CancerCulture

CancerCulture is a community platform for submission cycles, voting, public rankings, and a capability-based moderation and team area.

The application uses Next.js 16 with the App Router, React 19, TypeScript, Supabase/PostgreSQL, Cloudflare R2, Discord authentication and membership synchronization, and Vercel hosting.

## Repository scope

This public repository contains the application source, tests, and database migration history so that the project's implementation can be inspected. Internal operational runbooks, security configuration, abuse-prevention thresholds, and project decision records are intentionally maintained outside the public repository.

The Supabase schema baseline and its limitations are documented in [`supabase/baseline/README.md`](supabase/baseline/README.md).

## Local development

Install the locked dependencies and start the development server:

```powershell
npm.cmd ci
npm.cmd run dev
```

The local application is available at `http://localhost:3000` by default.

Common local checks:

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run build
```

`npm.cmd test` is the canonical local full suite. It discovers every `*.test.mjs` file recursively and starts Node with the repository alias loader and module-mocking support required by the tests.

Focused and DEV-backed test commands depend on the affected subsystem. Use the relevant package scripts and test files instead of running DEV-backed suites by assumption.

## Safety

- Keep `.env` files, credentials, connection strings, and tokens out of Git and documentation.
- Treat DEV and LIVE as separate environments.
- Never alter historical migrations.
- Do not push, deploy, or contact LIVE without explicit authorization.
