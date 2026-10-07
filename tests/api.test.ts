import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createConnection, createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let origin = '';
let processHandle: ReturnType<typeof Bun.spawn> | undefined;
let temporaryDirectory = '';

type Client = { cookie: string };
type Reply<T = unknown> = { status: number; body: T; headers: Headers };

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local port available');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function request<T = Record<string, unknown>>(client: Client | null, method: string, path: string, body?: unknown, requestOrigin = origin): Promise<Reply<T>> {
  const headers = new Headers({ Origin: requestOrigin });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (client?.cookie) headers.set('Cookie', client.cookie);
  const response = await fetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await response.text();
  if (response.headers.has('set-cookie') && client) {
    const match = response.headers.get('set-cookie')?.match(/taskforge_session=([^;]+)/);
    if (match) client.cookie = `taskforge_session=${match[1]}`;
  }
  return { status: response.status, body: raw ? JSON.parse(raw) as T : undefined as T, headers: response.headers };
}

// Send headers and only the start of a body so another request can complete first.
async function delayedRequest(client: Client, method: string, path: string, body: unknown) {
  const data = JSON.stringify(body);
  const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(origin).port) });
  let raw = '';
  const response = new Promise<number>((resolve, reject) => {
    socket.on('data', chunk => { raw += chunk.toString(); });
    socket.on('end', () => resolve(Number(raw.split(' ')[1])));
    socket.on('error', reject);
    socket.setTimeout(5000, () => socket.destroy(new Error('Delayed request timed out')));
  });
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.write(`${method} ${path} HTTP/1.1\r\nHost: ${new URL(origin).host}\r\nOrigin: ${origin}\r\nCookie: ${client.cookie}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(data)}\r\nConnection: close\r\n\r\n${data.slice(0, 1)}`);
  await Bun.sleep(75);
  return { finish: () => { socket.write(data.slice(1)); return response; }, close: () => socket.destroy() };
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (processHandle?.exitCode !== null && processHandle?.exitCode !== undefined) throw new Error('TaskForge server exited before becoming ready');
    try {
      const result = await fetch(`${origin}/api/health`);
      if (result.ok) return;
    } catch { await Bun.sleep(50); }
  }
  throw new Error('TaskForge server did not become healthy');
}

beforeAll(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'taskforge-tests-'));
  const port = await unusedPort();
  origin = `http://127.0.0.1:${port}`;
  processHandle = Bun.spawn(['bun', 'server/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test', AUTH_RATE_LIMIT_MAX: '10000', PORT: String(port), APP_ORIGIN: origin, DATABASE_PATH: join(temporaryDirectory, 'db', 'test.sqlite') },
    stdout: 'ignore', stderr: 'pipe',
  });
  await waitForServer();
}, 20000);

