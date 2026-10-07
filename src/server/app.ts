import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { Config } from "./config";
import {
  body,
  choice,
  dueDate,
  email,
  fail,
  positive,
  text,
} from "./validation";
import type { Member, Project, Role, Task, User } from "../shared";
import { createHash, randomBytes } from "node:crypto";

type Env = { Variables: { user: User }; Bindings: { ip?: string } };
type Ctx = Context<Env>;
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const publicUser = (u: User): User => ({
  id: u.id,
  name: u.name,
  email: u.email,
});
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const statuses = ["todo", "in_progress", "done"] as const;
const priorities = ["low", "medium", "high"] as const;
const taskColumns =
  "id,projectId,title,description,status,priority,assigneeId,dueDate,createdAt,updatedAt";
const taskKeys = [
  "title",
  "description",
  "status",
  "priority",
  "assigneeId",
  "dueDate",
];

export function createApp(db: Database, config: Config) {
  const app = new Hono<Env>();
  const get = <T>(sql: string, ...values: SQLQueryBindings[]) =>
    db.query<T, SQLQueryBindings[]>(sql).get(...values);
  const all = <T>(sql: string, ...values: SQLQueryBindings[]) =>
    db.query<T, SQLQueryBindings[]>(sql).all(...values);
  const run = (sql: string, ...values: SQLQueryBindings[]) =>
    db.query(sql).run(...values);
  const cookie = config.production ? "__Host-taskforge" : "taskforge";
  const cookieOptions = {
    httpOnly: true,
    secure: config.production,
    sameSite: "Lax" as const,
    path: "/",
  };
  const dummyHash = Bun.password.hashSync(
    "dummy-verification-password-never-used",
    { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 },
  );
  const hashPassword = (password: string) =>
    Bun.password.hash(password, {
      algorithm: "argon2id",
      memoryCost: 19456,
      timeCost: 2,
    });
  const rates = new Map<string, { count: number; reset: number }>();
  function newSession(c: Ctx, userId: string) {
    const raw = token();
    run("DELETE FROM sessions WHERE expiresAt<=?", Date.now());
    run(
      "INSERT INTO sessions VALUES (?,?,?)",
      digest(raw),
      userId,
      Date.now() + SESSION_MS,
    );
    setCookie(c, cookie, raw, { ...cookieOptions, maxAge: SESSION_MS / 1000 });
  }
  function project(c: Ctx, required: "read" | "write" | "owner" = "read") {
    const p = get<Project>(
      "SELECT p.id,p.name,m.role FROM projects p JOIN members m ON p.id=m.projectId WHERE p.id=? AND m.userId=?",
      c.req.param("projectId")!,
      c.get("user").id,
    );
    if (!p) return fail(404, "Project not found");
    if (
      (required === "owner" && p.role !== "owner") ||
      (required === "write" && p.role === "viewer")
    )
      fail(403, "Your project role does not allow this action");
    return p;
  }
  function task(c: Ctx, required: "read" | "write" = "read") {
    const p = project(c, required);
    const t = get<Task>(
      `SELECT ${taskColumns} FROM tasks WHERE id=? AND projectId=?`,
      c.req.param("taskId")!,
      p.id,
    );
    if (!t) return fail(404, "Task not found");
    return { p, t };
  }
  function event(c: Ctx, t: Task, action: string) {
    run(
      "INSERT INTO activity (id,projectId,taskTitle,action,actorId,createdAt) VALUES (?,?,?,?,?,?)",
      id(),
      t.projectId,
      t.title,
      action,
      c.get("user").id,
      now(),
    );
  }
  function taskData(
    data: Record<string, unknown>,
    projectId: string,
    current?: Task,
  ) {
    if (current && !Object.keys(data).length)
      fail(400, "Supply at least one task field");
    const result = {
      title:
        "title" in data || !current
          ? text(data.title, "Title", 1, 200)
          : current.title,
      description:
        "description" in data
          ? text(data.description, "Description", 0, 10000)
          : (current?.description ?? ""),
      status:
        "status" in data
          ? choice(data.status, statuses, "status")
          : (current?.status ?? "todo"),
      priority:
        "priority" in data
          ? choice(data.priority, priorities, "priority")
          : (current?.priority ?? "medium"),
      assigneeId:
        "assigneeId" in data
          ? data.assigneeId === null
            ? null
            : text(data.assigneeId, "Assignee", 1, 100)
          : (current?.assigneeId ?? null),
      dueDate:
        "dueDate" in data ? dueDate(data.dueDate) : (current?.dueDate ?? null),
    };
    if (
      result.assigneeId &&
      !get(
        "SELECT 1 FROM members WHERE projectId=? AND userId=?",
        projectId,
        result.assigneeId,
      )
    )
      fail(400, "Assignee must be a current project member");
    return result;
  }
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
      referrerPolicy: "no-referrer",
    }),
  );
  app.use(
    "*",
    bodyLimit({
      maxSize: 65536,
      onError: (c) => c.json({ error: "Request body too large" }, 400),
    }),
  );
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("Origin");
      if (
        (origin && origin !== config.origin) ||
        c.req.header("Sec-Fetch-Site") === "cross-site"
      )
        fail(403, "Foreign origin is not allowed");
    }
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof HTTPException)
      return c.json({ error: err.message }, err.status);
    console.error("Unhandled server error:", err);
    return c.json({ error: "Internal server error" }, 500);
  });
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.use("/api/auth/*", async (c, next) => {
    if (
      c.req.method === "POST" &&
      ["/api/auth/login", "/api/auth/register"].includes(c.req.path)
    ) {
      const time = Date.now();
      for (const [key, value] of rates)
        if (value.reset <= time) rates.delete(key);
      const key = c.env?.ip ?? "local";
      const entry = rates.get(key) ?? {
        count: 0,
        reset: time + 15 * 60 * 1000,
      };
      entry.count++;
      rates.set(key, entry);
      if (entry.count > config.rateMax) {
        c.header("Retry-After", String(Math.ceil((entry.reset - time) / 1000)));
        fail(429, "Too many authentication attempts. Try again later.");
      }
    }
    await next();
  });
  app.post("/api/auth/register", async (c) => {
    const data = await body(c, ["name", "email", "password"]);
    const name = text(data.name, "Name", 1, 80),
      address = email(data.email),
      password = text(data.password, "Password", 12, 128, false);
    if (get("SELECT id FROM users WHERE email=?", address))
      fail(409, "Email is already registered");
    const passwordHash = await hashPassword(password);
    const user = { id: id(), name, email: address };
    db.transaction(() => {
      if (get("SELECT id FROM users WHERE email=?", address))
        fail(409, "Email is already registered");
      run(
        "INSERT INTO users VALUES (?,?,?,?)",
        user.id,
        name,
        address,
        passwordHash,
      );
      newSession(c, user.id);
    })();
    return c.json({ user }, 201);
  });
  app.post("/api/auth/login", async (c) => {
    const data = await body(c, ["email", "password"]);
    const address = email(data.email),
      password = text(data.password, "Password", 1, 128, false);
    const user = get<User & { passwordHash: string }>(
      "SELECT * FROM users WHERE email=?",
      address,
    );
    const valid = await Bun.password.verify(
      password,
      user?.passwordHash ?? dummyHash,
    );
    if (!user || !valid) return fail(401, "Invalid email or password");
    // A concurrent password change must not permit a new session from the old hash.
    if (
      !get(
        "SELECT id FROM users WHERE id=? AND passwordHash=?",
        user.id,
        user.passwordHash,
      )
    )
      fail(401, "Invalid email or password");
    newSession(c, user.id);
    return c.json({ user: publicUser(user) });
  });
  app.use("/api/*", async (c, next) => {
    if (
      !c.req.matchedRoutes.some(
        (route) =>
          route.method !== "ALL" &&
          route.path.startsWith("/api/") &&
          !route.path.includes("*"),
      )
    )
      return c.json({ error: "Resource not found" }, 404);
    const raw = getCookie(c, cookie);
    const user =
      raw &&
      get<User>(
        "SELECT u.id,u.name,u.email FROM users u JOIN sessions s ON s.userId=u.id WHERE s.tokenHash=? AND s.expiresAt>?",
        digest(raw),
        Date.now(),
      );
    if (!user) return fail(401, "Session expired. Please sign in.");
    c.set("user", user);
    await next();
  });
  app.get("/api/auth/me", (c) => c.json({ user: c.get("user") }));
  app.post("/api/auth/logout", (c) => {
    run(
      "DELETE FROM sessions WHERE tokenHash=?",
      digest(getCookie(c, cookie)!),
    );
    deleteCookie(c, cookie, cookieOptions);
    return c.body(null, 204);
  });
  app.post("/api/auth/password", async (c) => {
    const data = await body(c, ["currentPassword", "newPassword"]);
    const current = text(
        data.currentPassword,
        "Current password",
        1,
        128,
        false,
      ),
      password = text(data.newPassword, "New password", 12, 128, false);
    const userId = c.get("user").id;
    const user = get<{ passwordHash: string }>(
      "SELECT passwordHash FROM users WHERE id=?",
      userId,
    )!;
    if (!(await Bun.password.verify(current, user.passwordHash)))
      fail(401, "Invalid email or password");
    const newHash = await hashPassword(password);
    db.transaction(() => {
      if (
        !get(
          "SELECT 1 FROM users WHERE id=? AND passwordHash=?",
          userId,
          user.passwordHash,
        )
      )
        fail(401, "Session expired. Please sign in.");
      run("UPDATE users SET passwordHash=? WHERE id=?", newHash, userId);
      run("DELETE FROM sessions WHERE userId=?", userId);
    })();
    deleteCookie(c, cookie, cookieOptions);
    return c.body(null, 204);
  });
  app.get("/api/projects", (c) =>
    c.json({
      projects: all<Project>(
        "SELECT p.id,p.name,m.role FROM projects p JOIN members m ON p.id=m.projectId WHERE m.userId=? ORDER BY p.createdAt DESC,p.id DESC",
        c.get("user").id,
      ),
    }),
  );
  app.post("/api/projects", async (c) => {
    const data = await body(c, ["name"]);
    const p: Project = {
      id: id(),
      name: text(data.name, "Project name", 1, 100),
      role: "owner",
    };
    db.transaction(() => {
      run("INSERT INTO projects VALUES (?,?,?)", p.id, p.name, now());
      run(
        "INSERT INTO members VALUES (?,?,?)",
        p.id,
        c.get("user").id,
        "owner",
      );
    })();
    return c.json({ project: p }, 201);
  });
  app.get("/api/projects/:projectId", (c) => {
    const p = project(c);
    return c.json({
      project: p,
      members: all<Member>(
        "SELECT u.id,u.name,u.email,m.role FROM users u JOIN members m ON u.id=m.userId WHERE m.projectId=? ORDER BY m.role,u.name,u.id",
        p.id,
      ),
    });
  });
  app.patch("/api/projects/:projectId", async (c) => {
    const data = await body(c, ["name"]);
    const p = project(c, "owner"),
      name = text(data.name, "Project name", 1, 100);
    run("UPDATE projects SET name=? WHERE id=?", name, p.id);
    return c.json({ project: { ...p, name } });
  });
  app.delete("/api/projects/:projectId", (c) => {
    const p = project(c, "owner");
    db.transaction(() => run("DELETE FROM projects WHERE id=?", p.id))();
    return c.body(null, 204);
  });
  app.post("/api/projects/:projectId/invitations", async (c) => {
    const data = await body(c, ["email", "role"]);
    const p = project(c, "owner"),
      address = email(data.email),
      role = choice(
        data.role,
        ["editor", "viewer"] as const,
        "invitation role",
      );
    if (
      get(
        "SELECT 1 FROM members m JOIN users u ON u.id=m.userId WHERE m.projectId=? AND u.email=?",
        p.id,
        address,
      )
    )
      fail(409, "This user is already a member");
    const raw = token(),
      expires = Date.now() + SESSION_MS;
    run(
      "INSERT INTO invitations VALUES (?,?,?,?,?,NULL)",
      digest(raw),
      p.id,
      address,
      role,
      expires,
    );
    return c.json(
      {
        invite: {
          token: raw,
          email: address,
          role,
          expiresAt: new Date(expires).toISOString(),
          link: `${config.origin}/#invite/${raw}`,
        },
      },
      201,
    );
  });
  app.post("/api/invitations/accept", async (c) => {
    const data = await body(c, ["token"]);
    const hash = digest(text(data.token, "Invitation token", 1, 200));
    const p = db.transaction(() => {
      const invite = get<{
        projectId: string;
        email: string;
        role: Role;
        expiresAt: number;
        acceptedAt: string | null;
      }>("SELECT * FROM invitations WHERE tokenHash=?", hash);
      if (!invite) return fail(404, "Invitation not found");
      if (invite.email !== c.get("user").email)
        fail(403, "Sign in with the invited email address");
      if (invite.acceptedAt) fail(409, "Invitation has already been accepted");
      if (invite.expiresAt <= Date.now()) fail(400, "Invitation has expired");
      if (
        get(
          "SELECT 1 FROM members WHERE projectId=? AND userId=?",
          invite.projectId,
          c.get("user").id,
        )
      )
        fail(409, "You are already a project member");
      run(
        "INSERT INTO members VALUES (?,?,?)",
        invite.projectId,
        c.get("user").id,
        invite.role,
      );
      run("UPDATE invitations SET acceptedAt=? WHERE tokenHash=?", now(), hash);
      const row = get<{ id: string; name: string }>(
        "SELECT id,name FROM projects WHERE id=?",
        invite.projectId,
      )!;
      return { ...row, role: invite.role };
    })();
    return c.json({ project: p });
  });
  app.patch("/api/projects/:projectId/members/:userId", async (c) => {
    const data = await body(c, ["role"]);
    const p = project(c, "owner"),
      role = choice(data.role, ["editor", "viewer"] as const, "member role");
    const m = get<Member>(
      "SELECT u.id,u.name,u.email,m.role FROM users u JOIN members m ON u.id=m.userId WHERE m.projectId=? AND u.id=?",
      p.id,
      c.req.param("userId"),
    );
    if (!m) return fail(404, "Member not found");
    if (m.role === "owner") fail(403, "The owner cannot be demoted");
    run(
      "UPDATE members SET role=? WHERE projectId=? AND userId=?",
      role,
      p.id,
      m.id,
    );
    return c.json({ member: { ...m, role } });
  });
  app.delete("/api/projects/:projectId/members/:userId", (c) => {
    const p = project(c, "owner"),
      userId = c.req.param("userId");
    const m = get<{ role: Role }>(
      "SELECT role FROM members WHERE projectId=? AND userId=?",
      p.id,
      userId,
    );
    if (!m) fail(404, "Member not found");
    if (m!.role === "owner") fail(403, "The owner cannot be removed");
    db.transaction(() => {
      const tasks = all<Task>(
        `SELECT ${taskColumns} FROM tasks WHERE projectId=? AND assigneeId=?`,
        p.id,
        userId,
      );
      run(
        "UPDATE tasks SET assigneeId=NULL,updatedAt=? WHERE projectId=? AND assigneeId=?",
        now(),
        p.id,
        userId,
      );
      for (const t of tasks) event(c, t, "task.updated");
      run("DELETE FROM members WHERE projectId=? AND userId=?", p.id, userId);
      // Outstanding invitations must not silently restore access after removal.
      run(
        "DELETE FROM invitations WHERE projectId=? AND email=(SELECT email FROM users WHERE id=?) AND acceptedAt IS NULL",
        p.id,
        userId,
      );
    })();
    return c.body(null, 204);
  });
  app.get("/api/projects/:projectId/tasks", (c) => {
    const p = project(c),
      query = c.req.query();
    const page = positive(query.page, 1, 1_000_000_000),
      pageSize = positive(query.pageSize, 20, 100);
    const where = ["projectId=?"],
      args: SQLQueryBindings[] = [p.id];
    if (query.status !== undefined) {
      where.push("status=?");
      args.push(choice(query.status, statuses, "status"));
    }
    if (query.priority !== undefined) {
      where.push("priority=?");
      args.push(choice(query.priority, priorities, "priority"));
    }
    if (query.assigneeId !== undefined) {
      where.push("assigneeId=?");
      args.push(text(query.assigneeId, "Assignee filter", 1, 100));
    }
    if (query.q !== undefined) {
      const q = text(query.q, "Search", 0, 10000, false).toLowerCase();
      // instr is literal: %, _ and SQL metacharacters have no special meaning.
      where.push("(instr(searchTitle,?)>0 OR instr(searchDescription,?)>0)");
      args.push(q, q);
    }
    const clause = where.join(" AND ");
    const total = get<{ count: number }>(
      `SELECT count(*) AS count FROM tasks WHERE ${clause}`,
      ...args,
    )!.count;
    const tasks = all<Task>(
      `SELECT ${taskColumns} FROM tasks WHERE ${clause} ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?`,
      ...args,
      pageSize,
      (page - 1) * pageSize,
    );
    return c.json({ tasks, total, page, pageSize });
  });
  app.post("/api/projects/:projectId/tasks", async (c) => {
    const data = await body(c, taskKeys),
      p = project(c, "write");
    const fields = taskData(data, p.id),
      timestamp = now();
    const t: Task = {
      id: id(),
      projectId: p.id,
      ...fields,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    db.transaction(() => {
      run(
        "INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        t.id,
        t.projectId,
        t.title,
        t.description,
        t.status,
        t.priority,
        t.assigneeId,
        t.dueDate,
        t.createdAt,
        t.updatedAt,
        t.title.toLowerCase(),
        t.description.toLowerCase(),
      );
      event(c, t, "task.created");
    })();
    return c.json({ task: t }, 201);
  });
  app.get("/api/projects/:projectId/tasks/:taskId", (c) =>
    c.json({ task: task(c).t }),
  );
  app.patch("/api/projects/:projectId/tasks/:taskId", async (c) => {
    const data = await body(c, taskKeys),
      { t } = task(c, "write");
    const updated: Task = {
      ...t,
      ...taskData(data, t.projectId, t),
      updatedAt: now(),
    };
    db.transaction(() => {
      run(
        "UPDATE tasks SET title=?,description=?,status=?,priority=?,assigneeId=?,dueDate=?,updatedAt=?,searchTitle=?,searchDescription=? WHERE id=?",
        updated.title,
        updated.description,
        updated.status,
        updated.priority,
        updated.assigneeId,
        updated.dueDate,
        updated.updatedAt,
        updated.title.toLowerCase(),
        updated.description.toLowerCase(),
        t.id,
      );
      event(c, updated, "task.updated");
    })();
    return c.json({ task: updated });
  });
  app.delete("/api/projects/:projectId/tasks/:taskId", (c) => {
    const { t } = task(c, "write");
    db.transaction(() => {
      event(c, t, "task.deleted");
      run("DELETE FROM tasks WHERE id=?", t.id);
    })();
    return c.body(null, 204);
  });
  app.get("/api/projects/:projectId/tasks/:taskId/comments", (c) => {
    const { t } = task(c);
    return c.json({
      comments: all(
        "SELECT c.id,c.body,c.authorId,u.name AS authorName,c.createdAt FROM comments c JOIN users u ON u.id=c.authorId WHERE c.taskId=? ORDER BY c.createdAt,c.id",
        t.id,
      ),
    });
  });
  app.post("/api/projects/:projectId/tasks/:taskId/comments", async (c) => {
    const data = await body(c, ["body"]),
      { t } = task(c, "write");
    const comment = {
      id: id(),
      body: text(data.body, "Comment", 1, 2000),
      authorId: c.get("user").id,
      authorName: c.get("user").name,
      createdAt: now(),
    };
    db.transaction(() => {
      run(
        "INSERT INTO comments VALUES (?,?,?,?,?)",
        comment.id,
        t.id,
        comment.authorId,
        comment.body,
        comment.createdAt,
      );
      event(c, t, "comment.created");
    })();
    return c.json({ comment }, 201);
  });
  app.delete(
    "/api/projects/:projectId/tasks/:taskId/comments/:commentId",
    (c) => {
      const { p, t } = task(c, "write");
      const comment = get<{ authorId: string }>(
        "SELECT authorId FROM comments WHERE id=? AND taskId=?",
        c.req.param("commentId"),
        t.id,
      );
      if (!comment) return fail(404, "Comment not found");
      if (p.role !== "owner" && comment.authorId !== c.get("user").id)
        fail(403, "You can only delete your own comments");
      db.transaction(() => {
        run("DELETE FROM comments WHERE id=?", c.req.param("commentId"));
        event(c, t, "comment.deleted");
      })();
      return c.body(null, 204);
    },
  );
  app.get("/api/projects/:projectId/activity", (c) => {
    const p = project(c);
    return c.json({
      events: all(
        "SELECT a.id,a.action,a.actorId,u.name AS actorName,a.createdAt,a.taskTitle FROM activity a JOIN users u ON u.id=a.actorId WHERE a.projectId=? ORDER BY a.seq ASC",
        p.id,
      ),
    });
  });
  app.notFound((c) => c.json({ error: "Resource not found" }, 404));
  return app;
}
