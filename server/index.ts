import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { matchedRoutes } from 'hono/route';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z, ZodError } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { db, digest, id, now, projectFor, publicUser, token, type Project, type Role, type Task, type User } from './db.ts';

const isProduction = process.env.NODE_ENV === 'production';
const configuredOrigin = process.env.APP_ORIGIN ?? 'http://localhost:3000';
let appOrigin: string;
try {
  const parsed = new URL(configuredOrigin);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== configuredOrigin || parsed.username || parsed.password) throw new Error();
  appOrigin = parsed.origin;
} catch {
  throw new Error('APP_ORIGIN must be a valid origin without a path, query, or credentials');
}
if (isProduction && !appOrigin.startsWith('https://')) throw new Error('APP_ORIGIN must use HTTPS in production');
const cookieName = 'taskforge_session';
const sessionMs = 30 * 24 * 60 * 60 * 1000;
const rateWindowMs = 15 * 60 * 1000;
const rateMax = process.env.NODE_ENV === 'test'
  ? Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10000)
  : 10;
if (!Number.isSafeInteger(rateMax) || rateMax < 1) throw new Error('AUTH_RATE_LIMIT_MAX must be a positive integer');

type Variables = { sessionToken: string };
const app = new Hono<{ Variables: Variables }>();
const requestIps = new WeakMap<Request, string>();
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const unsafeMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const fail = (status: 400 | 401 | 403 | 404 | 409, message: string, code?: 'SESSION_EXPIRED'): never => { throw new ApiError(status, message, code); };

class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: 'SESSION_EXPIRED') { super(message); }
}