afterAll(async () => {
  if (processHandle) {
    processHandle.kill('SIGTERM');
    await processHandle.exited;
  }
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('partial updates preserve concurrent changes and recheck authorization after a delayed body', async () => {
  const owner: Client = { cookie: '' };
  const editor: Client = { cookie: '' };
  const email = `race-editor-${crypto.randomUUID()}@example.test`;
  const password = 'Strong-race-password-2030!';
  await request(owner, 'POST', '/api/auth/register', { name: 'Race owner', email: `race-owner-${crypto.randomUUID()}@example.test`, password });
  const registered = await request<{ user: { id: string } }>(editor, 'POST', '/api/auth/register', { name: 'Race editor', email, password });
  const project = await request<{ project: { id: string } }>(owner, 'POST', '/api/projects', { name: 'Race project' });
  const base = `/api/projects/${project.body.project.id}`;
  const invite = await request<{ invite: { token: string } }>(owner, 'POST', `${base}/invitations`, { email, role: 'editor' });
  await request(editor, 'POST', '/api/invitations/accept', { token: invite.body.invite.token });
  const task = await request<{ task: { id: string } }>(owner, 'POST', `${base}/tasks`, { title: 'Original' });
  const taskPath = `${base}/tasks/${task.body.task.id}`;

  const patch = await delayedRequest(owner, 'PATCH', taskPath, { title: 'Delayed title' });
  try {
    expect((await request(owner, 'PATCH', taskPath, { status: 'done' })).status).toBe(200);
    expect(await patch.finish()).toBe(200);
    const current = await request<{ task: { title: string; status: string } }>(owner, 'GET', taskPath);
    expect(current.body.task).toMatchObject({ title: 'Delayed title', status: 'done' });
  } finally { patch.close(); }

  for (const [method, path, body] of [
    ['POST', `${base}/tasks`, { title: 'Forbidden delayed creation' }],
    ['PATCH', taskPath, { title: 'Forbidden delayed update' }],
    ['POST', `${taskPath}/comments`, { body: 'Forbidden delayed comment' }],
  ] as const) {
    await request(owner, 'PATCH', `${base}/members/${registered.body.user.id}`, { role: 'editor' });
    const delayed = await delayedRequest(editor, method, path, body);
    try {
      expect((await request(owner, 'PATCH', `${base}/members/${registered.body.user.id}`, { role: 'viewer' })).status).toBe(200);
      expect(await delayed.finish()).toBe(403);
    } finally { delayed.close(); }
  }
  const tasks = await request<{ total: number }>(owner, 'GET', `${base}/tasks`);
  expect(tasks.body.total).toBe(1);
  expect((await request<{ comments: unknown[] }>(owner, 'GET', `${taskPath}/comments`)).body.comments).toHaveLength(0);

  await request(owner, 'PATCH', `${base}/members/${registered.body.user.id}`, { role: 'editor' });
  const removedMember = await delayedRequest(editor, 'PATCH', taskPath, { title: 'After removal' });
  try {
    expect((await request(owner, 'DELETE', `${base}/members/${registered.body.user.id}`)).status).toBe(204);
    expect(await removedMember.finish()).toBe(404);
  } finally { removedMember.close(); }

  const deletedTask = await delayedRequest(owner, 'POST', `${taskPath}/comments`, { body: 'After task deletion' });
  try {
    expect((await request(owner, 'DELETE', taskPath)).status).toBe(204);
    expect(await deletedTask.finish()).toBe(404);
  } finally { deletedTask.close(); }

  // A previously authenticated request must also stop after its session is revoked.
  const session = await delayedRequest(editor, 'POST', '/api/projects', { name: 'After logout' });
  try {
    expect((await request(editor, 'POST', '/api/auth/logout')).status).toBe(204);
    expect(await session.finish()).toBe(401);
    const expired = await request(editor, 'GET', '/api/auth/me');
    expect(expired.body).toMatchObject({ code: 'SESSION_EXPIRED' });
  } finally { session.close(); }
}, 20000);

test('concurrent password changes cannot reuse the verified old password after revocation', async () => {
  const first: Client = { cookie: '' };
  const second: Client = { cookie: '' };
  const email = `password-race-${crypto.randomUUID()}@example.test`;
  const password = 'Initial-password-2030!';
  await request(first, 'POST', '/api/auth/register', { name: 'Password race', email, password });
  await request(second, 'POST', '/api/auth/login', { email, password });
  const incorrect = await request(first, 'POST', '/api/auth/password', { currentPassword: 'Incorrect-password-2030!', newPassword: 'Next-password-2030!' });
  expect(incorrect.status).toBe(401);
  expect(incorrect.body).not.toHaveProperty('code');
  expect((await request(first, 'GET', '/api/auth/me')).status).toBe(200);
  const replacements = ['First-password-2030!', 'Second-password-2030!'];
  const results = await Promise.all([first, second].map((client, index) => request(client, 'POST', '/api/auth/password', { currentPassword: password, newPassword: replacements[index] })));
  expect(results.map(result => result.status).sort()).toEqual([204, 401]);
  expect((await request(first, 'GET', '/api/auth/me')).status).toBe(401);
  expect((await request(second, 'GET', '/api/auth/me')).status).toBe(401);
  for (const [index, replacement] of replacements.entries()) {
    expect((await request(null, 'POST', '/api/auth/login', { email, password: replacement })).status).toBe(results[index]?.status === 204 ? 200 : 401);
  }
}, 20000);

test('Unicode literal search keeps filtered totals and stable pagination; unknown routes are JSON 404', async () => {
  const owner: Client = { cookie: '' };
  await request(owner, 'POST', '/api/auth/register', { name: 'Search owner', email: `search-${crypto.randomUUID()}@example.test`, password: 'Search-password-2030!' });
  const project = await request<{ project: { id: string } }>(owner, 'POST', '/api/projects', { name: 'Unicode search' });
  const base = `/api/projects/${project.body.project.id}`;
  await request(owner, 'POST', `${base}/tasks`, { title: 'ПРОВЕРКА ÉCOLE 100%_literal', status: 'done', priority: 'high' });
  await request(owner, 'POST', `${base}/tasks`, { title: 'Second', description: 'Проверка école 100%_literal', status: 'done', priority: 'high' });
  await request(owner, 'POST', `${base}/tasks`, { title: 'ПРОВЕРКА', status: 'todo' });
  for (const q of ['проверка', 'école', '100%_literal']) {
    const query = `q=${encodeURIComponent(q)}&status=done&priority=high&pageSize=1`;
    const first = await request<{ tasks: Array<{ id: string }>; total: number }>(owner, 'GET', `${base}/tasks?${query}&page=1`);
    const second = await request<{ tasks: Array<{ id: string }>; total: number }>(owner, 'GET', `${base}/tasks?${query}&page=2`);
    expect(first.body.total).toBe(2);
    expect(second.body.total).toBe(2);
    expect(first.body.tasks).toHaveLength(1);
    expect(second.body.tasks).toHaveLength(1);
    expect(first.body.tasks[0]?.id).not.toBe(second.body.tasks[0]?.id);
  }
  for (const client of [null, owner]) {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      const result = await request(client, method, '/api/does-not-exist');
      expect(result.status).toBe(404);
      expect(result.body).toEqual({ error: 'Not found' });
    }
  }
}, 20000);

test('embedded NUL in persisted text returns 400 without creating or updating resources', async () => {
  const owner: Client = { cookie: '' };
  const email = `nul-${crypto.randomUUID()}@example.test`;
  const credentials = { email, password: 'Nul-regression-password!' };
  expect((await request(null, 'POST', '/api/auth/register', { ...credentials, name: '\u0000Owner' })).status).toBe(400);
  expect((await request(owner, 'POST', '/api/auth/register', { ...credentials, name: 'Owner' })).status).toBe(201);
  expect((await request(owner, 'POST', '/api/projects', { name: '\u0000Project' })).status).toBe(400);
  expect((await request<{ projects: unknown[] }>(owner, 'GET', '/api/projects')).body.projects).toHaveLength(0);
  const created = await request<{ project: { id: string } }>(owner, 'POST', '/api/projects', { name: 'Project' });
  const base = `/api/projects/${created.body.project.id}`;
  expect((await request(owner, 'PATCH', base, { name: 'Hidden\u0000suffix' })).status).toBe(400);
  expect((await request<{ project: { name: string } }>(owner, 'GET', base)).body.project.name).toBe('Project');
  for (const invalid of [{ title: '\u0000Task' }, { title: 'Task', description: 'Before\u0000after' }]) {
    expect((await request(owner, 'POST', `${base}/tasks`, invalid)).status).toBe(400);
  }
  expect((await request<{ total: number }>(owner, 'GET', `${base}/tasks`)).body.total).toBe(0);
  const taskResult = await request<{ task: { id: string } }>(owner, 'POST', `${base}/tasks`, { title: 'Task', description: 'Description' });
  const taskPath = `${base}/tasks/${taskResult.body.task.id}`;
  for (const invalid of [{ title: '\u0000Task' }, { description: 'Before\u0000after' }]) {
    expect((await request(owner, 'PATCH', taskPath, invalid)).status).toBe(400);
  }
  expect((await request<{ task: { title: string; description: string } }>(owner, 'GET', taskPath)).body.task).toMatchObject({ title: 'Task', description: 'Description' });
  expect((await request(owner, 'POST', `${taskPath}/comments`, { body: '\u0000Comment' })).status).toBe(400);
  expect((await request<{ comments: unknown[] }>(owner, 'GET', `${taskPath}/comments`)).body.comments).toHaveLength(0);
  expect((await request<{ events: Array<{ action: string }> }>(owner, 'GET', `${base}/activity`)).body.events.map(event => event.action)).toEqual(['task_created']);
});

test('auth, project permissions, invitations, task filters, comments, activity, and cleanup persist through server restart', async () => {
  const owner: Client = { cookie: '' };
  const member: Client = { cookie: '' };
  const outsider: Client = { cookie: '' };
  const password = 'Correct-horse-2030!';
  const ownerEmail = `owner-${crypto.randomUUID()}@example.test`;
  const memberEmail = `member-${crypto.randomUUID()}@example.test`;
  const outsiderEmail = `outsider-${crypto.randomUUID()}@example.test`;

  const registered = await request<{ user: { id: string; name: string; email: string } }>(owner, 'POST', '/api/auth/register', { name: ' Owner ', email: ` ${ownerEmail.toUpperCase()} `, password });
  expect(registered.status).toBe(201);
  expect(registered.body.user.name).toBe('Owner');
  expect(registered.body.user.email).toBe(ownerEmail);
  expect(JSON.stringify(registered.body).toLowerCase()).not.toContain('password');
  expect(registered.headers.get('set-cookie')?.toLowerCase()).toContain('httponly');
  const ownerId = registered.body.user.id;

  const duplicate = await request(null, 'POST', '/api/auth/register', { name: 'Again', email: ownerEmail.toUpperCase(), password });
  expect(duplicate.status).toBe(409);
  const invalidLogin = await request(null, 'POST', '/api/auth/login', { email: ownerEmail, password: 'not-correct' });
  expect(invalidLogin.status).toBe(401);
  const wrongOrigin = await request(owner, 'POST', '/api/projects', { name: 'Blocked' }, 'https://foreign.example');
  expect(wrongOrigin.status).toBe(403);

  const memberRegistered = await request<{ user: { id: string } }>(member, 'POST', '/api/auth/register', { name: 'Member', email: memberEmail, password });
  const outsiderRegistered = await request<{ user: { id: string } }>(outsider, 'POST', '/api/auth/register', { name: 'Outsider', email: outsiderEmail, password });
  expect(memberRegistered.status).toBe(201);
  expect(outsiderRegistered.status).toBe(201);

  const projectResult = await request<{ project: { id: string; role: string } }>(owner, 'POST', '/api/projects', { name: ' Release plan ' });
  expect(projectResult.status).toBe(201);
  expect(projectResult.body.project.role).toBe('owner');
  const projectId = projectResult.body.project.id;
  const base = `/api/projects/${projectId}`;
  expect((await request(outsider, 'GET', base)).status).toBe(404);

  const inviteResult = await request<{ invite: { token: string } }>(owner, 'POST', `${base}/invitations`, { email: memberEmail, role: 'editor' });
  expect(inviteResult.status).toBe(201);
  const inviteToken = inviteResult.body.invite.token;
  expect((await request(owner, 'POST', '/api/invitations/accept', { token: inviteToken })).status).toBe(403);
  expect((await request(member, 'POST', '/api/invitations/accept', { token: inviteToken })).status).toBe(200);
  expect((await request(member, 'POST', '/api/invitations/accept', { token: inviteToken })).status).toBe(409);
  expect((await request(member, 'PATCH', base, { name: 'Nope' })).status).toBe(403);

  const taskAResult = await request<{ task: { id: string; title: string; description: string; status: string; assigneeId: string | null } }>(owner, 'POST', `${base}/tasks`, { title: ' Build checklist ', description: ' Some context ', status: 'done', priority: 'high', assigneeId: memberRegistered.body.user.id });
  const taskBResult = await request<{ task: { id: string; title: string } }>(member, 'POST', `${base}/tasks`, { title: 'Other task' });
  expect(taskAResult.status).toBe(201);
  expect(taskAResult.body.task.title).toBe('Build checklist');
  expect(taskAResult.body.task.description).toBe('Some context');
  expect((await request(owner, 'POST', `${base}/tasks`, { title: 'Bad', assigneeId: outsiderRegistered.body.user.id })).status).toBe(400);
  expect((await request(owner, 'PATCH', `${base}/tasks/${taskAResult.body.task.id}`, {})).status).toBe(400);
  const filtered = await request<{ tasks: Array<{ id: string }>; total: number; page: number; pageSize: number }>(owner, 'GET', `${base}/tasks?q=checklist&status=done&priority=high&page=1&pageSize=1`);
  expect(filtered.body.total).toBe(1);
  expect(filtered.body.tasks[0]?.id).toBe(taskAResult.body.task.id);
  expect((await request(outsider, 'GET', `${base}/tasks/${taskAResult.body.task.id}`)).status).toBe(404);

  const commentResult = await request<{ comment: { id: string; authorId: string } }>(member, 'POST', `${base}/tasks/${taskAResult.body.task.id}/comments`, { body: 'A useful note' });
  expect(commentResult.status).toBe(201);
  expect(commentResult.body.comment.authorId).toBe(memberRegistered.body.user.id);
  expect((await request(member, 'DELETE', `${base}/tasks/${taskAResult.body.task.id}/comments/${commentResult.body.comment.id}`)).status).toBe(204);
  const ownerComment = await request<{ comment: { id: string } }>(owner, 'POST', `${base}/tasks/${taskAResult.body.task.id}/comments`, { body: 'Owner note' });
  expect((await request(member, 'DELETE', `${base}/tasks/${taskAResult.body.task.id}/comments/${ownerComment.body.comment.id}`)).status).toBe(403);
  expect((await request(owner, 'PATCH', `${base}/members/${memberRegistered.body.user.id}`, { role: 'viewer' })).status).toBe(200);
  expect((await request(member, 'POST', `${base}/tasks`, { title: 'Must be denied' })).status).toBe(403);
  expect((await request(owner, 'PATCH', `${base}/members/${ownerId}`, { role: 'viewer' })).status).toBe(400);

  const events = await request<{ events: Array<{ action: string; actorId: string; taskTitle: string | null }> }>(owner, 'GET', `${base}/activity`);
  expect(events.body.events.map(event => event.action)).toContain('comment_deleted');
  expect(events.body.events.every(event => event.actorId)).toBe(true);
  expect((await request(owner, 'DELETE', `${base}/tasks/${taskAResult.body.task.id}`)).status).toBe(204);
  const afterDelete = await request<{ events: Array<{ action: string; taskTitle: string | null }> }>(owner, 'GET', `${base}/activity`);
  expect(afterDelete.body.events.some(event => event.action === 'task_deleted' && event.taskTitle === 'Build checklist')).toBe(true);
  expect((await request(owner, 'GET', `${base}/tasks/${taskAResult.body.task.id}/comments`)).status).toBe(404);

  const updatedPassword = 'New-correct-password-2030!';
  const secondSession: Client = { cookie: '' };
  expect((await request(secondSession, 'POST', '/api/auth/login', { email: ownerEmail, password })).status).toBe(200);
  expect((await request(owner, 'POST', '/api/auth/password', { currentPassword: password, newPassword: updatedPassword })).status).toBe(204);
  expect((await request(owner, 'GET', '/api/auth/me')).status).toBe(401);
  expect((await request(secondSession, 'GET', '/api/auth/me')).status).toBe(401);
  const activeOwner: Client = { cookie: '' };
  expect((await request(activeOwner, 'POST', '/api/auth/login', { email: ownerEmail, password: updatedPassword })).status).toBe(200);

  const racingLogin: Client = { cookie: '' };
  const nextPassword = 'Another-correct-password-2030!';
  const [racingReply, passwordReply] = await Promise.all([
    request(racingLogin, 'POST', '/api/auth/login', { email: ownerEmail, password: updatedPassword }),
    request(activeOwner, 'POST', '/api/auth/password', { currentPassword: updatedPassword, newPassword: nextPassword }),
  ]);
  expect([200, 401]).toContain(racingReply.status);
  expect(passwordReply.status).toBe(204);
  expect((await request(racingLogin, 'GET', '/api/auth/me')).status).toBe(401);

  const port = Number(new URL(origin).port);
  processHandle?.kill('SIGTERM');
  await processHandle?.exited;
  processHandle = Bun.spawn(['bun', 'server/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test', AUTH_RATE_LIMIT_MAX: '10000', PORT: String(port), APP_ORIGIN: origin, DATABASE_PATH: join(temporaryDirectory, 'db', 'test.sqlite') },
    stdout: 'ignore', stderr: 'pipe',
  });
  await waitForServer();
  const loggedIn: Client = { cookie: '' };
  await request(loggedIn, 'POST', '/api/auth/login', { email: ownerEmail, password: nextPassword });
  expect((await request(loggedIn, 'GET', `${base}/tasks/${taskBResult.body.task.id}`)).status).toBe(200);
  expect((await request(loggedIn, 'DELETE', base)).status).toBe(204);
  expect((await request(loggedIn, 'GET', base)).status).toBe(404);
  expect((await request(outsider, 'GET', '/api/unknown')).status).toBe(404);
});
