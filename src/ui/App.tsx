import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

type User = { id: string; name: string; email: string };
type Role = 'owner' | 'editor' | 'viewer';
type Project = { id: string; name: string; role: Role };
type Member = User & { role: Role };
type Task = { id: string; projectId: string; title: string; description: string; status: string; priority: string; assigneeId: string | null; dueDate: string | null };
type Comment = { id: string; body: string; authorId: string; createdAt: string };
type Event = { id: string; action: string; actorId: string; actorName: string; createdAt: string; taskId: string | null; taskTitle: string | null };

class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

// A completed request may belong to an account or project that is no longer open.
let accountGeneration = 0;
let projectGeneration = 0;
function isAborted(value: unknown): boolean { return value instanceof DOMException && value.name === 'AbortError'; }

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const account = accountGeneration; const project = projectGeneration;
  const projectScoped = /^\/api\/projects\/[^/?]+/.test(path);
  const checkCurrent = () => {
    if (options.signal?.aborted || account !== accountGeneration || (projectScoped && project !== projectGeneration)) throw new DOMException('Request is no longer current', 'AbortError');
  };
  let response: Response;
  try {
    response = await fetch(path, { ...options, credentials: 'same-origin', headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers,
    } });
  } catch (error) { checkCurrent(); if (isAborted(error)) throw error; throw new ApiError('Could not reach TaskForge. Check your connection and try again.', 0); }
  checkCurrent();
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({})) as { error?: string; code?: string };
  checkCurrent();
  if (!response.ok) {
    if (response.status === 401 && payload.code === 'SESSION_EXPIRED') window.dispatchEvent(new window.Event('taskforge:session-expired'));
    throw new ApiError(payload.error || 'The request failed.', response.status);
  }
  return payload as T;
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [tab, setTab] = useState<'tasks' | 'members' | 'activity'>('tasks');
  const [task, setTask] = useState<Task | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [inviteToken, setInviteToken] = useState(() => new URLSearchParams(location.search).get('invite') ?? '');
  const [accountOpen, setAccountOpen] = useState(false);
  const [projectLoading, setProjectLoading] = useState(false);
  const projectRequest = useRef(0);
  const accountAtRender = accountGeneration; const projectAtRender = projectGeneration;
  const projectIsCurrent = useCallback(() => accountAtRender === accountGeneration && projectAtRender === projectGeneration, [accountAtRender, projectAtRender]);
  const updateMembers = useCallback((next: Member[]) => { if (projectIsCurrent()) setMembers(next); }, [projectIsCurrent]);
  const updateEvents = useCallback((next: Event[]) => { if (projectIsCurrent()) setEvents(next); }, [projectIsCurrent]);

  const showError = useCallback((value: unknown) => {
    if (isAborted(value)) return;
    const message = value instanceof Error ? value.message : 'Something went wrong. Try again.';
    setError(message);
  }, []);
  const clearProjectState = useCallback(() => {
    projectGeneration++; projectRequest.current++;
    setProject(null); setTask(null); setMembers([]); setEvents([]);
    setTab('tasks'); setProjectLoading(false); setError(''); setNotice('');
  }, []);
  const clearPrivateState = useCallback((expired = false) => {
    accountGeneration++; clearProjectState();
    setUser(null); setProjects([]); setAccountOpen(false); setBusy(false); setSessionExpired(expired);
  }, [clearProjectState]);
  const loadProjects = useCallback(async (signal?: AbortSignal) => {
    const account = accountGeneration;
    const result = await api<{ projects: Project[] }>('/api/projects', { signal });
    if (account === accountGeneration) setProjects(result.projects);
  }, []);

  useEffect(() => {
    const expireSession = () => {
      clearPrivateState(true);
    };
    window.addEventListener('taskforge:session-expired', expireSession);
    return () => window.removeEventListener('taskforge:session-expired', expireSession);
  }, [clearPrivateState]);

  useEffect(() => {
    const controller = new AbortController();
    api<{ user: User }>('/api/auth/me', { signal: controller.signal })
      .then(({ user: current }) => { setUser(current); return loadProjects(controller.signal); })
      .catch(value => { if (!(value instanceof DOMException && value.name === 'AbortError')) {
        if (value instanceof ApiError && value.status === 401) setSessionExpired(false);
        else setError(value instanceof Error ? value.message : 'Could not load your account.');
      } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [loadProjects]);

  const openProject = async (next: Project) => {
    clearProjectState();
    const request = projectRequest.current;
    setProjectLoading(true);
    try {
      const detail = await api<{ project: Project; members: Member[] }>(`/api/projects/${next.id}`);
      if (request !== projectRequest.current) return;
      setProject(detail.project);
      setMembers(detail.members);
    } catch (value) { if (request === projectRequest.current) showError(value); }
    finally { if (request === projectRequest.current) setProjectLoading(false); }
  };

  const acceptInvite = async (event: FormEvent) => {
    const account = accountGeneration;
    event.preventDefault();
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api<{ project: Project }>('/api/invitations/accept', { method: 'POST', body: JSON.stringify({ token: inviteToken.trim() }) });
      if (account !== accountGeneration) return;
      setInviteToken(''); history.replaceState(null, '', location.pathname);
      await loadProjects();
      if (account !== accountGeneration) return;
      await openProject(result.project);
      if (account === accountGeneration) setNotice('Invitation accepted. This project is now available to you.');
    } catch (value) { showError(value); }
    finally { if (account === accountGeneration) setBusy(false); }
  };

  const logout = async () => {
    const account = accountGeneration;
    setBusy(true);
    try { await api('/api/auth/logout', { method: 'POST' }); if (account === accountGeneration) clearPrivateState(); }
    catch (value) { showError(value); }
    finally { if (account === accountGeneration) setBusy(false); }
  };

  if (loading) return <main className="center-state" aria-live="polite"><span className="spinner" />Loading TaskForge…</main>;
  if (!user) return <AuthScreen onUser={next => { clearPrivateState(); setUser(next); loadProjects().catch(showError); }} expired={sessionExpired} error={error} inviteToken={inviteToken} onInviteToken={setInviteToken} onAccept={acceptInvite} busy={busy} />;

  return <div className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={clearProjectState} aria-label="TaskForge home"><span className="brand-mark">T</span><span>TaskForge</span></button>
      <div className="account"><span className="avatar" aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span><span className="account-name">{user.name}</span><button className="button subtle small" onClick={() => setAccountOpen(true)}>Account</button><button className="button subtle small" onClick={logout} disabled={busy}>Sign out</button></div>
    </header>
    <main className="workspace">
      <aside className="sidebar">
        <div className="sidebar-heading"><span>Your projects</span><button className="icon-button" aria-label="Create project" onClick={() => document.getElementById('new-project-name')?.focus()}>＋</button></div>
        <nav aria-label="Projects" className="project-nav">
          {projects.map(item => <button key={item.id} className={`project-nav-item ${project?.id === item.id ? 'selected' : ''}`} onClick={() => void openProject(item)}><span className="project-dot" />{item.name}</button>)}
          {projects.length === 0 && <p className="muted sidebar-empty">No projects yet</p>}
        </nav>
        <ProjectCreate onCreated={async created => { if (accountAtRender !== accountGeneration) return; await loadProjects(); if (accountAtRender === accountGeneration) await openProject(created); }} onError={showError} />
      </aside>
      <section className="main-panel">
        {error && <div className="alert error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
        {notice && <div className="alert success" role="status"><span>{notice}</span><button aria-label="Dismiss message" onClick={() => setNotice('')}>×</button></div>}
        {inviteToken && <form className="accept-banner" onSubmit={acceptInvite}><div><strong>Invitation ready to accept</strong><span>Signed in as {user.email}. The address must match the invitation.</span></div><label className="sr-only" htmlFor="signed-in-invite-token">Invitation token</label><input id="signed-in-invite-token" value={inviteToken} onChange={event => setInviteToken(event.target.value)} required /><button className="button primary small" disabled={busy}>{busy ? 'Accepting…' : 'Accept invitation'}</button><button type="button" className="icon-button" aria-label="Dismiss invitation" onClick={() => setInviteToken('')}>×</button></form>}
        {projectLoading ? <div className="table-state" role="status">Loading project…</div> : !project ? <ProjectHome projects={projects} onOpen={openProject} /> : task
          ? <TaskDetail key={task.id} task={task} project={project} members={members} currentUserId={user.id} onBack={() => setTask(null)} onChanged={next => { if (projectIsCurrent()) setTask(current => current?.id === next.id ? next : current); }} onDeleted={() => { if (projectIsCurrent()) setTask(current => current?.id === task.id ? null : current); }} onError={showError} />
          : <ProjectView key={project.id} project={project} members={members} tab={tab} onTab={setTab} onTask={next => { if (projectIsCurrent()) setTask(current => current ?? next); }} onProject={next => { if (projectIsCurrent()) { setProject(next); setProjects(previous => previous.map(item => item.id === next.id ? next : item)); } }} onMembers={updateMembers} onEvents={updateEvents} events={events} onError={showError} onDeleted={async () => { if (!projectIsCurrent()) return; clearProjectState(); await loadProjects(); }} />}
      </section>
    </main>
    {accountOpen && <AccountPanel user={user} onClose={() => setAccountOpen(false)} onPasswordChanged={() => { if (accountAtRender === accountGeneration) clearPrivateState(true); }} />}
  </div>;
}

function AuthScreen({ onUser, expired, error: initialError, inviteToken, onInviteToken, onAccept, busy }: {
  onUser: (user: User) => void; expired: boolean; error: string; inviteToken: string; onInviteToken: (value: string) => void; onAccept: (event: FormEvent) => void; busy: boolean;
}) {
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState(''); const [name, setName] = useState(''); const [password, setPassword] = useState('');
  const [error, setError] = useState(''); const [submitting, setSubmitting] = useState(false);
  const submit = async (event: FormEvent) => {
    const account = accountGeneration;
    event.preventDefault(); setSubmitting(true); setError('');
    try {
      const result = await api<{ user: User }>(`/api/auth/${register ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify(register ? { name, email, password } : { email, password }) });
      if (account === accountGeneration) onUser(result.user);
    } catch (value) { if (!isAborted(value)) setError(value instanceof Error ? value.message : 'Unable to sign in.'); }
    finally { setSubmitting(false); }
  };
  return <main className="auth-page">
    <section className="auth-card" aria-labelledby="auth-title">
      <div className="auth-brand"><span className="brand-mark">T</span><span>TaskForge</span></div>
      <p className="eyebrow">A calmer way to work together</p>
      <h1 id="auth-title">{register ? 'Create your account' : 'Welcome back'}</h1>
      <p className="muted">{register ? 'Start a workspace and invite your team.' : 'Sign in to pick up where your team left off.'}</p>
      {(expired || initialError) && <div role="alert" className="alert error">{expired ? 'Your session has expired. Sign in again to continue.' : initialError}</div>}
      {error && <div role="alert" className="alert error">{error}</div>}
      <form onSubmit={submit} className="stack-form">
        {register && <label>Your name<input autoComplete="name" value={name} onChange={e => setName(e.target.value)} maxLength={80} required /></label>}
        <label>Email address<input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} maxLength={254} required /></label>
        <label>Password<input type="password" autoComplete={register ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} minLength={register ? 12 : 1} maxLength={128} required /><span className="field-hint">{register ? 'Use 12–128 characters.' : ' '}</span></label>
        <button className="button primary full" disabled={submitting}>{submitting ? 'Please wait…' : register ? 'Create account' : 'Sign in'}</button>
      </form>
      <p className="switch-auth">{register ? 'Already have an account?' : 'New to TaskForge?'} <button className="text-button" onClick={() => { setRegister(!register); setError(''); }}> {register ? 'Sign in' : 'Create account'}</button></p>
      {inviteToken && <form className="invite-accept" onSubmit={onAccept}>
        <div><strong>You have a project invitation</strong><p className="muted">Sign in using the email address that received the invitation.</p></div>
        <label>Invitation token<input aria-label="Invitation token" value={inviteToken} onChange={e => onInviteToken(e.target.value)} required /></label>
        <button className="button secondary full" disabled={busy || !inviteToken.trim()}>{busy ? 'Accepting…' : 'Accept invitation'}</button>
      </form>}
    </section>
    <div className="auth-aside"><div className="aside-content"><span className="eyebrow light">Work, in good company</span><h2>Keep the whole project moving.</h2><p>Share tasks, leave useful context, and see what changed without losing the thread.</p><div className="aside-card"><div className="aside-card-top"><span className="project-dot" />Product launch <span className="pill">In progress</span></div><div className="mock-task">Prepare launch checklist<span>Today · Alex M.</span></div><div className="mock-task">Review customer notes<span>Tomorrow · You</span></div></div></div><span className="aside-foot">Simple project workspaces for real teams.</span></div>
  </main>;
}

function ProjectCreate({ onCreated, onError }: { onCreated: (project: Project) => Promise<void>; onError: (error: unknown) => void }) {
  const [name, setName] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true);
    try { const result = await api<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify({ name }) }); setName(''); await onCreated(result.project); }
    catch (value) { onError(value); } finally { setBusy(false); }
  };
  return <form className="new-project" onSubmit={submit}><label htmlFor="new-project-name">Create a project</label><div className="inline-input"><input id="new-project-name" value={name} onChange={e => setName(e.target.value)} placeholder="Project name" maxLength={100} required /><button className="button primary small" disabled={busy || !name.trim()}>{busy ? '…' : 'Add'}</button></div></form>;
}

function ProjectHome({ projects, onOpen }: { projects: Project[]; onOpen: (project: Project) => void }) {
  return <div className="home-content"><p className="eyebrow">Your workspace</p><h1>Good work starts with a clear next step.</h1><p className="lead">Choose a project or create one to bring your team’s work together.</p>
    {projects.length ? <div className="project-cards">{projects.map(item => <button key={item.id} className="project-card" onClick={() => void onOpen(item)}><span className="project-card-icon">{item.name.slice(0, 1).toUpperCase()}</span><span className="project-card-copy"><strong>{item.name}</strong><span>{item.role === 'owner' ? 'You own this project' : `You’re a ${item.role}`}</span></span><span aria-hidden="true" className="card-arrow">↗</span></button>)}</div> : <div className="empty-state"><div className="empty-icon">✳</div><h2>Your projects live here</h2><p>Create a project from the left panel, then invite your teammates.</p></div>}
  </div>;
}

function ProjectView({ project, members, tab, onTab, onTask, onProject, onMembers, onEvents, events, onError, onDeleted }: {
  project: Project; members: Member[]; tab: 'tasks' | 'members' | 'activity'; onTab: (tab: 'tasks' | 'members' | 'activity') => void; onTask: (task: Task) => void; onProject: (project: Project) => void; onMembers: (members: Member[]) => void; onEvents: (events: Event[]) => void; events: Event[]; onError: (error: unknown) => void; onDeleted: () => Promise<void>;
}) {
  const [tasks, setTasks] = useState<Task[]>([]); const [total, setTotal] = useState(0); const [page, setPage] = useState(1); const [pageSize] = useState(20);
  const [status, setStatus] = useState(''); const [priority, setPriority] = useState(''); const [assigneeId, setAssigneeId] = useState(''); const [q, setQ] = useState(''); const [search, setSearch] = useState('');
  const [taskLoading, setTaskLoading] = useState(false); const [taskError, setTaskError] = useState(''); const [newTaskOpen, setNewTaskOpen] = useState(false); const [newTaskTitle, setNewTaskTitle] = useState(''); const [newTaskBusy, setNewTaskBusy] = useState(false);
  const [inviteEmail, setInviteEmail] = useState(''); const [inviteRole, setInviteRole] = useState<'editor' | 'viewer'>('editor'); const [invitation, setInvitation] = useState<{ token: string; link: string; email: string } | null>(null); const [inviteBusy, setInviteBusy] = useState(false);
  const [rename, setRename] = useState(false); const [projectName, setProjectName] = useState(project.name); const [renameBusy, setRenameBusy] = useState(false);
  const [sectionLoading, setSectionLoading] = useState(false);
  const canEdit = project.role !== 'viewer'; const owner = project.role === 'owner';
  const filters = useMemo(() => { const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) }); if (status) params.set('status', status); if (priority) params.set('priority', priority); if (assigneeId) params.set('assigneeId', assigneeId); if (search) params.set('q', search); return params.toString(); }, [page, pageSize, status, priority, assigneeId, search]);
  useEffect(() => {
    const controller = new AbortController(); setTaskLoading(true); setTaskError('');
    api<{ tasks: Task[]; total: number }>(`/api/projects/${project.id}/tasks?${filters}`, { signal: controller.signal })
      .then(result => { setTasks(result.tasks); setTotal(result.total); })
      .catch(value => { if (!(value instanceof DOMException && value.name === 'AbortError')) setTaskError(value instanceof Error ? value.message : 'Could not load tasks.'); })
      .finally(() => { if (!controller.signal.aborted) setTaskLoading(false); });
    return () => controller.abort();
  }, [filters, project.id]);
  useEffect(() => {
    const controller = new AbortController();
    setSectionLoading(tab !== 'tasks');
    if (tab === 'members') {
      onMembers([]);
      api<{ members: Member[] }>(`/api/projects/${project.id}`, { signal: controller.signal }).then(result => onMembers(result.members)).catch(value => { if (!isAborted(value)) onError(value); }).finally(() => { if (!controller.signal.aborted) setSectionLoading(false); });
    }
    if (tab === 'activity') {
      onEvents([]);
      api<{ events: Event[] }>(`/api/projects/${project.id}/activity`, { signal: controller.signal }).then(result => onEvents(result.events)).catch(value => { if (!isAborted(value)) onError(value); }).finally(() => { if (!controller.signal.aborted) setSectionLoading(false); });
    }
    return () => controller.abort();
  }, [tab, project.id, onMembers, onEvents, onError]);
  const createTask = async (event: FormEvent) => {
    event.preventDefault(); setNewTaskBusy(true);
    try { const result = await api<{ task: Task }>(`/api/projects/${project.id}/tasks`, { method: 'POST', body: JSON.stringify({ title: newTaskTitle }) }); setNewTaskTitle(''); setNewTaskOpen(false); onTask(result.task); }
    catch (value) { onError(value); } finally { setNewTaskBusy(false); }
  };
  const saveRename = async (event: FormEvent) => { event.preventDefault(); setRenameBusy(true);
    try { const result = await api<{ project: Project }>(`/api/projects/${project.id}`, { method: 'PATCH', body: JSON.stringify({ name: projectName }) }); onProject(result.project); setRename(false); }
    catch (value) { onError(value); } finally { setRenameBusy(false); }
  };
  const deleteProject = async () => { if (!confirm(`Delete “${project.name}” and all its tasks? This cannot be undone.`)) return;
    try { await api(`/api/projects/${project.id}`, { method: 'DELETE' }); await onDeleted(); } catch (value) { onError(value); }
  };
  const sendInvite = async (event: FormEvent) => { event.preventDefault(); setInviteBusy(true);
    try { const result = await api<{ invite: { token: string; link: string; email: string } }>(`/api/projects/${project.id}/invitations`, { method: 'POST', body: JSON.stringify({ email: inviteEmail, role: inviteRole }) }); setInvitation(result.invite); setInviteEmail(''); }
    catch (value) { onError(value); } finally { setInviteBusy(false); }
  };
  const copyInvite = async (value: string) => { try { await navigator.clipboard.writeText(value); } catch { onError(new Error('Clipboard access is unavailable. Select and copy the invitation link.')); } };
  const updateMember = async (member: Member, role: Role | null) => {
    try {
      if (role === null) { if (!confirm(`Remove ${member.name} from this project? Their assigned tasks will be unassigned.`)) return; await api(`/api/projects/${project.id}/members/${member.id}`, { method: 'DELETE' }); }
      else await api(`/api/projects/${project.id}/members/${member.id}`, { method: 'PATCH', body: JSON.stringify({ role }) });
      const result = await api<{ members: Member[] }>(`/api/projects/${project.id}`); onMembers(result.members);
    } catch (value) { onError(value); }
  };
  const searchForm = (event: FormEvent) => { event.preventDefault(); setPage(1); setSearch(q.trim()); };

  return <div className="project-content">
    <div className="breadcrumbs"><span>Workspace</span><span aria-hidden="true">/</span><strong>{project.name}</strong></div>
    <div className="project-heading">
      <div className="project-title-wrap"><span className="project-large-icon">{project.name.slice(0, 1).toUpperCase()}</span><div>{rename ? <form className="rename-form" onSubmit={saveRename}><label className="sr-only" htmlFor="rename-project">Project name</label><input id="rename-project" value={projectName} onChange={e => setProjectName(e.target.value)} maxLength={100} required autoFocus /><button className="button primary small" disabled={renameBusy}>Save</button><button type="button" className="button subtle small" onClick={() => setRename(false)}>Cancel</button></form> : <><div className="heading-line"><h1>{project.name}</h1>{owner && <span className="role-badge owner">Owner</span>}</div><p>{members.length} {members.length === 1 ? 'member' : 'members'} <span className="dot-sep">·</span> {project.role === 'owner' ? 'You own this project' : `${project.role} access`}</p></>}</div></div>
      {owner && <div className="heading-actions"><button className="button subtle" onClick={() => { setProjectName(project.name); setRename(true); }}>Rename</button><button className="button danger-quiet" onClick={() => void deleteProject()}>Delete project</button></div>}
    </div>
    <div className="tab-row" role="tablist" aria-label="Project sections">{(['tasks', 'members', 'activity'] as const).map(value => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => onTab(value)}>{value === 'tasks' ? 'Tasks' : value === 'members' ? 'People' : 'Activity'}</button>)}</div>
    {tab === 'tasks' && <section className="tasks-section" aria-label="Project tasks">
      <div className="section-heading"><div><h2>Tasks <span className="count-badge">{total}</span></h2><p className="muted">Keep the next steps visible.</p></div>{canEdit && <button className="button primary" onClick={() => setNewTaskOpen(!newTaskOpen)}>＋ New task</button>}</div>
      {newTaskOpen && <form className="new-task-form" onSubmit={createTask}><label htmlFor="new-task-title">Task title</label><div><input id="new-task-title" autoFocus value={newTaskTitle} onChange={event => setNewTaskTitle(event.target.value)} maxLength={200} placeholder="What needs to get done?" required /><button className="button primary" disabled={newTaskBusy || !newTaskTitle.trim()}>{newTaskBusy ? 'Creating…' : 'Create task'}</button><button type="button" className="button subtle" onClick={() => { setNewTaskOpen(false); setNewTaskTitle(''); }}>Cancel</button></div></form>}
      <div className="filter-bar"><form onSubmit={searchForm} className="search-box"><span aria-hidden="true">⌕</span><label className="sr-only" htmlFor="task-search">Search tasks</label><input id="task-search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search tasks" /><button className="button subtle small">Search</button></form>
        <label><span className="sr-only">Filter by status</span><select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}><option value="">All statuses</option><option value="todo">To do</option><option value="in_progress">In progress</option><option value="done">Done</option></select></label>
        <label><span className="sr-only">Filter by priority</span><select value={priority} onChange={e => { setPriority(e.target.value); setPage(1); }}><option value="">All priorities</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
        <label><span className="sr-only">Filter by assignee</span><select value={assigneeId} onChange={e => { setAssigneeId(e.target.value); setPage(1); }}><option value="">All assignees</option>{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
      </div>
      {taskError && <div className="alert error" role="alert">{taskError}</div>}
      <div className="task-table-wrap"><table className="task-table"><thead><tr><th>Task</th><th>Status</th><th>Priority</th><th>Assignee</th><th>Due date</th></tr></thead><tbody>
        {tasks.map(item => <tr key={item.id} onClick={() => onTask(item)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onTask(item); } }}><td><strong>{item.title}</strong>{item.description && <span className="task-description">{item.description}</span>}</td><td><span className={`status-pill ${item.status}`}>{item.status.replace('_', ' ')}</span></td><td><span className={`priority ${item.priority}`}><i />{item.priority}</span></td><td>{members.find(member => member.id === item.assigneeId)?.name ?? <span className="muted">Unassigned</span>}</td><td>{item.dueDate ? new Date(`${item.dueDate}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : <span className="muted">—</span>}</td></tr>)}
      </tbody></table>{taskLoading && <div className="table-state"><span className="spinner" />Loading tasks…</div>}{!taskLoading && !tasks.length && <div className="table-state"><div className="empty-icon">✓</div><strong>{search || status || priority || assigneeId ? 'No matching tasks' : 'No tasks yet'}</strong><span>{canEdit ? 'Add a task to give your team a clear next step.' : 'Tasks added to this project will appear here.'}</span>{canEdit && !search && <button className="button secondary small" onClick={() => setNewTaskOpen(true)}>Create the first task</button>}</div>}</div>
      {total > pageSize && <div className="pagination"><span>Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}</span><div><button className="button subtle small" onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1}>Previous</button><span>Page {page} of {Math.ceil(total / pageSize)}</span><button className="button subtle small" onClick={() => setPage(page + 1)} disabled={page >= Math.ceil(total / pageSize)}>Next</button></div></div>}
    </section>}
    {tab === 'members' && <section className="people-section"><div className="section-heading"><div><h2>People</h2><p className="muted">Everyone with access to {project.name}.</p></div></div>
      {sectionLoading && <div className="table-state" role="status">Loading people…</div>}<div className="members-list">{members.map(member => <div className="member-row" key={member.id}><span className="avatar">{member.name.slice(0, 1).toUpperCase()}</span><span className="member-info"><strong>{member.name}</strong><span>{member.email}</span></span><span className={`role-badge ${member.role}`}>{member.role}</span>{owner && member.role !== 'owner' && <div className="member-actions"><label className="sr-only" htmlFor={`role-${member.id}`}>Role for {member.name}</label><select id={`role-${member.id}`} value={member.role} onChange={e => void updateMember(member, e.target.value as Role)}><option value="editor">Editor</option><option value="viewer">Viewer</option></select><button className="icon-button remove" aria-label={`Remove ${member.name}`} onClick={() => void updateMember(member, null)}>×</button></div>}</div>)}</div>
      {owner && <div className="invite-card"><div><h3>Invite someone</h3><p className="muted">They’ll need to sign in with the email you invite.</p></div><form className="invite-form" onSubmit={sendInvite}><label className="sr-only" htmlFor="invite-email">Email address</label><input id="invite-email" type="email" placeholder="name@company.com" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} required /><label className="sr-only" htmlFor="invite-role">Project role</label><select id="invite-role" value={inviteRole} onChange={e => setInviteRole(e.target.value as 'editor' | 'viewer')}><option value="editor">Editor</option><option value="viewer">Viewer</option></select><button className="button primary" disabled={inviteBusy}>{inviteBusy ? 'Creating…' : 'Create invite'}</button></form>
        {invitation && <div className="invite-result" role="status"><div><strong>Invitation ready for {invitation.email}</strong><span>Share this one-time link with them.</span></div><input aria-label="Invitation link" readOnly value={invitation.link} onFocus={e => e.currentTarget.select()} /><button className="button secondary small" onClick={() => void copyInvite(invitation.link)}>Copy link</button><details><summary>Show invitation token</summary><code>{invitation.token}</code><button className="text-button" onClick={() => void copyInvite(invitation.token)}>Copy token</button></details></div>}
      </div>}
    </section>}
    {tab === 'activity' && <section className="activity-section"><div className="section-heading"><div><h2>Activity</h2><p className="muted">A timeline of recent project changes.</p></div></div>{sectionLoading ? <div className="table-state" role="status">Loading activity…</div> : events.length ? <ol className="timeline">{events.map(event => <li key={event.id}><span className="timeline-mark" /><div><p><strong>{event.actorName}</strong> {event.action.replaceAll('_', ' ')}{event.taskTitle && <> · <strong>{event.taskTitle}</strong></>}</p><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time></div></li>)}</ol> : <div className="empty-state compact"><div className="empty-icon">◷</div><h3>No activity yet</h3><p>Task and comment updates will show up here.</p></div>}</section>}
  </div>;
}