function dateTime(ms: number): string { return new Date(ms).toISOString(); }
function userSelect(idValue: string): User | null {
  return db.query('SELECT id,name,email FROM users WHERE id=?').get(idValue) as User | null;
}
function requireUser(c: Context<{ Variables: Variables }>): User {
  const value = getCookie(c, cookieName);
  if (!value) return fail(401, 'Authentication required', 'SESSION_EXPIRED');
  const session = db.query(`SELECT s.user_id FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND s.session_version=u.session_version`).get(digest(value), now()) as { user_id: string } | null;
  if (!session) return fail(401, 'Session expired. Please sign in again.', 'SESSION_EXPIRED');
  const user = userSelect(session.user_id);
  if (!user) return fail(401, 'Session expired. Please sign in again.', 'SESSION_EXPIRED');
  c.set('sessionToken', value);
  return user;
}
function parseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Expected a JSON object');
  return value as Record<string, unknown>;
}
async function body(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try { return parseObject(await c.req.json()); } catch (error) {
    if (error instanceof ApiError) throw error;
    return fail(400, 'Malformed JSON body');
  }
}
function validate<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  try { return schema.parse(value); } catch (error) {
    if (error instanceof ZodError) return fail(400, error.issues[0]?.message ?? 'Invalid input');
    throw error;
  }
}
function userRole(userId: string, projectId: string, allowed: Role[]): { project: Project; role: Role } {
  const access = projectFor(userId, projectId);
  if (!access) return fail(404, 'Project not found');
  if (!allowed.includes(access.role)) return fail(403, 'You do not have permission to do that');
  return access;
}
function taskFor(projectId: string, taskId: string): Task {
  const task = db.query('SELECT * FROM tasks WHERE id=? AND project_id=?').get(taskId, projectId) as Task | null;
  if (!task) return fail(404, 'Task not found');
  return task;
}
function emailValue(value: unknown): string {
  return validate(z.string().trim().email().max(254), value).toLowerCase();
}
function persistedText(max: number, min = 0) {
  return z.string().trim().min(min, 'This field is required').max(max)
    .refine(value => !value.includes('\u0000'), 'Text must not contain NUL characters');
}
function nameValue(max: number) { return persistedText(max, 1); }
const passwordSchema = z.string().min(12, 'Password must be at least 12 characters').max(128, 'Password must be at most 128 characters');
const taskShape = {
  title: nameValue(200),
  description: persistedText(10000).default(''),
  status: z.enum(['todo', 'in_progress', 'done']).default('todo'),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  assigneeId: z.string().nullable().default(null),
  dueDate: z.string().nullable().default(null),
};
const taskCreateSchema = z.object(taskShape).strict();
const taskPatchSchema = z.object({
  title: nameValue(200).optional(),
  description: persistedText(10000).optional(),
  status: z.enum(['todo', 'in_progress', 'done']).optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  assigneeId: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'Provide at least one field to update');
function validDueDate(value: string | null): void {
  if (value === null) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(400, 'Due date must use YYYY-MM-DD');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(400, 'Due date is not a valid calendar date');
}
function validateAssignee(projectId: string, assigneeId: string | null): void {
  if (assigneeId === null) return;
  const access = projectFor(assigneeId, projectId);
  if (!access) fail(400, 'Assignee must be a current project member');
}
function insertActivity(projectId: string, actorId: string, action: string, taskId: string | null = null, taskTitle: string | null = null): void {
  db.query('INSERT INTO activity(id,project_id,actor_id,action,task_id,task_title,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(id(), projectId, actorId, action, taskId, taskTitle, now());
}
function projectJson(project: Project, role: Role) { return { id: project.id, name: project.name, role }; }
function taskJson(task: Task) {
  return { id: task.id, projectId: task.project_id, title: task.title, description: task.description,
    status: task.status, priority: task.priority, assigneeId: task.assignee_id, dueDate: task.due_date,
    createdAt: task.created_at, updatedAt: task.updated_at };
}
function sessionCookie(c: { header: (name: string, value: string, options?: { append?: boolean }) => void }, value: string): void {
  setCookie(c as never, cookieName, value, { httpOnly: true, sameSite: 'Lax', secure: isProduction, path: '/', maxAge: Math.floor(sessionMs / 1000) });
}

app.use('*', async (c, next) => {
  if (unsafeMethods.has(c.req.method)) {
    const origin = c.req.header('Origin');
    if (origin && origin !== appOrigin) return c.json({ error: 'Request origin is not allowed' }, 403);
  }
  await next();
});

app.use('/api/auth/*', async (c, next) => {
  if (c.req.path === '/api/auth/register' || c.req.path === '/api/auth/login') {
    const key = `${requestIps.get(c.req.raw) ?? 'unknown'}`;
    const current = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= current) {
      bucket = { count: 0, resetAt: current + rateWindowMs };
      rateBuckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > rateMax) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - current) / 1000))));
      return c.json({ error: 'Too many authentication attempts. Try again later.' }, 429);
    }
  }
  await next();
});

app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/health' || c.req.path === '/api/auth/register' || c.req.path === '/api/auth/login') return next();
  // Authenticate registered endpoints; unmatched paths must reach the JSON 404.
  if (matchedRoutes(c).some(route => route.method !== 'ALL' && route.path.startsWith('/api/'))) requireUser(c);
  await next();
});

app.get('/api/health', c => c.json({ ok: true }));

app.post('/api/auth/register', async c => {
  const parsed = validate(z.object({ name: nameValue(80), email: z.string(), password: passwordSchema }).strict(), await body(c));
  const email = emailValue(parsed.email);
  if (db.query('SELECT 1 FROM users WHERE email=?').get(email)) return c.json({ error: 'An account with that email already exists' }, 409);
  const userId = id();
  const createdAt = now();
  const passwordHash = await Bun.password.hash(parsed.password, { algorithm: 'argon2id' });
  try { db.query('INSERT INTO users(id,name,email,password_hash,created_at) VALUES(?,?,?,?,?)').run(userId, parsed.name, email, passwordHash, createdAt); }
  catch (error) {
    if (String(error).includes('UNIQUE')) return c.json({ error: 'An account with that email already exists' }, 409);
    throw error;
  }
  const sessionToken = token();
  db.query('INSERT INTO sessions(token_hash,user_id,session_version,created_at,expires_at) VALUES(?,?,0,?,?)').run(digest(sessionToken), userId, createdAt, dateTime(Date.now() + sessionMs));
  sessionCookie(c, sessionToken);
  return c.json({ user: { id: userId, name: parsed.name, email } }, 201);
});

