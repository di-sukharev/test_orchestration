# TaskForge

TaskForge is a local team task application built with React, TypeScript, Vite, Bun, Hono, and SQLite. It serves the built web app and JSON API from one origin. It has no hosted dependencies or email delivery; project owners create one-time invitation links and share them with teammates.

## Run locally

Install Bun 1.4.2, then:

```sh
bun install --frozen-lockfile
cp .env.example .env
```

Run the API and Vite in separate terminals:

```sh
APP_ORIGIN=http://127.0.0.1:5173 bun run start
bun run dev
```

The Vite development server binds to `127.0.0.1:5173` and proxies `/api` requests to the API on `127.0.0.1:3000`. Set `APP_ORIGIN` to the browser origin so the API can reject foreign origins while accepting local development requests. For a production-style single-origin run, build first and then start:

```sh
bun run build
APP_ORIGIN=http://localhost:3000 bun run start
```

The server binds to `127.0.0.1` and uses port `3000` by default. `DATABASE_PATH` defaults to `./data/taskforge.sqlite`; its parent directory is created on startup. The schema migration is applied idempotently before serving requests. SQLite foreign keys and WAL mode are enabled. The database is local application data and is excluded from Git.

## Configuration

Copy `.env.example` to `.env` and set:

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | Set to `production` to require HTTPS `APP_ORIGIN` and secure cookies. |
| `PORT` | `3000` | Local HTTP port, from 1 through 65535. |
| `DATABASE_PATH` | `./data/taskforge.sqlite` | SQLite database filename; `:memory:` is useful for isolated runs. |
| `APP_ORIGIN` | `http://127.0.0.1:5173` in `.env.example` | Exact public origin checked on unsafe requests and used in invitation links. Use `http://localhost:3000` for the single-origin local run above. |
| `AUTH_RATE_LIMIT_MAX` | `10` attempts per 15 minutes | In `NODE_ENV=test` only, this can be set to a higher limit such as `10000` for automated tests. Outside test mode, the application uses its documented default. |

Production requires a valid HTTPS `APP_ORIGIN` with no path, query, or credentials. Invalid origins and ports fail at startup. The development Vite proxy targets port 3000; change its target in `vite.config.ts` if the API uses a different port.

## Architecture and data

The Hono API is in `server/index.ts`, with SQLite setup and schema in `server/db.ts`. The React application lives in `src/ui`. Request data is validated with Zod and API records are explicitly mapped to JSON response shapes. Persisted names, task titles/descriptions, and comments reject embedded NUL characters so SQLite text constraints cannot turn input errors into server errors.

The `users` table stores lowercased unique email addresses and Argon2id password hashes. `sessions` stores only SHA-256 digests of 256-bit random cookie values, with creation and expiry timestamps. Projects point to one required `owner_user_id`; the owner role is derived from that single field. The `memberships` table stores only editor and viewer access. Invitations store a digest of the one-time token, the intended normalized email, role, expiry, and consumed timestamp. Tasks have project-scoped assignees, comments cascade with tasks, and activity records keep task IDs and title snapshots without a task foreign key so history survives task deletion. Project and task cleanup uses SQLite foreign-key cascades; invitation acceptance, member removal with unassignment, task/comment activity, and password session revocation use transactions.

Task lists are ordered by creation time and ID, newest first. Filters apply before the total is counted. Search uses Unicode lowercasing and a literal substring of task title or description. Because SQLite's built-in case conversion handles only ASCII, text searches stream ordered candidates through JavaScript matching before counting and pagination, retaining at most one page in memory. Search scans the matching project's candidate tasks; this local application does not provide a full-text search index. Due dates are calendar dates (`YYYY-MM-DD`), while other timestamps are UTC ISO 8601 strings.

## Roles

- **Owner:** can rename or delete the project, invite members, change member roles, remove members, and manage all project tasks and comments. The project owner cannot be demoted or removed.
- **Editor:** can read the project and manage tasks and comments. Editors may delete only their own comments.
- **Viewer:** can read project tasks, comments, members, and activity. Viewers cannot mutate project data.

Every nested resource lookup is scoped to its project, and a nonmember cannot access project data by guessing IDs. Mutations check current sessions, permissions, and resources after asynchronous body reads; password changes check the session again after hashing. Partial task updates merge against the current database row inside their transaction. Assignees must be current project members; removing a member clears their task assignments in the same transaction.

## Security decisions and limits

Passwords are hashed with Bun's Argon2id implementation. Session and invitation secrets are generated with cryptographic randomness; only digests are stored. Session cookies are HttpOnly, SameSite=Lax, expire after 30 days, and use Secure in production. Changing a password revokes all sessions. Login and registration share a per-source-IP limit of 10 attempts per 15 minutes. The server uses Bun's socket peer address and ignores forwarding headers. Automated tests can set `NODE_ENV=test` and `AUTH_RATE_LIMIT_MAX=10000`.

Unsafe requests with a present Origin must match `APP_ORIGIN`. Requests without an Origin remain available to non-browser HTTP clients; the browser UI uses same-origin requests and SameSite cookies. There is no email service: invitation links must be delivered by the project owner. Invitations expire after seven days and can be accepted only by a signed-in account with the invited email. This local application has no TLS termination, backups, account recovery, or protection against malicious code running on the same machine; production use needs an HTTPS reverse proxy, protected database backups, and operational monitoring.

## Checks

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run build
python3 benchmark/acceptance.py
```

`bun test` includes HTTP integration tests with temporary SQLite databases and delayed request bodies, plus React UI tests using the test-only Happy DOM emulator. The UI tests exercise narrow-screen project creation with the real stylesheet and recovery from expired sessions. HTTP authentication failures include `code: "SESSION_EXPIRED"` so every protected UI request can return to sign-in; incorrect login/current-password errors retain their existing credential validation behavior. DOM tests do not verify visual rendering.

The acceptance script is a frozen, independent HTTP contract check. It starts the built server with a temporary database and does not use an interactive browser. Review findings and check results for this implementation are recorded in [REVIEW.md](REVIEW.md).
