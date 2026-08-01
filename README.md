# CancerCulture

CancerCulture is a community platform for submission cycles, voting, public rankings, and a capability-based moderation and team area.

The application uses Next.js 16 with the App Router, React 19, TypeScript, Supabase/PostgreSQL, Cloudflare R2, Discord authentication and membership synchronization, and Vercel hosting.

## Project documentation

Start here before changing the project:

- [`AGENTS.md`](AGENTS.md) — durable repository rules loaded by Codex.
- [`docs/project/CURRENT_STATE.md`](docs/project/CURRENT_STATE.md) — current Git, release, environment, and handoff state.
- [`docs/project/CHECKLIST.md`](docs/project/CHECKLIST.md) — detailed product status, decisions, and roadmap.
- [`docs/project/README.md`](docs/project/README.md) — documentation ownership and maintenance contract.

Point-in-time operational documents and audits remain under [`docs/`](docs/). The Supabase schema baseline and its limitations are documented in [`supabase/baseline/README.md`](supabase/baseline/README.md).

## Local development

Install the locked dependencies and start the development server:

```powershell
npm.cmd ci
npm.cmd run dev
```

The local application is available at `http://localhost:3000` by default.

Common local checks:

```powershell
npm.cmd run lint
npm.cmd run build
```

Focused test commands and database test prerequisites depend on the affected subsystem. Follow `AGENTS.md`, the current checklist, and the relevant test files instead of running DEV-backed suites by assumption.

## Safety

- Keep `.env` files, credentials, connection strings, and tokens out of Git and documentation.
- Treat DEV and LIVE as separate environments.
- Never alter historical migrations.
- Do not push, deploy, or contact LIVE without explicit authorization.