app.post('/api/auth/login', async c => {
  const parsed = validate(z.object({ email: z.string(), password: z.string().min(1).max(128) }).strict(), await body(c));
  const email = emailValue(parsed.email);
  const row = db.query('SELECT id,name,email,password_hash,session_version FROM users WHERE email=?').get(email) as (User & { password_hash: string; session_version: number }) | null;
  const valid = row ? await Bun.password.verify(parsed.password, row.password_hash) : await Bun.password.hash('invalid password sentinel', { algorithm: 'argon2id' }).then(() => false);
  if (!row || !valid) return c.json({ error: 'Email or password is incorrect' }, 401);
  const sessionToken = token();
  const createdAt = now();
  const inserted = db.query(`INSERT INTO sessions(token_hash,user_id,session_version,created_at,expires_at)
    SELECT ?,id,session_version,?,? FROM users WHERE id=? AND session_version=?`)
    .run(digest(sessionToken), createdAt, dateTime(Date.now() + sessionMs), row.id, row.session_version);
  if (inserted.changes !== 1) return c.json({ error: 'Email or password is incorrect' }, 401);
  sessionCookie(c, sessionToken);
  return c.json({ user: publicUser(row) });
});

app.post('/api/auth/logout', c => {
  const user = requireUser(c);
  const sessionToken = c.get('sessionToken');
  if (sessionToken) db.query('DELETE FROM sessions WHERE token_hash=? AND user_id=?').run(digest(sessionToken), user.id);
  deleteCookie(c, cookieName, { path: '/' });
  return c.body(null, 204);
});
app.get('/api/auth/me', c => c.json({ user: publicUser(requireUser(c)) }));
app.post('/api/auth/password', async c => {
  const parsed = validate(z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema }).strict(), await body(c));
  const user = requireUser(c);
  const row = db.query('SELECT password_hash FROM users WHERE id=?').get(user.id) as { password_hash: string };
  if (!await Bun.password.verify(parsed.currentPassword, row.password_hash)) return c.json({ error: 'Current password is incorrect' }, 401);
  const passwordHash = await Bun.password.hash(parsed.newPassword, { algorithm: 'argon2id' });
  db.transaction(() => {
    requireUser(c);
    const changed = db.query('UPDATE users SET password_hash=?,session_version=session_version+1 WHERE id=? AND password_hash=?').run(passwordHash, user.id, row.password_hash);
    if (changed.changes !== 1) fail(401, 'Current password is incorrect');
    db.query('DELETE FROM sessions WHERE user_id=?').run(user.id);
  })();
  deleteCookie(c, cookieName, { path: '/' });
  return c.body(null, 204);
});

app.get('/api/projects', c => {
  const user = requireUser(c);
  const projects = db.query(`
    SELECT p.*, CASE WHEN p.owner_user_id=? THEN 'owner' ELSE m.role END AS role
    FROM projects p LEFT JOIN memberships m ON m.project_id=p.id AND m.user_id=?
    WHERE p.owner_user_id=? OR m.user_id=? ORDER BY p.created_at DESC,p.id DESC
  `).all(user.id, user.id, user.id, user.id) as Array<Project & { role: Role }>;
  return c.json({ projects: projects.map(project => projectJson(project, project.role)) });
});

app.post('/api/projects', async c => {
  const { name } = validate(z.object({ name: nameValue(100) }).strict(), await body(c));
  const user = requireUser(c);
  const project = { id: id(), name, owner_user_id: user.id, created_at: now() };
  db.query('INSERT INTO projects(id,name,owner_user_id,created_at) VALUES(?,?,?,?)').run(project.id, project.name, project.owner_user_id, project.created_at);
  return c.json({ project: projectJson(project, 'owner') }, 201);
});

