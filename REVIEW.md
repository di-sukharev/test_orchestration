# TaskForge implementation review record

Status: independent high-risk review rounds 1, 2, and 3 found six, three, and two material issues respectively; all eleven were accepted and fixed. Post-fix checks pass. Round 3 production fixes have NOT yet received fresh re-review. High-risk review status remains open under the pinned review skill's third-round rule. Human visual and keyboard verification remain pending.

## Implementation findings and fixes

- The first frozen acceptance run had 24/25 checks pass. The SPA root returned `application/octet-stream`; the static file MIME mapping now returns `text/html; charset=utf-8` for HTML.
- Final self-review identified a stale-login race: a login verifying the old password asynchronously could otherwise create a session after a concurrent password change. Users and sessions now carry a session version; login inserts only while the verified version still matches, and password change increments the version and revokes sessions in one transaction. The integration test races login with password change and checks the new session cannot survive revocation.
- The integration test initially reused the old owner cookie after changing the password. The test now signs in with the new password before continuing, matching the required revocation behavior.

## Independent review round 1

1. **Stale authorization after asynchronous body reads (P1).** A delayed editor task creation still returned 201 after the owner demoted the editor to viewer. Protected mutations now read/validate their bodies before checking the live session, current project role, and current nested resources. The audit covers project creation/rename, invitation creation/acceptance, member role changes, task creation/update, comment creation, and password change. Synchronous delete/logout paths have no body-read gap. Password change additionally rechecks its session after asynchronous hashing and conditionally updates the verified password, preventing concurrent old-password changes. Production/shared authentication fix; regression tests cover delayed demotion for create/update/comment, removal, task deletion, logout, and concurrent password changes.
2. **Lost concurrent partial updates (P1).** A delayed title-only PATCH reverted a separately completed status update to `todo`. Task PATCH now reads and merges the current row inside its transaction after body parsing. Production task-persistence fix; regression test asserts both changes survive. The PATCH contract is preserved.
3. **Project creation unavailable on mobile (P1).** The <=680px rule hid the only project creation form; the remaining plus button focused a hidden input. The form remains visible with compact mobile spacing. Production responsive UI fix; a React/Happy DOM test at width 390 applies the real stylesheet, checks ancestor visibility, focuses the input, submits the form, and verifies the created project opens.
4. **Unicode search was only case-insensitive for ASCII (P2).** Searching `проверка` missed `ПРОВЕРКА`. Bun SQLite does not expose a JavaScript custom-function registration API, so text search streams ordered SQLite candidates through JavaScript Unicode lowercasing and literal matching before totals and pagination, retaining at most one page in memory. Production task-query fix; regressions cover Cyrillic, accented text, literal `%`/`_`, combined filters, totals, and distinct stable pages. README documents the linear candidate scan.
5. **Anonymous unknown API routes returned 401 (P2).** Authentication middleware intercepted unknown routes before the JSON 404 handler. Middleware now checks Hono's matched route metadata and authenticates only registered API endpoints. Production/shared routing fix; regressions check unknown GET/POST/PATCH/DELETE routes with and without a session. Existing protected routes still require authentication.
6. **Local UI errors bypassed session recovery (P2).** Expired sessions during task list/comments loading, task save, or comment submission left the authenticated workspace visible. Shared API error handling now signals the App session handler on authentication errors carrying the optional `SESSION_EXPIRED` code, clearing authenticated state and returning to sign-in. Account password change uses the same handling, while incorrect current-password input remains a local validation error. Production/shared server/UI fix; error JSON gains optional metadata allowed by the existing HTTP contract, with unchanged status/error fields. Five React recovery regressions plus an incorrect-password test cover these paths; HTTP tests verify the authentication marker and credential-error distinction.

The new backend regression tests first failed on lost updates and Unicode search. The new UI tests first failed on mobile visibility and all five session-recovery scenarios. They pass after the production fixes. Tests execute real server/database code for HTTP coverage and real React/components/styles for UI coverage; the UI tests mock only the HTTP boundary.

## Round 1 post-fix checks

- `bun install --frozen-lockfile` — passed again after adding the test-only Happy DOM dependency and updating the Bun lockfile.
- `bun run typecheck` — passed; includes application, server, and test files.
- `bun run lint` — passed.
- `bun test` — passed; 11 tests across HTTP and React DOM suites with 147 assertions, including restart persistence and request/session race coverage.
- `bun run build` — passed.
- `python3 benchmark/acceptance.py` — passed, 25/25.
- `git diff --check` — passed.

No frozen inputs were edited. No interactive browser, commit, push, branch, worktree, or deployment was used during review/fixes. Happy DOM tests are DOM emulation rather than browser E2E; no browser E2E command was introduced.

## Independent review round 2