function TaskDetail({ task: initial, project, members, currentUserId, onBack, onChanged, onDeleted, onError }: {
  task: Task; project: Project; members: Member[]; currentUserId: string; onBack: () => void; onChanged: (task: Task) => void; onDeleted: () => void; onError: (error: unknown) => void;
}) {
  const [task, setTask] = useState(initial); const [comments, setComments] = useState<Comment[]>([]); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [comment, setComment] = useState(''); const [commentBusy, setCommentBusy] = useState(false); const [localError, setLocalError] = useState('');
  const [title, setTitle] = useState(initial.title); const [description, setDescription] = useState(initial.description); const [status, setStatus] = useState(initial.status); const [priority, setPriority] = useState(initial.priority); const [assigneeId, setAssigneeId] = useState(initial.assigneeId ?? ''); const [dueDate, setDueDate] = useState(initial.dueDate ?? '');
  const draft = { title: title.trim(), description: description.trim(), status, priority, assigneeId: assigneeId || null, dueDate: dueDate || null };
  const changes = Object.fromEntries(Object.entries(draft).filter(([key, value]) => value !== task[key as keyof typeof draft]));
  const hasChanges = Object.keys(changes).length > 0;
  const editable = project.role !== 'viewer'; const owner = project.role === 'owner';
  useEffect(() => {
    const controller = new AbortController(); setLoading(true);
    api<{ comments: Comment[] }>(`/api/projects/${project.id}/tasks/${initial.id}/comments`, { signal: controller.signal })
      .then(result => setComments(result.comments)).catch(value => { if (!(value instanceof DOMException && value.name === 'AbortError')) setLocalError(value instanceof Error ? value.message : 'Could not load comments.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [project.id, initial.id]);
  const save = async (event: FormEvent) => { event.preventDefault(); if (!hasChanges || saving) return; setSaving(true); setLocalError('');
    try {
      const result = await api<{ task: Task }>(`/api/projects/${project.id}/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify(changes) });
      setTask(result.task);
      // Adopt the current server baseline without discarding edits typed while saving.
      setTitle(current => current === title ? result.task.title : current);
      setDescription(current => current === description ? result.task.description : current);
      setStatus(current => current === status ? result.task.status : current);
      setPriority(current => current === priority ? result.task.priority : current);
      setAssigneeId(current => current === assigneeId ? result.task.assigneeId ?? '' : current);
      setDueDate(current => current === dueDate ? result.task.dueDate ?? '' : current);
      onChanged(result.task);
    }
    catch (value) { setLocalError(value instanceof Error ? value.message : 'Could not save task.'); } finally { setSaving(false); }
  };
  const removeTask = async () => { if (!confirm(`Delete “${task.title}” and its comments? This cannot be undone.`)) return;
    try { await api(`/api/projects/${project.id}/tasks/${task.id}`, { method: 'DELETE' }); onDeleted(); } catch (value) { onError(value); }
  };
  const addComment = async (event: FormEvent) => { event.preventDefault(); setCommentBusy(true);
    try { const result = await api<{ comment: Comment }>(`/api/projects/${project.id}/tasks/${task.id}/comments`, { method: 'POST', body: JSON.stringify({ body: comment }) }); setComments(current => [...current, result.comment]); setComment(''); }
    catch (value) { setLocalError(value instanceof Error ? value.message : 'Could not add comment.'); } finally { setCommentBusy(false); }
  };
  const deleteComment = async (item: Comment) => { if (!confirm('Delete this comment?')) return;
    try { await api(`/api/projects/${project.id}/tasks/${task.id}/comments/${item.id}`, { method: 'DELETE' }); setComments(current => current.filter(value => value.id !== item.id)); }
    catch (value) { onError(value); }
  };

  return <div className="task-detail-page"><div className="breadcrumbs"><button className="text-button" onClick={onBack}>{project.name}</button><span aria-hidden="true">/</span><strong>Task details</strong></div>
    {localError && <div className="alert error" role="alert">{localError}<button onClick={() => setLocalError('')} aria-label="Dismiss error">×</button></div>}
    <div className="task-detail-grid"><section className="task-editor-card"><div className="detail-top"><div><p className="eyebrow">Task</p><h1>{task.title}</h1></div><button className="button subtle" onClick={onBack}>Back to tasks</button></div>
      {editable ? <form onSubmit={save} className="task-edit-form"><label>Title<input value={title} onChange={e => setTitle(e.target.value)} maxLength={200} required /></label><label>Description<textarea value={description} onChange={e => setDescription(e.target.value)} maxLength={10000} rows={5} placeholder="Add context, links, or what done looks like…" /></label>
        <div className="form-grid"><label>Status<select value={status} onChange={e => setStatus(e.target.value)}><option value="todo">To do</option><option value="in_progress">In progress</option><option value="done">Done</option></select></label><label>Priority<select value={priority} onChange={e => setPriority(e.target.value)}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label><label>Assignee<select value={assigneeId} onChange={e => setAssigneeId(e.target.value)}><option value="">Unassigned</option>{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label><label>Due date<input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} /></label></div>
        <div className="form-actions"><button className="button primary" disabled={saving || !hasChanges || !title.trim()}>{saving ? 'Saving…' : 'Save changes'}</button><button type="button" className="button danger-quiet" onClick={() => void removeTask()}>Delete task</button></div>
      </form> : <div className="read-only-task"><p>{task.description || 'No description has been added.'}</p><div className="read-only-fields"><span className={`status-pill ${task.status}`}>{task.status.replace('_', ' ')}</span><span className={`priority ${task.priority}`}><i />{task.priority} priority</span><span>Assigned to {members.find(member => member.id === task.assigneeId)?.name ?? 'no one'}</span><span>Due {task.dueDate ?? 'date not set'}</span></div></div>}
    </section>
    <aside className="comments-card"><div className="comments-head"><div><h2>Comments</h2><p className="muted">Keep the useful details in one place.</p></div><span className="count-badge">{comments.length}</span></div>
      {loading ? <div className="table-state"><span className="spinner" />Loading comments…</div> : comments.length ? <ol className="comment-list">{comments.map(item => <li key={item.id}><span className="avatar small-avatar">{members.find(member => member.id === item.authorId)?.name.slice(0, 1).toUpperCase() ?? '?'}</span><div className="comment-copy"><div className="comment-meta"><strong>{members.find(member => member.id === item.authorId)?.name ?? 'Team member'}</strong><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleDateString()}</time></div><p>{item.body}</p></div>{editable && (owner || item.authorId === currentUserId) && <button className="icon-button" aria-label="Delete comment" onClick={() => void deleteComment(item)}>×</button>}</li>)}</ol> : <div className="empty-state compact"><div className="empty-icon">☷</div><h3>No comments yet</h3><p>Add a note or ask a question to keep everyone aligned.</p></div>}
      {editable && <form className="comment-form" onSubmit={addComment}><label htmlFor="new-comment">Add a comment</label><textarea id="new-comment" value={comment} onChange={e => setComment(e.target.value)} maxLength={2000} rows={3} placeholder="Write a helpful update…" required /><div><span>{comment.length}/2000</span><button className="button primary small" disabled={commentBusy || !comment.trim()}>{commentBusy ? 'Posting…' : 'Post comment'}</button></div></form>}
    </aside></div>
  </div>;
}

function AccountPanel({ user, onClose, onPasswordChanged }: { user: User; onClose: () => void; onPasswordChanged: () => void }) {
  const [currentPassword, setCurrentPassword] = useState(''); const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cleaningUp = useRef(false);
  useEffect(() => {
    const dialog = dialogRef.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cleaningUp.current = false;
    dialog.showModal();
    dialog.querySelector<HTMLInputElement>('input')?.focus();
    return () => { cleaningUp.current = true; dialog.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }); onPasswordChanged(); }
    catch (value) { setError(value instanceof Error ? value.message : 'Could not update your password.'); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialogRef} className="account-dialog" aria-labelledby="account-title"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClose={event => { if (!cleaningUp.current && !event.currentTarget.open) onClose(); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } }}>
      <div className="dialog-heading"><div><p className="eyebrow">Account settings</p><h2 id="account-title">Your account</h2></div><button className="icon-button" onClick={onClose} aria-label="Close account settings">×</button></div>
      <div className="account-profile"><span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span><div><strong>{user.name}</strong><span>{user.email}</span></div></div>
      {error && <div className="alert error" role="alert">{error}</div>}
      <form className="stack-form" onSubmit={submit}><h3>Change password</h3><p className="muted">Changing your password signs out every active session.</p><label>Current password<input type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} required /></label><label>New password<input type="password" autoComplete="new-password" minLength={12} maxLength={128} value={newPassword} onChange={event => setNewPassword(event.target.value)} required /><span className="field-hint">Use 12–128 characters.</span></label><div className="dialog-actions"><button type="button" className="button subtle" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? 'Updating…' : 'Update password'}</button></div></form>
  </dialog>;
}

export { App };
