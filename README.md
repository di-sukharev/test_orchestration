# TaskForge

A local team task application: React + TypeScript, Bun, Hono and SQLite. No external services or API keys. The frontend and API run on one origin. All displayed project data is persisted by the backend.

## Quick start

Requires Bun 1.4.2. Run commands from the repository root.

```sh
bun install --frozen-lockfile
cp .env.example .env
bun run build
bun run start
```

Open `http://localhost:3000` yourself. Register to create a workspace. The server binds only `127.0.0.1`. Use the hostname matching `APP_ORIGIN`; unsafe requests from another origin are rejected. The application uses hash routes; invitations look like `/#invite/<token>`.

## Development and scripts

For API watch and frontend hot reload, set `APP_ORIGIN=http://localhost:5173` in `.env`, then run these commands in two terminals:

```sh
bun run dev
bun run dev:client
```

Open `http://localhost:5173`. Vite proxies `/api` to the Bun server at `127.0.0.1:3000`. Keep the API on port 3000 for this default proxy. `dev` builds the initial frontend before watching the server; Vite serves frontend edits immediately.

| Command                           | Purpose                                                                |
| --------------------------------- | ---------------------------------------------------------------------- |
| `bun run start`                   | Serve the built frontend and API; apply migrations                     |
| `bun run dev`                     | Initial build and Bun server watch                                     |
| `bun run dev:client`              | Vite frontend development server                                       |
| `bun run build`                   | Production frontend bundle in `dist/`                                  |
| `bun run typecheck`               | Check server, client, tests and build configuration                    |
| `bun run lint`                    | ESLint for application code and tests                                  |
| `bun test`                        | API, security, validation and persistence tests                        |
| `bun run test:e2e`                | Build and run scripted headless Chromium workflows                     |
| `python3 benchmark/acceptance.py` | Frozen independent HTTP acceptance suite                               |
| `bun run format`                  | Format application files and documentation (excludes benchmark inputs) |

Before the first E2E run, if Chromium is unavailable, run `bunx playwright install chromium`. E2E uses port 4317, synthetic accounts, an isolated database under ignored `work/`, and failure artifacts under ignored `test-results/`. `bun test` only discovers `tests/unit`; it does not accidentally execute Playwright tests. The Python suite starts and stops its own built server with an isolated database and checks persistence across a real process restart.

## Configuration

Bun reads `.env` automatically. `.env.example` lists all configuration.

| Variable              | Default                   | Meaning                                                                                                |
| --------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `PORT`                | `3000`                    | Integer 1–65535; loopback binding                                                                      |
| `DATABASE_PATH`       | `./data/taskforge.sqlite` | SQLite file; missing parent directories are created                                                    |
| `APP_ORIGIN`          | `http://localhost:3000`   | Exact public HTTP(S) origin, without a trailing slash/path/credentials                                 |
| `NODE_ENV`            | development behavior      | `development`, `test` or `production`                                                                  |
| `AUTH_RATE_LIMIT_MAX` | `20`                      | Shared registration/login attempts per IP per 15 minutes; override permitted only with `NODE_ENV=test` |

Production requires `NODE_ENV=production` and an explicitly configured HTTPS `APP_ORIGIN`. Terminate TLS at a reverse proxy forwarding to loopback. Misconfigured origins, ports, environment names and non-test rate-limit overrides stop startup with a clear error. Cookies are Secure in production, so production cannot be used directly over plain HTTP. There is no deploy or proxy configuration supplied.

## Architecture and data

- `src/server/config.ts`: validated environment configuration.
- `src/server/db.ts`: transactional, versioned startup migration and database setup.
- `src/server/app.ts`: API routes, authentication, authorization and atomic mutations. Queries use bound parameters.
- `src/server/validation.ts`: strict request shape, text, enum, date and pagination validation.
- `src/server/index.ts`: loopback HTTP server, same-origin static assets and SPA fallback. Missing API routes remain JSON 404s.
- `src/shared.ts`: public resource types, without password/session fields.
- `src/client/`: React screens, shared fetch/state helpers and responsive CSS.
- `tests/unit/`: real Hono requests against SQLite, including file-backed reopening.
- `tests/e2e/`: headless workflows through the actual built UI and server.

The `migrations` table records schema version 1. Startup applies missing migrations in a transaction and is idempotent; it never resets existing data. Foreign keys are enabled on every connection, with WAL and a busy timeout. Future schema changes must be added as new numbered migrations, leaving the applied version unchanged. Back up the database using SQLite's backup tooling, or stop the server before copying the database and any WAL state. Runtime databases are ignored by Git.

Users and server sessions are independent of projects. Memberships have a composite project/user key and a unique owner index. A project and its owner are created atomically; the API never permits owner removal or demotion. Invitations persist only a token hash, target email, role, expiration and consumption time. Acceptance inserts membership and consumes the token in one transaction.