1. **Private UI data survived account/project transitions (P1).** A reproduced Alice-to-Bob account switch displayed Alice's cached confidential activity under Bob's project after an activity request failed. Centralized clearing now removes all account/project private state on logout, successful password change, session expiry, authentication, and project navigation. Shared request handling tracks account/project generations and rejects obsolete successes and errors, including stale 401 responses, before they can affect the active UI. Project callbacks also guard their captured scope before applying results; task save/deletion callbacks retain the current task selection. Project detail opens only after a successful current response, and people/activity requests clear their caches and show loading states. Production/shared UI fix; regressions cover all three account exit paths with delayed old activity, delayed new project lists, failed new activity, stale previous-account 401s, failed project details, and delayed task creation during project navigation, and a delayed task save after selecting a different task. Existing HTTP/session contracts are preserved.
2. **NUL text caused input/constraint failures to return 500 (P2).** SQLite length constraints stop at NUL while JavaScript string validation counts the entire value. A shared persisted-text validator now rejects NUL in user/project names, task titles/descriptions, and comments before writes; existing email, enum, assignee, and date validation already rejects it. Passwords and opaque invitation tokens retain their existing validation. Production/shared validation fix; HTTP regressions assert 400 for registration/create/update/comment inputs and verify that rejected requests create no account, project, task, comment, update, or extra activity. The error remains the existing JSON contract with status 400.
3. **Viewers could see forbidden comment deletion controls (P2).** A demoted editor still saw deletion controls on their own comments despite viewer access. Controls now require an editable role plus ownership/authorship, matching the existing API permissions. Production UI fix; viewer/editor/owner regressions verify zero, own-only, and all comment deletion controls respectively. No API or role contract change.

The new regressions first failed on retained private activity after logout/password change, delayed previous-account activity after session expiry, previous-project activity, viewer controls, and NUL registration returning 500. They pass after the fixes. HTTP tests execute the real application against isolated SQLite data; React DOM tests mock only the HTTP boundary, including delayed/error responses, and do not claim browser visual verification.

## Round 2 post-fix checks

- `bun install --frozen-lockfile` — reused the successful round 1 result; dependencies and lockfile did not change.
- `bun run typecheck` — passed, including tests.
- `bun run lint` — passed.
- `bun test` — passed, 22 tests and 203 assertions.
- `bun run build` — passed.
- `python3 benchmark/acceptance.py` — passed, 25/25.
- `git diff --check` — passed.

No frozen inputs, dependencies, migrations, or schema were changed in round 2. No interactive browser, commit, push, branch, worktree, or deployment was used. Human visual verification remains pending.

## Independent review round 3

1. **UI saves overwrote unrelated concurrent task edits (P2).** The task editor submitted all fields from its stale snapshot. An isolated real-HTTP reproduction showed a title edit restoring a teammate's completed status to `todo` and deleting their description. The editor now sends only fields changed from its baseline, disables unchanged saves, and skips programmatic unchanged submissions instead of sending an invalid empty PATCH. Successful responses become the new baseline and update form values, including canonical trimmed text and teammates' changes. Edits typed during the pending save remain unsaved against that returned baseline. Production UI fix; two React regressions verify preservation of unrelated concurrent fields across repeated saves, unchanged-save handling, canonical baseline reset, and preservation of typing during a pending save. Existing real-HTTP partial-update coverage verifies the backend merge behavior. No API or shared contract change.
2. **Account dialog lacked accessible modal behavior (P2).** Opening the custom `aria-modal` container left keyboard focus on the background Account button, and Escape did not dismiss it. The account panel now uses a native dialog opened with `showModal()`, letting the browser make the background inert and contain keyboard focus. It explicitly focuses the first password input, synchronizes Escape, native cancel/close, and Close/Cancel controls with React state, and restores a connected opener on cleanup. Native backdrop styling replaces the unused custom backdrop. Cleanup-generated close events are ignored so React Strict Mode effect replay does not dismiss the newly opened panel. Production UI/CSS fix; six React regressions cover the five dismissal paths, focus restoration/reopening, and Strict Mode lifecycle. No API or shared contract change.

The new unchanged-save and native-modal regressions first failed against the old production code. The Strict Mode regression then caught a cleanup-generated close event dismissing the modal; a cleanup guard fixed that failure. All regressions now pass. These tests execute real React components and native Happy DOM dialog methods; only HTTP responses are mocked. Browser-level focus trapping, layout, and screen-reader behavior still need human verification.

## Round 3 post-fix checks

- `bun install --frozen-lockfile` — reused the successful prior result; dependencies and lockfile did not change.
- `bun run typecheck` — passed, including tests.
- `bun run lint` — passed.
- `bun test` — passed, 30 tests and 247 assertions.
- `bun run build` — passed.
- `python3 benchmark/acceptance.py` — passed, 25/25.
- `git diff --check`, including untracked application files — passed.

No frozen inputs, dependencies, migrations, schema, or API contracts changed in round 3. No interactive browser, commit, push, branch, worktree, deployment, or further independent review was performed. Final commit and push remain pending; neither was performed during these fixes.

## Remaining review and human checks

- The round 3 production fixes have NOT received fresh independent re-review. High-risk review remains open under the pinned skill's third-round rule; passing checks do not close it.
- Human visual review remains pending, including desktop/mobile layout, complete action flows, keyboard navigation, and account-dialog focus behavior. DOM assertions do not establish visual quality or full browser accessibility.
