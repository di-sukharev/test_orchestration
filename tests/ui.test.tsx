import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { act, StrictMode } from 'react';
import { Window } from 'happy-dom';
import { App } from '../src/ui/App';

// A DOM emulator runs React and the real stylesheet without opening a browser.
const dom = new Window({ url: 'http://localhost:3000', width: 390, height: 844 });
for (const key of ['window', 'document', 'navigator', 'location', 'history', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent']) {
  const value = key === 'window' ? dom : dom[key as keyof Window];
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import('react-dom/client');
const originalFetch = globalThis.fetch;
let root: ReturnType<typeof createRoot>;
let projects: Array<{ id: string; name: string; role: string }> = [];
let expiredRoute = '';
let expiredMethod = '';
let incorrectPassword = false;
let routeOverride: ((path: string, method: string, init?: RequestInit) => Response | Promise<Response> | undefined) | undefined;
let comments: Array<{ id: string; body: string; authorId: string; createdAt: string }> = [];
const user = { id: 'user-1', name: 'Owner', email: 'owner@example.test' };
const project = { id: 'project-1', name: 'Team project', role: 'owner' };
const task = { id: 'task-1', projectId: project.id, title: 'Real task', description: '', status: 'todo', priority: 'medium', assigneeId: null, dueDate: null };
const base = `/api/projects/${project.id}`;
const taskPath = `${base}/tasks/${task.id}`;

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(async () => {
  projects = [];
  expiredRoute = ''; expiredMethod = ''; incorrectPassword = false;
  routeOverride = undefined; comments = [];
  document.head.innerHTML = `<style>${readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8')}</style>`;
  document.body.innerHTML = '<div id="root"></div>';
  // Mock the HTTP boundary, never components, hooks, API error handling, or CSS.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), location.origin).pathname;
    const method = init?.method ?? 'GET';
    const overridden = routeOverride?.(path, method, init);
    if (overridden) return overridden;
    if (path === expiredRoute && method === expiredMethod) return reply({ error: 'Session expired. Please sign in again.', code: 'SESSION_EXPIRED' }, 401);
    if (path === '/api/auth/me') return reply({ user });
    if (path === '/api/projects' && method === 'POST') {
      const { name } = JSON.parse(String(init?.body)) as { name: string };
      const created = { ...project, name };
      projects.push(created);
      return reply({ project: created }, 201);
    }
    if (path === '/api/projects') return reply({ projects });
    if (path === base) return reply({ project: projects[0] ?? project, members: [{ ...user, role: 'owner' }] });
    if (path === `${base}/tasks`) return reply({ tasks: [task], total: 1 });
    if (path === `${taskPath}/comments`) return reply({ comments });
    if (path === '/api/auth/password' && incorrectPassword) return reply({ error: 'Current password is incorrect' }, 401);
    throw new Error(`Unexpected UI request: ${method} ${path}`);
  }) as typeof fetch;
  root = createRoot(document.getElementById('root')!);
});

afterEach(async () => {
  await act(async () => root.unmount());
  globalThis.fetch = originalFetch;
});