app.get('/api/projects/:projectId', c => {
  const user = requireUser(c);
  const { project, role } = userRole(user.id, c.req.param('projectId'), ['owner', 'editor', 'viewer']);
  const members = db.query(`
    SELECT u.id,u.name,u.email,'owner' AS role FROM users u WHERE u.id=?
    UNION ALL
    SELECT u.id,u.name,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.project_id=?
    ORDER BY role,id
  `).all(project.owner_user_id, project.id) as Array<User & { role: Role }>;
  return c.json({ project: projectJson(project, role), members });
});

app.patch('/api/projects/:projectId', async c => {
  const { name } = validate(z.object({ name: nameValue(100) }).strict(), await body(c));
  const user = requireUser(c);
  const { project } = userRole(user.id, c.req.param('projectId'), ['owner']);
  db.query('UPDATE projects SET name=? WHERE id=?').run(name, project.id);
  return c.json({ project: projectJson({ ...project, name }, 'owner') });
});

app.delete('/api/projects/:projectId', c => {
  const user = requireUser(c);
  const { project } = userRole(user.id, c.req.param('projectId'), ['owner']);
  db.query('DELETE FROM projects WHERE id=?').run(project.id);
  return c.body(null, 204);
});

app.post('/api/projects/:projectId/invitations', async c => {
  const parsed = validate(z.object({ email: z.string(), role: z.enum(['editor', 'viewer']) }).strict(), await body(c));
  const user = requireUser(c);
  const { project } = userRole(user.id, c.req.param('projectId'), ['owner']);
  const email = emailValue(parsed.email);
  const member = db.query('SELECT 1 FROM users u WHERE u.email=? AND (u.id=? OR EXISTS(SELECT 1 FROM memberships m WHERE m.project_id=? AND m.user_id=u.id))').get(email, project.owner_user_id, project.id);
  if (member) return c.json({ error: 'That user is already a project member' }, 409);
  const inviteToken = token();
  const createdAt = now();
  const expiresAt = dateTime(Date.now() + 7 * 24 * 60 * 60 * 1000);
  db.query('INSERT INTO invitations(token_hash,project_id,email,role,created_at,expires_at) VALUES(?,?,?,?,?,?)')
    .run(digest(inviteToken), project.id, email, parsed.role, createdAt, expiresAt);
  return c.json({ invite: { token: inviteToken, projectId: project.id, email, role: parsed.role, expiresAt, link: `${appOrigin}/?invite=${encodeURIComponent(inviteToken)}` } }, 201);
});

app.post('/api/invitations/accept', async c => {
  const { token: inviteToken } = validate(z.object({ token: z.string().min(1).max(256) }).strict(), await body(c));
  const user = requireUser(c);
  const inviteHash = digest(inviteToken);
  const result = db.transaction(() => {
    const invite = db.query('SELECT * FROM invitations WHERE token_hash=?').get(inviteHash) as { project_id: string; email: string; role: 'editor' | 'viewer'; expires_at: string; consumed_at: string | null } | null;
    if (!invite || invite.consumed_at) return { error: 409 as const, message: 'Invitation is invalid or has already been used' };
    if (invite.expires_at <= now()) return { error: 404 as const, message: 'Invitation has expired' };
    if (invite.email !== user.email) return { error: 403 as const, message: 'Invitation belongs to another email address' };
    const project = db.query('SELECT id,name,owner_user_id,created_at FROM projects WHERE id=?').get(invite.project_id) as Project | null;
    if (!project) return { error: 404 as const, message: 'Project not found' };
    if (project.owner_user_id === user.id || db.query('SELECT 1 FROM memberships WHERE project_id=? AND user_id=?').get(project.id, user.id)) {
      db.query('UPDATE invitations SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL').run(now(), inviteHash);
      return { error: 409 as const, message: 'User is already a project member' };
    }
    db.query('INSERT INTO memberships(project_id,user_id,role,created_at) VALUES(?,?,?,?)').run(project.id, user.id, invite.role, now());
    const consumed = db.query('UPDATE invitations SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL').run(now(), inviteHash);
    if (consumed.changes !== 1) throw new Error('Invitation was concurrently consumed');
    return { project, role: invite.role };
  })();
  if ('error' in result) return c.json({ error: result.message }, result.error);
  return c.json({ project: projectJson(result.project, result.role) });
});

