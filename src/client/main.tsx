import {
  StrictMode,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { api, go, useAction, useResource } from "./api";
import type { Activity, Comment, Member, Project, Task, User } from "../shared";
import "./style.css";

const label = (value: string) => value.replaceAll("_", " ");
const dateTime = (value: string) => new Date(value).toLocaleString();
function ErrorMessage({ children }: { children?: ReactNode }) {
  return children ? (
    <p className="error" role="alert">
      {children}
    </p>
  ) : null;
}
function State({
  loading,
  error,
  reload,
}: {
  loading: boolean;
  error?: string;
  reload: () => void;
}) {
  return loading ? (
    <p className="muted" role="status">
      Loading…
    </p>
  ) : error ? (
    <div>
      <ErrorMessage>{error}</ErrorMessage>
      <button onClick={reload}>Try again</button>
    </div>
  ) : null;
}
function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
function Field({ title, children }: { title: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{title}</span>
      {children}
    </label>
  );
}
function Submit({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <button className="primary" type="submit" disabled={busy}>
      {busy ? "Working…" : children}
    </button>
  );
}
function submit(event: FormEvent, action: () => void) {
  event.preventDefault();
  action();
}

function Auth({
  onUser,
  notice,
}: {
  onUser: (u: User) => void;
  notice: string;
}) {
  const [register, setRegister] = useState(false),
    action = useAction();
  const [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState("");
  return (
    <main className="auth-layout">
      <section className="intro">
        <div className="eyebrow">TASKFORGE / TEAM WORKSPACE</div>
        <h1>
          Good work
          <br />
          starts together.
        </h1>
        <p>
          A shared place for the tasks, conversations and decisions that move
          your projects forward.
        </p>
        <div className="intro-foot">
          Plan clearly. Build together. Keep moving.
        </div>
      </section>
      <section className="auth-card">
        <div className="eyebrow">WELCOME TO TASKFORGE</div>
        <h2>{register ? "Create your account" : "Welcome back"}</h2>
        <p className="muted">
          {register
            ? "Set up your workspace in a moment."
            : "Sign in to pick up where you left off."}
        </p>
        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
        {location.hash.startsWith("#invite") && (
          <p className="notice">
            Sign in or register with the invited email to accept this
            invitation.
          </p>
        )}
        <form
          onSubmit={(e) =>
            submit(
              e,
              () =>
                void action.run(async () => {
                  const result = await api<{ user: User }>(
                    "/auth/" + (register ? "register" : "login"),
                    "POST",
                    { ...(register ? { name } : {}), email, password },
                  );
                  onUser(result.user);
                }),
            )
          }
        >
          <fieldset disabled={action.busy}>
            {register && (
              <Field title="Your name">
                <input
                  autoComplete="name"
                  required
                  maxLength={80}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
            )}
            <Field title="Email address">
              <input
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field title="Password">
              <input
                type="password"
                autoComplete={register ? "new-password" : "current-password"}
                required
                minLength={register ? 12 : 1}
                maxLength={128}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            {register && <small>Use 12–128 characters.</small>}
            <ErrorMessage>{action.error}</ErrorMessage>
            <Submit busy={action.busy}>
              {register ? "Create account" : "Sign in"}
            </Submit>
          </fieldset>
        </form>
        <button
          className="text-button"
          disabled={action.busy}
          onClick={() => {
            setRegister(!register);
            setPassword("");
          }}
        >
          {register
            ? "Already have an account? Sign in"
            : "New to TaskForge? Create an account"}
        </button>
      </section>
    </main>
  );
}
function Projects() {
  const result = useResource<{ projects: Project[] }>("/projects"),
    action = useAction(),
    [name, setName] = useState("");
  return (
    <>
      <header className="page-heading">
        <div>
          <div className="eyebrow">YOUR WORKSPACE</div>
          <h1>Projects</h1>
          <p className="muted">A little structure for your next big thing.</p>
        </div>
        <a className="button" href="#invite">
          Accept invitation
        </a>
      </header>
      <section className="panel">
        <h2>Create a project</h2>
        <form
          className="inline-form"
          onSubmit={(e) =>
            submit(
              e,
              () =>
                void action.run(async () => {
                  const { project } = await api<{ project: Project }>(
                    "/projects",
                    "POST",
                    { name },
                  );
                  go("projects/" + project.id);
                }),
            )
          }
        >
          <Field title="Project name">
            <input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Website launch"
              disabled={action.busy}
            />
          </Field>
          <Submit busy={action.busy}>Create project</Submit>
        </form>
        <ErrorMessage>{action.error}</ErrorMessage>
      </section>
      <State {...result} />
      {result.data && (
        <div className="project-grid">
          {result.data.projects.map((p) => (
            <a className="project-card" key={p.id} href={"#projects/" + p.id}>
              <span className="project-icon" aria-hidden="true">
                ↗
              </span>
              <span className="badge">{p.role}</span>
              <h2>{p.name}</h2>
              <span className="muted">Open workspace →</span>
            </a>
          ))}
          {!result.data.projects.length && (
            <Empty>
              No projects yet. Create your first one or accept an invitation.
            </Empty>
          )}
        </div>
      )}
    </>
  );
}
function Invite({ token }: { token?: string }) {
  const [value, setValue] = useState(token ?? ""),
    action = useAction();
  return (
    <section className="panel narrow">
      <div className="eyebrow">JOIN YOUR TEAM</div>
      <h1>Accept invitation</h1>
      <p className="muted">
        Paste a token or invitation link. You must be signed in with the email
        the owner invited. Links expire after 7 days.
      </p>
      <form
        onSubmit={(e) =>
          submit(
            e,
            () =>
              void action.run(async () => {
                const raw = value.trim();
                const inviteToken = raw.includes("#invite/")
                  ? raw.split("#invite/")[1]
                  : raw;
                const { project } = await api<{ project: Project }>(
                  "/invitations/accept",
                  "POST",
                  { token: inviteToken },
                );
                go("projects/" + project.id);
              }),
          )
        }
      >
        <Field title="Invitation token or link">
          <input
            required
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={action.busy}
          />
        </Field>
        <ErrorMessage>{action.error}</ErrorMessage>
        <Submit busy={action.busy}>Join project</Submit>
      </form>
    </section>
  );
}
function Account({
  user,
  onLogout,
}: {
  user: User;
  onLogout: (notice: string) => void;
}) {
  const [currentPassword, setCurrent] = useState(""),
    [newPassword, setNew] = useState(""),
    action = useAction();
  return (
    <section className="panel narrow">
      <div className="eyebrow">ACCOUNT</div>
      <h1>{user.name}</h1>
      <p className="muted">{user.email}</p>
      <h2>Change password</h2>
      <p>Changing your password signs you out on every device.</p>
      <form
        onSubmit={(e) =>
          submit(
            e,
            () =>
              void action.run(async () => {
                await api("/auth/password", "POST", {
                  currentPassword,
                  newPassword,
                });
                onLogout(
                  "Password changed. Please sign in with your new password.",
                );
              }),
          )
        }
      >
        <fieldset disabled={action.busy}>
          <Field title="Current password">
            <input
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
              value={currentPassword}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field title="New password (12–128 characters)">
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={128}
              value={newPassword}
              onChange={(e) => setNew(e.target.value)}
            />
          </Field>
          <ErrorMessage>{action.error}</ErrorMessage>
          <Submit busy={action.busy}>Update password</Submit>
        </fieldset>
      </form>
    </section>
  );
}
function TaskFields({
  members,
  value,
  setValue,
  disabled,
}: {
  members: Member[];
  value: TaskDraft;
  setValue: (value: TaskDraft) => void;
  disabled: boolean;
}) {
  const set = (key: keyof TaskDraft, v: string) =>
    setValue({ ...value, [key]: v });
  return (
    <fieldset disabled={disabled}>
      <Field title="Title">
        <input
          required
          maxLength={200}
          value={value.title}
          onChange={(e) => set("title", e.target.value)}
        />
      </Field>
      <Field title="Description">
        <textarea
          rows={5}
          maxLength={10000}
          value={value.description}
          onChange={(e) => set("description", e.target.value)}
        />
      </Field>
      <div className="form-grid">
        <Field title="Status">
          <select
            value={value.status}
            onChange={(e) => set("status", e.target.value)}
          >
            <option value="todo">To do</option>
            <option value="in_progress">In progress</option>
            <option value="done">Done</option>
          </select>
        </Field>
        <Field title="Priority">
          <select
            value={value.priority}
            onChange={(e) => set("priority", e.target.value)}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </Field>
        <Field title="Assignee">
          <select
            value={value.assigneeId}
            onChange={(e) => set("assigneeId", e.target.value)}
          >
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        <Field title="Due date">
          <input
            type="date"
            value={value.dueDate}
            onChange={(e) => set("dueDate", e.target.value)}
          />
        </Field>
      </div>
    </fieldset>
  );
}
type TaskDraft = {
  title: string;
  description: string;
  status: string;
  priority: string;
  assigneeId: string;
  dueDate: string;
};
const blank: TaskDraft = {
  title: "",
  description: "",
  status: "todo",
  priority: "medium",
  assigneeId: "",
  dueDate: "",
};
const taskBody = (value: TaskDraft) => ({
  ...value,
  assigneeId: value.assigneeId || null,
  dueDate: value.dueDate || null,
});
function TaskList({
  project,
  members,
}: {
  project: Project;
  members: Member[];
}) {
  const [filters, setFilters] = useState({
      q: "",
      status: "",
      priority: "",
      assigneeId: "",
    }),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(1),
    [version, setVersion] = useState(0);
  const [creating, setCreating] = useState(false),
    [draft, setDraft] = useState(blank),
    action = useAction();
  const base = "/projects/" + project.id;
  const result = useResource<{
    tasks: Task[];
    total: number;
    page: number;
    pageSize: number;
  }>(base + "/tasks?page=" + page + "&pageSize=10&" + query, version);
  function applyFilters() {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters))
      if (value) params.set(key, value);
    setPage(1);
    setQuery(params.toString());
  }
  return (
    <>
      <div className="section-heading">
        <h2>
          Tasks{" "}
          {result.data && <span className="count">{result.data.total}</span>}
        </h2>
        {project.role !== "viewer" && (
          <button className="primary" onClick={() => setCreating(!creating)}>
            {creating ? "Close form" : "+ New task"}
          </button>
        )}
      </div>
      {creating && (
        <section className="panel">
          <h3>Create a task</h3>
          <form
            onSubmit={(e) =>
              submit(
                e,
                () =>
                  void action.run(async () => {
                    await api(base + "/tasks", "POST", taskBody(draft));
                    setDraft(blank);
                    setCreating(false);
                    setPage(1);
                    setVersion((v) => v + 1);
                  }),
              )
            }
          >
            <TaskFields
              members={members}
              value={draft}
              setValue={setDraft}
              disabled={action.busy}
            />
            <ErrorMessage>{action.error}</ErrorMessage>
            <Submit busy={action.busy}>Create task</Submit>
          </form>
        </section>
      )}
      <form className="filters" onSubmit={(e) => submit(e, applyFilters)}>
        <Field title="Search">
          <input
            maxLength={200}
            value={filters.q}
            placeholder="Title or description"
            onChange={(e) => setFilters({ ...filters, q: e.target.value })}
          />
        </Field>
        <Field title="Status">
          <select
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value })}
          >
            <option value="">All statuses</option>
            <option value="todo">To do</option>
            <option value="in_progress">In progress</option>
            <option value="done">Done</option>
          </select>
        </Field>
        <Field title="Priority">
          <select
            value={filters.priority}
            onChange={(e) =>
              setFilters({ ...filters, priority: e.target.value })
            }
          >
            <option value="">All priorities</option>
            {["low", "medium", "high"].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </Field>
        <Field title="Assignee">
          <select
            value={filters.assigneeId}
            onChange={(e) =>
              setFilters({ ...filters, assigneeId: e.target.value })
            }
          >
            <option value="">Everyone</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        <button type="submit">Apply filters</button>
        <button
          type="button"
          onClick={() => {
            setFilters({ q: "", status: "", priority: "", assigneeId: "" });
            setQuery("");
            setPage(1);
          }}
        >
          Reset
        </button>
      </form>
      <State {...result} />
      {result.data && (
        <>
          <div className="task-list">
            {result.data.tasks.map((t) => (
              <a
                className="task-row"
                href={"#projects/" + project.id + "/tasks/" + t.id}
                key={t.id}
              >
                <div>
                  <span className={"status-dot " + t.status} />
                  <strong>{t.title}</strong>
                  <div className="task-meta">
                    {members.find((m) => m.id === t.assigneeId)?.name ??
                      "Unassigned"}
                    {t.dueDate && " · Due " + t.dueDate}
                  </div>
                </div>
                <div className="task-tags">
                  <span className={"badge " + t.status}>{label(t.status)}</span>
                  <span className={"badge priority-" + t.priority}>
                    {t.priority}
                  </span>
                </div>
              </a>
            ))}
            {!result.data.tasks.length && (
              <Empty>
                {query
                  ? "No tasks match your filters."
                  : "No tasks on this page. Create a task to get started."}
              </Empty>
            )}
          </div>
          <nav className="pagination" aria-label="Task pages">
            <button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              ← Previous
            </button>
            <span>
              Page {page} of {Math.max(1, Math.ceil(result.data.total / 10))} ·{" "}
              {result.data.total} tasks
            </span>
            <button
              disabled={page * 10 >= result.data.total}
              onClick={() => setPage((p) => p + 1)}
            >
              Next →
            </button>
          </nav>
        </>
      )}
    </>
  );
}
function TaskDetail({
  project,
  members,
  taskId,
  user,
}: {
  project: Project;
  members: Member[];
  taskId: string;
  user: User;
}) {
  const url = "/projects/" + project.id + "/tasks/" + taskId;
  const result = useResource<{ task: Task }>(url);
  return (
    <>
      <a className="back" href={"#projects/" + project.id}>
        ← All tasks
      </a>
      <State {...result} />
      {result.data && (
        <TaskEditor
          key={result.data.task.updatedAt}
          task={result.data.task}
          project={project}
          members={members}
          user={user}
          reload={result.reload}
        />
      )}
    </>
  );
}
function TaskEditor({
  task,
  project,
  members,
  user,
  reload,
}: {
  task: Task;
  project: Project;
  members: Member[];
  user: User;
  reload: () => void;
}) {
  const [draft, setDraft] = useState<TaskDraft>({
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      assigneeId: task.assigneeId ?? "",
      dueDate: task.dueDate ?? "",
    }),
    [saved, setSaved] = useState(false),
    action = useAction();
  const [stored, setStored] = useState(task);
  const url = "/projects/" + project.id + "/tasks/" + task.id,
    canWrite = project.role !== "viewer";
  return (
    <>
      <section className="panel">
        <div className="section-heading">
          <h2>{stored.title}</h2>
          <span className="badge">{label(stored.status)}</span>
        </div>
        {canWrite ? (
          <form
            onSubmit={(e) =>
              submit(
                e,
                () =>
                  void action.run(async () => {
                    const result = await api<{ task: Task }>(
                      url,
                      "PATCH",
                      taskBody(draft),
                    );
                    setStored(result.task);
                    setSaved(true);
                  }),
              )
            }
          >
            <TaskFields
              members={members}
              value={draft}
              setValue={(v) => {
                setDraft(v);
                setSaved(false);
              }}
              disabled={action.busy}
            />
            <ErrorMessage>{action.error}</ErrorMessage>
            <div className="actions">
              <Submit busy={action.busy}>Save changes</Submit>
              <button
                className="danger"
                type="button"
                disabled={action.busy}
                onClick={() => {
                  if (
                    confirm(
                      "Delete this task and all its comments? This cannot be undone.",
                    )
                  )
                    void action.run(async () => {
                      await api(url, "DELETE");
                      go("projects/" + project.id);
                    });
                }}
              >
                Delete task
              </button>
              {saved && <span role="status">Changes saved.</span>}
            </div>
          </form>
        ) : (
          <>
            <p className="prose">{task.description || "No description."}</p>
            <dl className="details">
              <dt>Priority</dt>
              <dd>{task.priority}</dd>
              <dt>Assignee</dt>
              <dd>
                {members.find((m) => m.id === task.assigneeId)?.name ??
                  "Unassigned"}
              </dd>
              <dt>Due date</dt>
              <dd>{task.dueDate ?? "No due date"}</dd>
            </dl>
          </>
        )}
        <p className="muted small">
          Created {dateTime(task.createdAt)}{" "}
          <button className="text-button" onClick={reload}>
            Refresh task
          </button>
        </p>
      </section>
      <Comments url={url} role={project.role} user={user} />
    </>
  );
}
function Comments({
  url,
  role,
  user,
}: {
  url: string;
  role: Project["role"];
  user: User;
}) {
  const result = useResource<{ comments: Comment[] }>(url + "/comments"),
    action = useAction(),
    [value, setValue] = useState("");
  return (
    <section className="panel">
      <h2>Conversation</h2>
      <State {...result} />
      {result.data?.comments.map((c) => (
        <article className="comment" key={c.id}>
          <div className="section-heading">
            <div>
              <strong>{c.authorName}</strong>
              <span className="muted small"> · {dateTime(c.createdAt)}</span>
            </div>
            {role !== "viewer" &&
              (role === "owner" || c.authorId === user.id) && (
                <button
                  className="text-button danger"
                  disabled={action.busy}
                  aria-label={"Delete comment by " + c.authorName}
                  onClick={() => {
                    if (confirm("Delete this comment?"))
                      void action.run(async () => {
                        await api(url + "/comments/" + c.id, "DELETE");
                        result.reload();
                      });
                  }}
                >
                  Delete
                </button>
              )}
          </div>
          <p className="prose">{c.body}</p>
        </article>
      ))}
      {result.data?.comments.length === 0 && (
        <p className="muted">No comments yet.</p>
      )}
      {role !== "viewer" && (
        <form
          onSubmit={(e) =>
            submit(
              e,
              () =>
                void action.run(async () => {
                  await api(url + "/comments", "POST", { body: value });
                  setValue("");
                  result.reload();
                }),
            )
          }
        >
          <Field title="Add a comment">
            <textarea
              required
              maxLength={2000}
              rows={3}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={action.busy}
            />
          </Field>
          <Submit busy={action.busy}>Post comment</Submit>
        </form>
      )}
      <ErrorMessage>{action.error}</ErrorMessage>
    </section>
  );
}
function Members({
  project,
  members,
  reload,
}: {
  project: Project;
  members: Member[];
  reload: () => void;
}) {
  const action = useAction(),
    [email, setEmail] = useState(""),
    [role, setRole] = useState("editor"),
    [link, setLink] = useState(""),
    [copied, setCopied] = useState(false);
  const base = "/projects/" + project.id,
    owner = project.role === "owner";
  return (
    <>
      <section className="panel">
        <h2>Project members</h2>
        <p className="muted">
          Owners manage the project and team. Editors manage tasks and comments.
          Viewers can read.
        </p>
        {members.map((m) => (
          <div className="member" key={m.id}>
            <div>
              <strong>{m.name}</strong>
              <div className="muted small">{m.email}</div>
            </div>
            {owner && m.role !== "owner" ? (
              <div className="actions">
                <label className="sr-only" htmlFor={"role-" + m.id}>
                  Role for {m.name}
                </label>
                <select
                  id={"role-" + m.id}
                  value={m.role}
                  disabled={action.busy}
                  onChange={(e) => {
                    const role = e.target.value;
                    void action.run(async () => {
                      await api(base + "/members/" + m.id, "PATCH", { role });
                      reload();
                    });
                  }}
                >
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
                <button
                  className="danger"
                  disabled={action.busy}
                  onClick={() => {
                    if (
                      confirm(
                        "Remove " +
                          m.name +
                          "? Their tasks will become unassigned.",
                      )
                    )
                      void action.run(async () => {
                        await api(base + "/members/" + m.id, "DELETE");
                        reload();
                      });
                  }}
                >
                  Remove
                </button>
              </div>
            ) : (
              <span className="badge">{m.role}</span>
            )}
          </div>
        ))}
      </section>
      {owner && (
        <section className="panel">
          <h2>Invite a teammate</h2>
          <p className="muted">
            Generate a one-time link and share it yourself. It expires in 7 days
            and only works for the invited email.
          </p>
          <form
            className="inline-form"
            onSubmit={(e) =>
              submit(
                e,
                () =>
                  void action.run(async () => {
                    const { invite } = await api<{ invite: { link: string } }>(
                      base + "/invitations",
                      "POST",
                      { email, role },
                    );
                    setLink(invite.link);
                    setCopied(false);
                  }),
              )
            }
          >
            <Field title="Email address">
              <input
                type="email"
                required
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={action.busy}
              />
            </Field>
            <Field title="Role">
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                disabled={action.busy}
              >
                <option value="editor">Editor</option>
                <option value="viewer">Viewer</option>
              </select>
            </Field>
            <Submit busy={action.busy}>Generate invitation</Submit>
          </form>
          {link && (
            <div className="invite-link">
              <Field title="Share this invitation link">
                <input
                  readOnly
                  value={link}
                  onFocus={(e) => e.target.select()}
                />
              </Field>
              <button
                onClick={() =>
                  void action.run(async () => {
                    if (!navigator.clipboard)
                      throw new Error(
                        "Select and copy the link manually in this browser.",
                      );
                    await navigator.clipboard.writeText(link);
                    setCopied(true);
                  })
                }
              >
                Copy link
              </button>
              {copied && <span role="status">Copied.</span>}
            </div>
          )}
        </section>
      )}
      <ErrorMessage>{action.error}</ErrorMessage>
    </>
  );
}
function ActivityFeed({ projectId }: { projectId: string }) {
  const result = useResource<{ events: Activity[] }>(
    "/projects/" + projectId + "/activity",
  );
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>Project activity</h2>
        <button onClick={result.reload}>Refresh</button>
      </div>
      <p className="muted">
        Project history, from first step to latest change.
      </p>
      <State {...result} />
      {result.data?.events.length === 0 && (
        <Empty>
          No activity yet. Task and comment changes will appear here.
        </Empty>
      )}
      <ol className="activity">
        {result.data?.events.map((e) => (
          <li key={e.id}>
            <span className="activity-mark" aria-hidden="true" />
            <div>
              <p>
                <strong>{e.actorName}</strong> · {e.action.replace(".", " ")} ·{" "}
                <strong>{e.taskTitle}</strong>
              </p>
              <time className="muted small" dateTime={e.createdAt}>
                {dateTime(e.createdAt)}
              </time>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
function Settings({
  project,
  reload,
}: {
  project: Project;
  reload: () => void;
}) {
  const [name, setName] = useState(project.name),
    action = useAction();
  return (
    <section className="panel narrow">
      <h2>Project settings</h2>
      <form
        onSubmit={(e) =>
          submit(
            e,
            () =>
              void action.run(async () => {
                await api("/projects/" + project.id, "PATCH", { name });
                reload();
              }),
          )
        }
      >
        <Field title="Project name">
          <input
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={action.busy}
          />
        </Field>
        <Submit busy={action.busy}>Rename project</Submit>
      </form>
      <hr />
      <h3>Delete project</h3>
      <p>
        This permanently deletes all tasks, comments, invitations and activity.
      </p>
      <button
        className="danger"
        disabled={action.busy}
        onClick={() => {
          if (
            confirm(
              "Permanently delete “" +
                project.name +
                "” and all its data? This cannot be undone.",
            )
          )
            void action.run(async () => {
              await api("/projects/" + project.id, "DELETE");
              go("projects");
            });
        }}
      >
        Delete project
      </button>
      <ErrorMessage>{action.error}</ErrorMessage>
    </section>
  );
}
function ProjectPage({
  projectId,
  section,
  taskId,
  user,
}: {
  projectId: string;
  section?: string;
  taskId?: string;
  user: User;
}) {
  const result = useResource<{ project: Project; members: Member[] }>(
    "/projects/" + projectId,
  );
  if (!result.data) return <State {...result} />;
  const { project, members } = result.data;
  return (
    <>
      <header className="page-heading">
        <div>
          <a className="back" href="#projects">
            ← Projects
          </a>
          <h1>{project.name}</h1>
          <span className="badge">{project.role}</span>{" "}
          <span className="muted small">{members.length} members</span>
        </div>
      </header>
      <nav className="tabs" aria-label="Project sections">
        {[
          "tasks",
          "members",
          "activity",
          ...(project.role === "owner" ? ["settings"] : []),
        ].map((tab) => (
          <a
            key={tab}
            className={(section ?? "tasks") === tab ? "active" : ""}
            aria-current={(section ?? "tasks") === tab ? "page" : undefined}
            href={"#projects/" + projectId + "/" + tab}
          >
            {tab === "members" ? "Members & invites" : label(tab)}
          </a>
        ))}
      </nav>
      {section === "members" ? (
        <Members project={project} members={members} reload={result.reload} />
      ) : section === "activity" ? (
        <ActivityFeed projectId={projectId} />
      ) : section === "settings" ? (
        project.role === "owner" ? (
          <Settings project={project} reload={result.reload} />
        ) : (
          <ErrorMessage>
            Only the owner can manage project settings.
          </ErrorMessage>
        )
      ) : taskId ? (
        <TaskDetail
          key={taskId}
          project={project}
          members={members}
          taskId={taskId}
          user={user}
        />
      ) : (
        <TaskList project={project} members={members} />
      )}
    </>
  );
}
function App() {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [initialError, setInitialError] = useState(""),
    [notice, setNotice] = useState(""),
    [route, setRoute] = useState(location.hash.slice(1)),
    action = useAction();
  useEffect(() => {
    const change = () => setRoute(location.hash.slice(1));
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  const logout = (notice: string) => {
    setUser(null);
    setNotice(notice);
  };
  useEffect(() => {
    const expired = () => logout("Your session expired. Please sign in again.");
    window.addEventListener("session-expired", expired);
    return () => window.removeEventListener("session-expired", expired);
  }, []);
  useEffect(() => {
    let active = true;
    api<{ user: User }>("/auth/me")
      .then((r) => {
        if (active) setUser(r.user);
      })
      .catch((error) => {
        if (active && error.status !== 401) setInitialError(error.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  if (loading)
    return (
      <main className="startup" role="status">
        Loading TaskForge…
      </main>
    );
  if (initialError)
    return (
      <main className="startup">
        <ErrorMessage>{initialError}</ErrorMessage>
        <button onClick={() => location.reload()}>Retry connection</button>
      </main>
    );
  if (!user)
    return (
      <Auth
        notice={notice}
        onUser={(u) => {
          setUser(u);
          setNotice("");
        }}
      />
    );
  const [root, projectId, section, taskId] = route.split("/");
  return (
    <>
      <header className="topbar">
        <a className="brand" href="#projects">
          <span aria-hidden="true">▦</span> TaskForge
        </a>
        <nav aria-label="Main navigation">
          <a href="#projects">Projects</a>
          <a href="#account">{user.name}</a>
          <button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await api("/auth/logout", "POST");
                logout("You have been signed out.");
              })
            }
          >
            Sign out
          </button>
        </nav>
      </header>
      <main className="workspace">
        <ErrorMessage>{action.error}</ErrorMessage>
        {root === "account" ? (
          <Account user={user} onLogout={logout} />
        ) : root === "invite" ? (
          <Invite token={projectId} />
        ) : root === "projects" && projectId ? (
          <ProjectPage
            key={projectId}
            projectId={projectId}
            section={section}
            taskId={taskId}
            user={user}
          />
        ) : (
          <Projects />
        )}
      </main>
      <footer className="footer">
        TaskForge <span>Space to do your best work.</span>
      </footer>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