async function render() { await act(async () => root.render(<App />)); }
async function click(element: HTMLElement) { await act(async () => element.click()); }
function button(label: string) {
  const found = [...document.querySelectorAll('button')].find(element => element.textContent?.trim() === label || element.getAttribute('aria-label') === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function fill(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit(selector: string) {
  await act(async () => document.querySelector(selector)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}
async function openProject() { await click(button('Team project')); }
async function openTask() { await click(document.querySelector<HTMLElement>('.task-table tbody tr')!); }

test('a new account can focus and create its first project at a narrow viewport', async () => {
  await render();
  const input = document.querySelector<HTMLInputElement>('#new-project-name')!;
  for (let element: Element | null = input; element; element = element.parentElement) {
    expect(window.getComputedStyle(element).display).not.toBe('none');
    expect(window.getComputedStyle(element).visibility).not.toBe('hidden');
  }
  await click(button('Create project'));
  expect(document.activeElement).toBe(input);
  await fill('#new-project-name', 'Mobile first project');
  expect(button('Add').disabled).toBe(false);
  await submit('.new-project');
  expect(projects).toHaveLength(1);
  expect(document.querySelector('h1')?.textContent).toBe('Mobile first project');
});

test.each(['task list', 'comment list', 'task save', 'comment add', 'password change'])('%s returns the user to sign-in when the session expires', async scenario => {
  projects = [project];
  await render();
  if (scenario === 'password change') {
    await click(button('Account'));
    await fill('input[autocomplete="current-password"]', 'Current-password-2030!');
    await fill('input[autocomplete="new-password"]', 'Next-password-2030!');
    expiredRoute = '/api/auth/password'; expiredMethod = 'POST';
    await submit('.account-dialog form');
  } else {
    if (scenario === 'task list') { expiredRoute = `${base}/tasks`; expiredMethod = 'GET'; }
    await openProject();
    if (scenario !== 'task list') {
      if (scenario === 'comment list') { expiredRoute = `${taskPath}/comments`; expiredMethod = 'GET'; }
      await openTask();
      if (scenario === 'task save') { expiredRoute = taskPath; expiredMethod = 'PATCH'; await fill('.task-edit-form input', 'Changed title'); await submit('.task-edit-form'); }
      if (scenario === 'comment add') {
        const textarea = document.querySelector<HTMLTextAreaElement>('#new-comment')!;
        await act(async () => { textarea.value = 'A comment'; textarea.dispatchEvent(new Event('input', { bubbles: true })); });
        expiredRoute = `${taskPath}/comments`; expiredMethod = 'POST'; await submit('.comment-form');
      }
    }
  }
  expect(document.querySelector('#auth-title')?.textContent).toBe('Welcome back');
  expect(document.body.textContent).toContain('Your session has expired. Sign in again to continue.');
  expect(document.querySelector('.workspace')).toBeNull();
});

test('an incorrect current password remains a validation error without signing out', async () => {
  projects = [project]; incorrectPassword = true;
  await render();
  await click(button('Account'));
  await fill('input[autocomplete="current-password"]', 'Incorrect-password-2030!');
  await fill('input[autocomplete="new-password"]', 'Next-password-2030!');
  await submit('.account-dialog form');
  expect(document.querySelector('.account-dialog')?.textContent).toContain('Current password is incorrect');
  expect(document.querySelector('.workspace')).not.toBeNull();
  expect(document.querySelector('#auth-title')).toBeNull();
});

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}

const privateEvent = { id: 'private-event', action: 'task_created', actorId: user.id, actorName: user.name, createdAt: '2030-01-01T00:00:00Z', taskTitle: 'Confidential acquisition', taskId: task.id };
const secondUser = { id: 'user-2', name: 'Second user', email: 'second@example.test' };
const secondProject = { id: 'project-2', name: 'Second project', role: 'owner' };
const secondBase = `/api/projects/${secondProject.id}`;

test.each(['logout', 'password change', 'session expiry'])('%s clears private caches and ignores delayed activity from the previous account', async transition => {
  projects = [project];
  let delayActivity = false;
  let secondAccount = false;
  const previousActivity = deferredResponse();
  const nextProjects = deferredResponse();
  const nextActivity = deferredResponse();
  routeOverride = (path, method) => {
    if (path === `${base}/activity`) return delayActivity ? previousActivity.promise : reply({ events: [privateEvent] });
    if (path === '/api/auth/logout' || path === '/api/auth/password') return new Response(null, { status: 204 });
    if (path === '/api/auth/login') { secondAccount = true; projects = [secondProject]; return reply({ user: secondUser }); }
    if (secondAccount && path === '/api/projects') return nextProjects.promise;
    if (path === secondBase) return reply({ project: secondProject, members: [{ ...secondUser, role: 'owner' }] });
    if (path === `${secondBase}/tasks`) return reply({ tasks: [], total: 0 });
    if (path === `${secondBase}/activity`) return nextActivity.promise;
    if (secondAccount && path === base) return reply({ error: 'Project not found' }, 404);
    void method;
  };
  await render(); await openProject(); await click(button('Activity'));
  expect(document.body.textContent).toContain(privateEvent.taskTitle);
  await click(button('Tasks')); delayActivity = true; await click(button('Activity'));
  if (transition === 'logout') await click(button('Sign out'));
  else if (transition === 'password change') {
    await click(button('Account'));
    await fill('input[autocomplete="current-password"]', 'Current-password-2030!');
    await fill('input[autocomplete="new-password"]', 'Next-password-2030!');
    await submit('.account-dialog form');
  } else await act(async () => window.dispatchEvent(new window.Event('taskforge:session-expired')));
  await submit('.auth-card form');
  expect(document.body.textContent).not.toContain(project.name);
  await act(async () => nextProjects.resolve(reply({ projects: [secondProject] })));
  await click(button(secondProject.name)); await click(button('Activity'));
  expect(document.body.textContent).not.toContain(privateEvent.taskTitle);
  await act(async () => previousActivity.resolve(reply({ events: [privateEvent] })));
  expect(document.body.textContent).not.toContain(privateEvent.taskTitle);
  await act(async () => nextActivity.resolve(reply({ error: 'Could not load activity' }, 503)));
  expect(document.body.textContent).toContain('Could not load activity');
  expect(document.body.textContent).not.toContain(privateEvent.taskTitle);
  expect(document.querySelector('.account-name')?.textContent).toBe(secondUser.name);
});

test('a delayed authentication error from the previous account cannot expire a new account', async () => {
  projects = [project];
  const previousActivity = deferredResponse();
  routeOverride = path => {
    if (path === `${base}/activity`) return previousActivity.promise;
    if (path === '/api/auth/logout') return new Response(null, { status: 204 });
    if (path === '/api/auth/login') { projects = [secondProject]; return reply({ user: secondUser }); }
  };
  await render(); await openProject(); await click(button('Activity')); await click(button('Sign out')); await submit('.auth-card form');
  await act(async () => previousActivity.resolve(reply({ error: 'Session expired', code: 'SESSION_EXPIRED' }, 401)));
  expect(document.querySelector('.account-name')?.textContent).toBe(secondUser.name);
  expect(document.querySelector('#auth-title')).toBeNull();
  expect(document.body.textContent).not.toContain(project.name);
});

test('failed project detail loading clears the previous project and its member information', async () => {
  projects = [project, secondProject];
  const detail = deferredResponse();
  routeOverride = path => {
    if (path === secondBase) return detail.promise;
  };
  await render(); await openProject(); await click(button('People'));
  expect(document.body.textContent).toContain(user.email);
  await click(button(secondProject.name));
  expect(document.querySelector('.project-content')).toBeNull();
  expect(document.body.textContent).not.toContain(user.email);
  expect(document.body.textContent).toContain('Loading project');
  await act(async () => detail.resolve(reply({ error: 'Project not found' }, 404)));
  expect(document.body.textContent).toContain('Project not found');
  expect(document.querySelector('.project-content')).toBeNull();
  expect(document.body.textContent).not.toContain(user.email);
});

test('project transitions clear activity and ignore a delayed task creation from the previous project', async () => {
  projects = [project, secondProject];
  const delayedTask = deferredResponse();
  routeOverride = (path, method) => {
    if (path === `${base}/activity`) return reply({ events: [privateEvent] });
    if (path === `${base}/tasks` && method === 'POST') return delayedTask.promise;
    if (path === secondBase) return reply({ project: secondProject, members: [{ ...user, role: 'owner' }] });
    if (path === `${secondBase}/tasks`) return reply({ tasks: [], total: 0 });
    if (path === `${secondBase}/activity`) return reply({ error: 'Activity load failed' }, 503);
  };
  await render(); await openProject(); await click(button('Activity'));
  expect(document.body.textContent).toContain(privateEvent.taskTitle);
  await click(button('Tasks')); await click(button('＋ New task')); await fill('#new-task-title', 'Old project task'); await submit('.new-task-form');
  await click(button(secondProject.name)); await click(button('Activity'));
  expect(document.body.textContent).not.toContain(privateEvent.taskTitle);
  await act(async () => delayedTask.resolve(reply({ task: { ...task, title: 'Old project task' } }, 201)));
  expect(document.querySelector('h1')?.textContent).toBe(secondProject.name);
  expect(document.body.textContent).not.toContain('Old project task');
});

test('a delayed task save cannot replace the task the user subsequently opens', async () => {
  projects = [project];
  const otherTask = { ...task, id: 'other-task', title: 'Other task' };
  const saved = deferredResponse();
  routeOverride = (path, method) => {
    if (path === `${base}/tasks`) return reply({ tasks: [task, otherTask], total: 2 });
    if (path === taskPath && method === 'PATCH') return saved.promise;
    if (path === `${base}/tasks/${otherTask.id}/comments`) return reply({ comments: [] });
  };
  await render(); await openProject(); await openTask(); await fill('.task-edit-form input', 'Saved previous task'); await submit('.task-edit-form');
  await click(button('Back to tasks'));
  await click(document.querySelectorAll<HTMLElement>('.task-table tbody tr')[1]!);
  expect(document.querySelector('h1')?.textContent).toBe(otherTask.title);
  await act(async () => saved.resolve(reply({ task: { ...task, title: 'Saved previous task' } })));
  expect(document.querySelector('h1')?.textContent).toBe(otherTask.title);
});

test.each([['viewer', 0], ['editor', 1], ['owner', 2]] as const)('%s sees only permitted comment deletion controls', async (role, count) => {
  projects = [{ ...project, role }];
  comments = [
    { id: 'own', body: 'Own comment', authorId: user.id, createdAt: '2030-01-01T00:00:00Z' },
    { id: 'other', body: 'Other comment', authorId: secondUser.id, createdAt: '2030-01-01T00:00:00Z' },
  ];
  await render(); await openProject(); await openTask();
  expect(document.querySelectorAll('button[aria-label="Delete comment"]')).toHaveLength(count);
  if (role === 'editor') expect(document.querySelector('button[aria-label="Delete comment"]')?.closest('li')?.textContent).toContain('Own comment');
});

test('task saves preserve unrelated concurrent edits and reset their baseline from the server', async () => {
  projects = [project];
  let persisted = { ...task };
  const patches: Array<Partial<typeof task>> = [];
  routeOverride = (path, method, init) => {
    if (path === taskPath && method === 'PATCH') {
      const patch = JSON.parse(String(init?.body)) as Partial<typeof task>;
      patches.push(patch);
      persisted = { ...persisted, ...patch, title: (patch.title ?? persisted.title).trim() };
      return reply({ task: persisted });
    }
  };
  await render(); await openProject(); await openTask();
  expect(button('Save changes').disabled).toBe(true);
  await submit('.task-edit-form');
  expect(patches).toHaveLength(0);
  // Another client completes the task and supplies context after this editor opens.
  persisted = { ...persisted, status: 'done', description: 'Important teammate note' };
  await fill('.task-edit-form input', ' My title edit ');
  await submit('.task-edit-form');
  expect(patches).toEqual([{ title: 'My title edit' }]);
  expect(persisted).toMatchObject({ title: 'My title edit', status: 'done', description: 'Important teammate note' });
  expect(document.querySelector<HTMLInputElement>('.task-edit-form input')?.value).toBe('My title edit');
  expect(document.querySelector<HTMLTextAreaElement>('.task-edit-form textarea')?.value).toBe('Important teammate note');
  expect(document.querySelector<HTMLSelectElement>('.task-edit-form select')?.value).toBe('done');
  expect(button('Save changes').disabled).toBe(true);
  await submit('.task-edit-form');
  expect(patches).toHaveLength(1);
  persisted = { ...persisted, priority: 'high' };
  await fill('.task-edit-form input', 'Second title');
  await submit('.task-edit-form');
  expect(patches[1]).toEqual({ title: 'Second title' });
  expect(persisted).toMatchObject({ status: 'done', description: 'Important teammate note', priority: 'high' });
});

test('typing during a task save remains dirty against the returned baseline', async () => {
  projects = [project];
  const saved = deferredResponse();
  const patches: Array<Partial<typeof task>> = [];
  routeOverride = (path, method, init) => {
    if (path === taskPath && method === 'PATCH') {
      const patch = JSON.parse(String(init?.body)) as Partial<typeof task>;
      patches.push(patch);
      return patches.length === 1 ? saved.promise : reply({ task: { ...task, ...patch, status: 'done' } });
    }
  };
  await render(); await openProject(); await openTask();
  await fill('.task-edit-form input', 'Submitted title'); await submit('.task-edit-form');
  await fill('.task-edit-form input', 'Next unsaved title');
  await act(async () => saved.resolve(reply({ task: { ...task, title: 'Submitted title', status: 'done' } })));
  expect(document.querySelector<HTMLInputElement>('.task-edit-form input')?.value).toBe('Next unsaved title');
  expect(document.querySelector<HTMLSelectElement>('.task-edit-form select')?.value).toBe('done');
  expect(button('Save changes').disabled).toBe(false);
  await submit('.task-edit-form');
  expect(patches).toEqual([{ title: 'Submitted title' }, { title: 'Next unsaved title' }]);
  expect(button('Save changes').disabled).toBe(true);
});

test('account modal stays open through Strict Mode effect setup and cleanup', async () => {
  await act(async () => root.render(<StrictMode><App /></StrictMode>));
  const opener = button('Account'); opener.focus();
  await click(opener);
  expect(document.querySelector<HTMLDialogElement>('dialog.account-dialog')?.open).toBe(true);
  await click(button('Close account settings'));
  expect(document.querySelector('.account-dialog')).toBeNull();
  expect(document.activeElement).toBe(opener);
});

test.each(['escape', 'cancel event', 'native close', 'Cancel', 'Close account settings'])('account modal restores focus and synchronizes state after %s', async dismissal => {
  await render();
  const opener = button('Account'); opener.focus();
  await click(opener);
  const dialog = document.querySelector<HTMLDialogElement>('dialog.account-dialog');
  expect(dialog?.open).toBe(true);
  expect(dialog?.contains(document.activeElement)).toBe(true);
  if (dismissal === 'escape') await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  else if (dismissal === 'cancel event') await act(async () => dialog?.dispatchEvent(new Event('cancel', { cancelable: true })));
  else if (dismissal === 'native close') await act(async () => dialog?.close());
  else await click(button(dismissal));
  expect(document.querySelector('.account-dialog')).toBeNull();
  expect(document.activeElement).toBe(opener);
  await click(opener);
  expect(document.querySelector<HTMLDialogElement>('dialog.account-dialog')?.open).toBe(true);
});