app.patch('/api/projects/:projectId/members/:userId', async c => {
  const { role } = validate(z.object({ role: z.enum(['editor', 'viewer']) }).strict(), await body(c));
  const user = requireUser(c);
  const { project } = userRole(user.id, c.req.param('projectId'), ['owner']);
  const targetId = c.req.param('userId');
  if (targetId === project.owner_user_id) return c.json({ error: 'The project owner role cannot be changed' }, 400);
  const result = db.query('UPDATE memberships SET role=? WHERE project_id=? AND user_id=?').run(role, project.id, targetId);
  if (result.changes === 0) return c.json({ error: 'Project member not found' }, 404);
  const member = db.query('SELECT u.id,u.name,u.email,m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.project_id=? AND u.id=?').get(project.id, targetId);
  return c.json({ member });
});

app.delete('/api/projects/:projectId/members/:userId', c => {
  const user = requireUser(c);
  const { project } = userRole(user.id, c.req.param('projectId'), ['owner']);
  const targetId = c.req.param('userId');
  if (targetId === project.owner_user_id) return c.json({ error: 'The project owner cannot be removed' }, 400);
  const result = db.transaction(() => {
    const deleted = db.query('DELETE FROM memberships WHERE project_id=? AND user_id=?').run(project.id, targetId);
    if (deleted.changes) db.query('UPDATE tasks SET assignee_id=NULL,updated_at=? WHERE project_id=? AND assignee_id=?').run(now(), project.id, targetId);
    return deleted.changes;
  })();
  if (!result) return c.json({ error: 'Project member not found' }, 404);
  return c.body(null, 204);
});

app.get('/api/projects/:projectId/tasks', c => {
  const user = requireUser(c);
  const projectId = c.req.param('projectId');
  userRole(user.id, projectId, ['owner', 'editor', 'viewer']);
  const query = c.req.query();
  const allowedQuery = new Set(['q', 'status', 'priority', 'assigneeId', 'page', 'pageSize']);
  if (Object.keys(query).some(key => !allowedQuery.has(key))) return c.json({ error: 'Unknown query parameter' }, 400);
  const page = query.page === undefined ? 1 : Number(query.page);
  const pageSize = query.pageSize === undefined ? 20 : Number(query.pageSize);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) return c.json({ error: 'Page and pageSize must be positive integers; pageSize may not exceed 100' }, 400);
  if (query.status !== undefined && !['todo', 'in_progress', 'done'].includes(query.status)) return c.json({ error: 'Invalid task status filter' }, 400);
  if (query.priority !== undefined && !['low', 'medium', 'high'].includes(query.priority)) return c.json({ error: 'Invalid task priority filter' }, 400);
  const conditions = ['project_id=?'];
  const values: (string | number)[] = [projectId];
  if (query.status) { conditions.push('status=?'); values.push(query.status); }
  if (query.priority) { conditions.push('priority=?'); values.push(query.priority); }
  if (query.assigneeId) { conditions.push('assignee_id=?'); values.push(query.assigneeId); }
  const where = conditions.join(' AND ');
  if (query.q) {
    // SQLite lower() only folds ASCII. Stream candidates through Unicode lowercasing
    // before counting and paging, retaining at most one page in memory.
    const needle = query.q.toLowerCase();
    const tasks: Task[] = [];
    const offset = (page - 1) * pageSize;
    let total = 0;
    for (const task of db.query<Task, (string | number)[]>(`SELECT * FROM tasks WHERE ${where} ORDER BY created_at DESC,id DESC`).iterate(...values)) {
      if (!task.title.toLowerCase().includes(needle) && !task.description.toLowerCase().includes(needle)) continue;
      if (total >= offset && tasks.length < pageSize) tasks.push(task);
      total++;
    }
    return c.json({ tasks: tasks.map(taskJson), total, page, pageSize });
  }
  const total = (db.query(`SELECT COUNT(*) AS total FROM tasks WHERE ${where}`).get(...values) as { total: number }).total;
  const tasks = db.query(`SELECT * FROM tasks WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`)
    .all(...values, pageSize, (page - 1) * pageSize) as Task[];
  return c.json({ tasks: tasks.map(taskJson), total, page, pageSize });
});

