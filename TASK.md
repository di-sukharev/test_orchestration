# TaskForge: a complete team task application

Build a production-minded local web application from an empty repository. Stack: React + TypeScript frontend, Bun runtime/package manager, Hono HTTP API, SQLite persistence. Use ordinary open-source packages; no hosted services, API keys, billing, AI features, email delivery, or deployment are needed. A minimal but complete, responsive UI is sufficient.

## Product requirements

1. Registration, login, logout, current user, persistent cookie sessions, password change. Registration signs the user in. Email is trimmed and case insensitive; names and project/task text are trimmed. Password is 12–128 characters; name 1–80; project name 1–100; task title 1–200; description up to 10,000; comment 1–2,000.
2. Secure password hashing, high-entropy opaque server sessions, HttpOnly cookies, SameSite protection, Secure in production, expiration, logout revocation, and password change revocation of all the user's sessions. Do not leak password hashes or session tokens in JSON. Invalid credentials have generic errors. Rate-limit registration/login; document the policy. Reject unsafe requests with a foreign Origin. Production misconfiguration should fail clearly.
3. A user can create multiple projects. Project members have owner, editor, or viewer roles. There is exactly one owner. Only the owner renames/deletes a project, invites members, changes roles, or removes members. Owner cannot be removed/demoted. Editors manage tasks and comments. Viewers can read only. A nonmember cannot read or mutate any nested project resource even if they know its ID.
4. Invitations: owner invites an email as editor/viewer, receives a shareable one-time token/link (no email service). Invitation expires after 7 days; only the matching signed-in email may accept. Acceptance is atomic; replays are rejected without duplicate memberships. A project can be accessed immediately after acceptance. UI supports generating/copying and accepting invitations.
5. Tasks: create, read, edit, delete; title, description, status (`todo`, `in_progress`, `done`), priority (`low`, `medium`, `high`), optional assignee and due date. Assignees must be current project members. Removing a member unassigns their tasks. List supports status, priority, assignee, text search, and pagination. Stable ordering, correct filtered totals, and durable state after restart are required.
6. Task comments: read, add, delete own; owner may delete any comment, editor may not delete another author's comment. No editing comments required. Deleting a task/project cleans up dependents transactionally.
7. A chronological project activity feed records task creation/update/deletion and comment creation/deletion with actor and timestamp. Deleted tasks do not break historical activity. Do not expose activity to outsiders.
8. UI covers authentication, project list/create, project detail, task list with filters and pagination, task detail/edit/comments, members/invitations, activity, and account/password change. All actions obey permissions. Include loading, error, empty, invalid-input, submitting, and session-expired states. Accessible labels, keyboard-operable controls, delete confirmation, responsive layout, and useful validation messages are required. Persisted backend data drives the UI.
9. Document setup, scripts, environment variables, migrations, architecture, role rules, security decisions/limitations, and test commands. Include `.env.example`. No placeholders, fake-success controls, TODO implementations, or unused scaffolding.
10. Write meaningful tests covering auth, permissions across two users/projects, invitation misuse/replay, CRUD, filters, pagination, comments, cleanup, and persistence. Run your tests, TypeScript, lint, production build, and the external acceptance suite. Fix failures and perform review cycles before the final commit.

## Stable HTTP contract (for independent acceptance)

Use JSON bodies and JSON responses except the 204 endpoints. Resource IDs and tokens are strings. Return errors as `{ "error": "human-readable message" }` (extra fields allowed). Use 400 for invalid input, 401 for missing/invalid sessions and wrong credentials, 403 for forbidden operations, 404 for missing resources, 409 for duplicate email or replayed invitation. An outsider resource request may return 403 or 404. Never turn a constraint/input error into 500.

Dates use ISO 8601, due dates use `YYYY-MM-DD` or null. User has `id`, `name`, `email`; project has `id`, `name`, `role`; member has `id` (user ID), `name`, `email`, `role`; task has `id`, `projectId`, `title`, `description`, `status`, `priority`, `assigneeId` (string/null), `dueDate` (string/null). Comment has `id`, `body`, `authorId`; event has `id`, `action`, `actorId`, `createdAt`. Extra metadata is allowed.