Tasks belong to one project. Assignees are validated against current membership. Removing a member unassigns their tasks and invalidates their unconsumed invitations in the same transaction. Task changes and comment changes write activity atomically. Comments cascade with tasks; memberships, tasks, invitations and activity cascade with projects. Activity stores the task title at the time of each event without a task foreign key, so deleted tasks preserve readable history. Actor identities remain available because user deletion is not a feature.

Tasks sort by creation timestamp descending, then ID descending for deterministic ties. Filters and total counts share the same SQL predicate. Pagination defaults to 20 and supports up to 100 rows; the UI displays 10 per page. Search uses literal `instr` matching over derived Unicode-lowercase title/description fields, maintained on every write; `%`, `_` and quotes are literal characters. Activity is chronological, oldest first. Dates use ISO timestamps; due dates are validated calendar dates (`YYYY-MM-DD`) or null.

## Roles and invitations

| Action                                               | Owner | Editor | Viewer |
| ---------------------------------------------------- | ----- | ------ | ------ |
| Read project, tasks, members, comments, activity     | Yes   | Yes    | Yes    |
| Create/update/delete tasks; add comments             | Yes   | Yes    | No     |
| Delete own comments                                  | Yes   | Yes    | No     |
| Delete another author's comment                      | Yes   | No     | No     |
| Rename/delete project; invite; change/remove members | Yes   | No     | No     |

Only the signed-in email matching the invitation can accept it. Invitations last seven days, are one-time, and return conflicts on replay or an existing membership. The owner copies and shares the generated link manually; no email is sent. The raw token is shown only when generated; keep the link if needed. An invitation remains in the URL fragment while an invited user signs in or registers, then the UI offers acceptance. Fragments are not sent in HTTP requests or referrers. Access is available immediately after successful acceptance.

Every API nested resource lookup is scoped to both project membership and the parent task/project IDs. Knowing an ID is never sufficient for access. The UI hides actions unavailable to the current role, while the server independently enforces every operation. Role changes become visible in other open clients on refresh; the server applies them immediately.

## Security decisions and limits

Passwords use Argon2id (19 MiB memory, two iterations) through Bun. Passwords are 12–128 characters, preserved exactly without trimming. Login checks a dummy hash for absent accounts and uses a generic invalid-credential error. Email is trimmed/lowercased with a unique database constraint; names and submitted project/task/comment text are trimmed. Duplicate registration returns the contract-required 409.

Sessions are random 256-bit opaque values; only SHA-256 hashes are stored. Cookies are HttpOnly, SameSite=Lax, Path=/, seven-day lifetime, with Secure and the `__Host-` prefix in production. Expiration is enforced server-side. Logout deletes the current session; password changes revoke every session. A concurrent login rechecks the password hash before creating a session so an old credential cannot re-establish access after a password change. No password hashes or session tokens appear in API JSON. Expired sessions are removed when new ones are issued.

Unsafe requests reject a foreign or `null` Origin and cross-site Fetch Metadata. Non-browser clients without Origin are allowed. SameSite cookies complement this defense. API responses are not cached; static assets use a restrictive Content Security Policy and no-referrer policy. React escapes user content; descriptions/comments are plain text. JSON bodies are capped at 64 KiB. Database errors are not returned to clients.

Registration and login share a fixed-window limit of 20 attempts per direct socket IP per 15 minutes, including successful attempts, with a 429 and Retry-After header. Forwarding headers are never trusted. Behind a local reverse proxy all users share the proxy's identity; the limiter is intentionally conservative and in-memory, and resets on restart. A distributed/public deployment would need trusted-proxy configuration and a shared limiter. Test overrides fail outside `NODE_ENV=test`.

This local application does not verify email ownership, reset forgotten passwords, provide MFA, send email or implement administration. Invitation binding assumes locally registered emails are trusted; anyone can register an unclaimed email. Use only in a trusted local setting until identity verification is added. SQLite and tokens/hashes at rest rely on filesystem permissions, not database encryption. Restrict database access and backups. Expired/consumed invitation records remain for replay handling until project deletion. Activity/comments are unpaginated; very large projects would need bounded history endpoints. These are documented scope limits, not dormant features or fake controls.

## Verification and remaining human checks

`REVIEW.md` records self-review rounds, fixes and final check results. Automated coverage includes auth/session revocation, production settings, CSRF and rate limits, role boundaries across two users/projects, invitation misuse/expiry/replay, task validation/CRUD/search/pagination, comment ownership, cascades, activity and restart persistence. Headless workflows exercise editing, invitations, promotion/removal, account changes and a small-screen flow.

The final visual check is for the human: desktop/mobile appearance, keyboard focus and screen-reader experience, contrast, long text, clipboard behavior and native delete confirmations. Scripted E2E is not a claim that this visual check passed. Test HTTPS cookie behavior behind the intended TLS proxy before any production use.