app.post('/api/projects/:projectId/tasks', async c => {
  const parsed = validate<z.infer<typeof taskCreateSchema>>(taskCreateSchema, await body(c));
  const user = requireUser(c);
  const projectId = c.req.param('projectId');
  userRole(user.id, projectId, ['owner', 'editor']);
  validDueDate(parsed.dueDate);
  validateAssignee(projectId, parsed.assigneeId);
  const task: Task = { id: id(), project_id: projectId, title: parsed.title, description: parsed.description,
    status: parsed.status, priority: parsed.priority, assignee_id: parsed.assigneeId, due_date: parsed.dueDate,
    created_at: now(), updated_at: now() };
  db.transaction(() => {
    db.query('INSERT INTO tasks(id,project_id,title,description,status,priority,assignee_id,due_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(task.id, task.project_id, task.title, task.description, task.status, task.priority, task.assignee_id, task.due_date, task.created_at, task.updated_at);
    insertActivity(projectId, user.id, 'task_created', task.id, task.title);
  })();
  return c.json({ task: taskJson(task) }, 201);
});

app.get('/api/projects/:projectId/tasks/:taskId', c => {
  const user = requireUser(c);
  const projectId = c.req.param('projectId');
  userRole(user.id, projectId, ['owner', 'editor', 'viewer']);
  return c.json({ task: taskJson(taskFor(projectId, c.req.param('taskId'))) });
});

app.patch('/api/projects/:projectId/tasks/:taskId', async c => {
  const parsed = validate(taskPatchSchema, await body(c));
  const user = requireUser(c);
  const projectId = c.req.param('projectId');
  userRole(user.id, projectId, ['owner', 'editor']);
  const next = db.transaction(() => {
    const old = taskFor(projectId, c.req.param('taskId'));
    const next = { ...old, ...Object.fromEntries(Object.entries(parsed).map(([key, value]) => [
      key === 'assigneeId' ? 'assignee_id' : key === 'dueDate' ? 'due_date' : key, value,
    ])) } as Task;
    validDueDate(next.due_date);
    validateAssignee(projectId, next.assignee_id);
    next.updated_at = now();
    db.query('UPDATE tasks SET title=?,description=?,status=?,priority=?,assignee_id=?,due_date=?,updated_at=? WHERE id=? AND project_id=?')
      .run(next.title, next.description, next.status, next.priority, next.assignee_id, next.due_date, next.updated_at, old.id, projectId);
    insertActivity(projectId, user.id, 'task_updated', old.id, next.title);
    return next;
  })();
  return c.json({ task: taskJson(next) });
});

app.delete('/api/projects/:projectId/tasks/:taskId', c => {
  const user = requireUser(c);
  const projectId = c.req.param('projectId');
  userRole(user.id, projectId, ['owner', 'editor']);
  const task = taskFor(projectId, c.req.param('taskId'));
  db.transaction(() => {
    insertActivity(projectId, user.id, 'task_deleted', task.id, task.title);
    db.query('DELETE FROM tasks WHERE id=? AND project_id=?').run(task.id, projectId);
  })();
  return c.body(null, 204);
});

app.get('/api/projects/:projectId/tasks/:taskId/comments', c => {
  const user = requireUser(c);
  const projectId = c.req.param('projectId');
  userRole(user.id, projectId, ['owner', 'editor', 'viewer']);
  const task = taskFor(projectId, c.req.param('taskId'));
  const comments = db.query('SELECT id,body,author_id AS authorId,created_at AS createdAt FROM comments WHERE task_id=? ORDER BY created_at,id').all(task.id);
  return c.json({ comments });
});

app.post('/api/projects/:projectId/tasks/:taskId/comments', async c => {
  const { body: commentBody } = validate(z.object({ body: persistedText(2000, 1) }).strict(), await body(c));
  const user = requireUser(c);
  const projectId = c.req.param('projectId');
  userRole(user.id, projectId, ['owner', 'editor']);
  const task = taskFor(projectId, c.req.param('taskId'));
  const comment = { id: id(), body: commentBody, authorId: user.id, createdAt: now() };
  db.transaction(() => {
    db.query('INSERT INTO comments(id,task_id,author_id,body,created_at) VALUES(?,?,?,?,?)').run(comment.id, task.id, user.id, comment.body, comment.createdAt);
    insertActivity(projectId, user.id, 'comment_created', task.id, task.title);
  })();
  return c.json({ comment }, 201);
});

app.delete('/api/projects/:projectId/tasks/:taskId/comments/:commentId', c => {
  const user = requireUser(c);
  const projectId = c.req.param('projectId');
  const { role } = userRole(user.id, projectId, ['owner', 'editor']);
  const task = taskFor(projectId, c.req.param('taskId'));
  const commentId = c.req.param('commentId');
  const comment = db.query('SELECT id,author_id FROM comments WHERE id=? AND task_id=?').get(commentId, task.id) as { id: string; author_id: string } | null;
  if (!comment) return c.json({ error: 'Comment not found' }, 404);
  if (role !== 'owner' && comment.author_id !== user.id) return c.json({ error: 'You may delete only your own comments' }, 403);
  db.transaction(() => {
    db.query('DELETE FROM comments WHERE id=? AND task_id=?').run(commentId, task.id);
    insertActivity(projectId, user.id, 'comment_deleted', task.id, task.title);
  })();
  return c.body(null, 204);
});

app.get('/api/projects/:projectId/activity', c => {
  const user = requireUser(c);
  const projectId = c.req.param('projectId');
  userRole(user.id, projectId, ['owner', 'editor', 'viewer']);
  const events = db.query(`
    SELECT a.id,a.action,a.actor_id AS actorId,a.created_at AS createdAt,a.task_id AS taskId,a.task_title AS taskTitle,u.name AS actorName
    FROM activity a JOIN users u ON u.id=a.actor_id WHERE a.project_id=? ORDER BY a.created_at DESC,a.id DESC
  `).all(projectId);
  return c.json({ events });
});

app.get('*', c => {
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'Not found' }, 404);
  let path: string;
  try { path = c.req.path === '/' ? 'index.html' : decodeURIComponent(c.req.path.slice(1)); }
  catch { return c.text('Not found', 404); }
  const filePath = resolve(join(dist, path));
  if (!filePath.startsWith(`${dist}/`) && filePath !== join(dist, 'index.html')) return c.text('Not found', 404);
  if (existsSync(filePath)) {
    const contentType = filePath.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : filePath.endsWith('.css') ? 'text/css; charset=utf-8'
      : filePath.endsWith('.svg') ? 'image/svg+xml'
      : filePath.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream';
    return c.body(readFileSync(filePath), 200, { 'Content-Type': contentType });
  }
  const indexPath = join(dist, 'index.html');
  return existsSync(indexPath) ? c.html(readFileSync(indexPath, 'utf8')) : c.text('Built frontend not found', 503);
});
app.notFound(c => c.req.path.startsWith('/api/')
  ? c.json({ error: 'Not found' }, 404)
  : c.text('Not found', 404));

app.onError((error, c) => {
  if (error instanceof ApiError) return c.json({ error: error.message, code: error.code }, error.status as ContentfulStatusCode);
  console.error('Request failed:', error);
  return c.json({ error: 'An unexpected server error occurred' }, 500);
});

const port = Number(process.env.PORT ?? 3000);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
const dist = resolve('dist');
Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch(request, server) {
    requestIps.set(request, server.requestIP(request)?.address ?? 'unknown');
    return app.fetch(request);
  },
});

console.log(`TaskForge listening on http://127.0.0.1:${port}`);