| Method | Route | Body/query | Success |
|---|---|---|---|
| GET | `/api/health` | — | 200 `{ok:true}` |
| POST | `/api/auth/register` | `{name,email,password}` | 201 `{user}` + session cookie |
| POST | `/api/auth/login` | `{email,password}` | 200 `{user}` + session cookie |
| POST | `/api/auth/logout` | — | 204, revokes current session |
| GET | `/api/auth/me` | — | 200 `{user}` |
| POST | `/api/auth/password` | `{currentPassword,newPassword}` | 204, revokes all sessions |
| GET | `/api/projects` | — | 200 `{projects}` |
| POST | `/api/projects` | `{name}` | 201 `{project}` |
| GET | `/api/projects/:projectId` | — | 200 `{project,members}` |
| PATCH | `/api/projects/:projectId` | `{name}` | 200 `{project}` |
| DELETE | `/api/projects/:projectId` | — | 204 |
| POST | `/api/projects/:projectId/invitations` | `{email,role}` | 201 `{invite:{token,...}}` |
| POST | `/api/invitations/accept` | `{token}` | 200 `{project}` |
| PATCH | `/api/projects/:projectId/members/:userId` | `{role}` | 200 `{member}` |
| DELETE | `/api/projects/:projectId/members/:userId` | — | 204 |
| GET | `/api/projects/:projectId/tasks` | `q,status,priority,assigneeId,page,pageSize` | 200 `{tasks,total,page,pageSize}` |
| POST | `/api/projects/:projectId/tasks` | `{title,description?,status?,priority?,assigneeId?,dueDate?}` | 201 `{task}` |
| GET | `/api/projects/:projectId/tasks/:taskId` | — | 200 `{task}` |
| PATCH | `/api/projects/:projectId/tasks/:taskId` | any editable task fields | 200 `{task}` |
| DELETE | `/api/projects/:projectId/tasks/:taskId` | — | 204 |
| GET | `/api/projects/:projectId/tasks/:taskId/comments` | — | 200 `{comments}` |
| POST | `/api/projects/:projectId/tasks/:taskId/comments` | `{body}` | 201 `{comment}` |
| DELETE | `/api/projects/:projectId/tasks/:taskId/comments/:commentId` | — | 204 |
| GET | `/api/projects/:projectId/activity` | — | 200 `{events}` |

Task defaults: description empty, status todo, priority medium, assigneeId/dueDate null. Pagination defaults: page 1, pageSize 20; page and pageSize must be positive integers; pageSize maximum 100. Status/priority filters must be validated. Search is a literal case-insensitive substring of title or description, not SQL wildcards. Empty PATCH, malformed JSON, impossible dates, and unknown fields on task writes are invalid.

## Runtime contract

- Bun 1.4.2 is installed for both runs. Commit the Bun lockfile.
- `bun install --frozen-lockfile`, `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`, `bun run start` must work.
- `bun run start` serves built frontend and API from one origin, binds `127.0.0.1`, reads `PORT` (default 3000), `DATABASE_PATH` (SQLite file), and `APP_ORIGIN` (default http://localhost:3000). Include a separate development command.
- Apply initial schema/migrations automatically and idempotently at server startup. Create the DB parent directory if needed. Production SPA routes serve the app, missing `/api/*` routes return JSON 404.
- Use `NODE_ENV=test` and `AUTH_RATE_LIMIT_MAX=10000` to disable practical throttling only in automated test runs. With no override, use a sensible documented default. Never trust client-supplied forwarding headers for rate limit identity by default.
- Run independent checks: `python3 benchmark/acceptance.py`. The suite starts a built server with a temporary DB and isolated port; no interactive browser is involved. Do not modify the suite.
- Record your own review findings, fixes, check results, and remaining human checks in `REVIEW.md`. Report final commit and push status. Do not invent token/cost figures; the benchmark controller measures them.
