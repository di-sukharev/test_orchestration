import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../../src/server/app";
import { openDatabase } from "../../src/server/db";
import { readConfig } from "../../src/server/config";
import type {
  Activity,
  Comment,
  Member,
  Project,
  Task,
  User,
} from "../../src/shared";

const password = "Synthetic-password-2026!";
const origin = "http://localhost:3000";
const config = readConfig({ NODE_ENV: "test", AUTH_RATE_LIMIT_MAX: "10000" });
let db: ReturnType<typeof openDatabase>, app: ReturnType<typeof createApp>;
type Payload = {
  user: User;
  project: Project;
  projects: Project[];
  task: Task;
  tasks: Task[];
  total: number;
  page: number;
  pageSize: number;
  invite: { token: string; link: string };
  comment: Comment;
  comments: Comment[];
  events: Activity[];
  members: Member[];
  error: string;
};
class Client {
  cookie = "";
  async request(
    method: string,
    path: string,
    data?: unknown,
    expected = 200,
    headers: Record<string, string> = {},
  ) {
    const response = await app.request(
      "http://localhost:3000/api" + path,
      {
        method,
        headers: {
          Origin: origin,
          Cookie: this.cookie,
          "Content-Type": "application/json",
          ...headers,
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      },
      { ip: "127.0.0.1" },
    );
    const cookie = response.headers.get("set-cookie");
    if (cookie) this.cookie = cookie.split(";")[0];
    const payload = response.status === 204 ? {} : await response.json();
    expect(
      response.status,
      `${method} ${path}: ${JSON.stringify(payload)}`,
    ).toBe(expected);
    if (expected >= 400) expect(payload.error).toBeString();
    return payload as Payload;
  }
}
async function user(name = "Owner") {
  const client = new Client();
  const u = (
    await client.request(
      "POST",
      "/auth/register",
      { name, email: name.toLowerCase() + "@example.test", password },
      201,
    )
  ).user;
  return { client, user: u };
}
async function fixture() {
  const owner = await user(),
    other = await user("Other");
  const p = (
    await owner.client.request(
      "POST",
      "/projects",
      { name: " First project " },
      201,
    )
  ).project;
  const p2 = (
    await other.client.request(
      "POST",
      "/projects",
      { name: "Second project" },
      201,
    )
  ).project;
  return {
    owner,
    other,
    p,
    p2,
    base: "/projects/" + p.id,
    base2: "/projects/" + p2.id,
  };
}
async function invite(
  owner: Client,
  member: Client,
  base: string,
  email: string,
  role = "editor",
) {
  const value = (
    await owner.request("POST", base + "/invitations", { email, role }, 201)
  ).invite;
  await member.request("POST", "/invitations/accept", { token: value.token });
  return value;
}
beforeEach(() => {
  db = openDatabase(":memory:");
  app = createApp(db, config);
});
afterEach(() => db.close());

describe("Authentication and configuration", () => {
  test("normalizes identity, hashes passwords, sets protected opaque cookie, logout revokes", async () => {
    const c = new Client();
    const result = await c.request(
      "POST",
      "/auth/register",
      { name: "  Test  ", email: " Test@Example.Test ", password },
      201,
    );
    expect(result.user).toEqual({
      id: expect.any(String),
      name: "Test",
      email: "test@example.test",
    });
    expect(Object.keys(result.user).sort()).toEqual(["email", "id", "name"]);
    const stored = db
      .query<{ passwordHash: string }, []>("SELECT passwordHash FROM users")
      .get()!;
    expect(stored.passwordHash).toStartWith("$argon2id$");
    expect(await Bun.password.verify(password, stored.passwordHash)).toBe(true);
    const raw = c.cookie.split("=")[1];
    expect(raw.length).toBeGreaterThanOrEqual(40);
    expect(
      db
        .query<{ tokenHash: string }, []>("SELECT tokenHash FROM sessions")
        .get()!.tokenHash,
    ).not.toBe(raw);
    const saved = c.cookie;
    await c.request("GET", "/auth/me");
    await c.request("POST", "/auth/logout", undefined, 204);
    c.cookie = saved;
    await c.request("GET", "/auth/me", undefined, 401);
    await c.request("POST", "/auth/login", {
      email: " TEST@example.test ",
      password,
    });
    await c.request(
      "POST",
      "/auth/register",
      { name: "Duplicate", email: "test@example.test", password },
      409,
    );
  });
  test("password change revokes all sessions and refuses old credentials", async () => {
    const { client } = await user(),
      second = new Client();
    await second.request("POST", "/auth/login", {
      email: "owner@example.test",
      password,
    });
    await client.request(
      "POST",
      "/auth/password",
      { currentPassword: "incorrect", newPassword: password + "x" },
      401,
    );
    await client.request("GET", "/auth/me");
    await client.request(
      "POST",
      "/auth/password",
      { currentPassword: password, newPassword: password + "x" },
      204,
    );
    await second.request("GET", "/auth/me", undefined, 401);
    await client.request("GET", "/auth/me", undefined, 401);
    await client.request(
      "POST",
      "/auth/login",
      { email: "owner@example.test", password },
      401,
    );
    await client.request("POST", "/auth/login", {
      email: "owner@example.test",
      password: password + "x",
    });
  });
  test("expired sessions and generic credential failures", async () => {
    const { client } = await user();
    db.query("UPDATE sessions SET expiresAt=?").run(Date.now() - 1);
    await client.request("GET", "/auth/me", undefined, 401);
    const existing = await client.request(
      "POST",
      "/auth/login",
      { email: "owner@example.test", password: "bad-password" },
      401,
    );
    const absent = await client.request(
      "POST",
      "/auth/login",
      { email: "absent@example.test", password: "bad-password" },
      401,
    );
    expect(existing.error).toBe(absent.error);
  });
  test("rejects foreign origins, null origins and cross-site fetches", async () => {
    const { client } = await user();
    for (const headers of [
      { Origin: "https://evil.example" },
      { Origin: "null" },
      { "Sec-Fetch-Site": "cross-site" },
    ] as Record<string, string>[])
      await client.request("POST", "/projects", { name: "Bad" }, 403, headers);
    expect((await client.request("GET", "/projects")).projects).toHaveLength(0);
  });
  test("rate limit does not trust forwarded identity and emits retry time", async () => {
    app = createApp(db, { ...config, rateMax: 2 });
    const c = new Client();
    for (let i = 0; i < 2; i++)
      await c.request(
        "POST",
        "/auth/login",
        { email: "absent@example.test", password },
        401,
        { "X-Forwarded-For": "10.0.0." + i },
      );
    const res = await app.request(
      "/api/auth/register",
      { method: "POST", headers: { "X-Forwarded-For": "another" } },
      { ip: "127.0.0.1" },
    );
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
  test("production cookie and misconfiguration checks", async () => {
    for (const env of [
      { NODE_ENV: "production" },
      { NODE_ENV: "prod" },
      { NODE_ENV: "production", APP_ORIGIN: origin },
      { APP_ORIGIN: "https://example.test/path" },
      { PORT: "0" },
      { AUTH_RATE_LIMIT_MAX: "999" },
    ])
      expect(() => readConfig(env)).toThrow();
    const secureConfig = readConfig({
      NODE_ENV: "production",
      APP_ORIGIN: "https://tasks.example.test",
    });
    app = createApp(db, secureConfig);
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: {
        Origin: secureConfig.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Test",
        email: "test@example.test",
        password,
      }),
    });
    expect(res.status).toBe(201);
    const cookie = res.headers.get("Set-Cookie")!;
    for (const value of [
      "__Host-taskforge=",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Path=/",
    ])
      expect(cookie).toContain(value);
  });
  test("concurrent duplicate registration gives one account and a conflict", async () => {
    const request = () =>
      app.request("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test",
          email: "test@example.test",
          password,
        }),
      });
    const responses = await Promise.all([request(), request()]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  });
  test("a simultaneous login cannot survive password revocation", async () => {
    const { client } = await user();
    const concurrentLogin = app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "owner@example.test", password }),
    });
    await client.request(
      "POST",
      "/auth/password",
      { currentPassword: password, newPassword: password + "changed" },
      204,
    );
    const response = await concurrentLogin;
    expect([200, 401]).toContain(response.status);
    if (response.status === 200) {
      const other = new Client();
      other.cookie = response.headers.get("set-cookie")!.split(";")[0];
      await other.request("GET", "/auth/me", undefined, 401);
    }
    expect(db.query("SELECT * FROM sessions").all()).toHaveLength(0);
  });

  test("unknown APIs return JSON 404 for anonymous clients", async () => {
    await new Client().request("GET", "/unknown", undefined, 404);
  });
});

describe("Project and nested authorization", () => {
  test("two owners cannot access each other’s project or nested resources", async () => {
    const { owner, other, base, base2 } = await fixture();
    const t = (
      await owner.client.request(
        "POST",
        base + "/tasks",
        { title: "Secret" },
        201,
      )
    ).task;
    const comment = (
      await owner.client.request(
        "POST",
        base + "/tasks/" + t.id + "/comments",
        { body: "Private" },
        201,
      )
    ).comment;
    for (const path of [
      base,
      base + "/tasks",
      base + "/activity",
      base + "/tasks/" + t.id,
      base + "/tasks/" + t.id + "/comments",
    ])
      await other.client.request("GET", path, undefined, 404);
    await other.client.request(
      "PATCH",
      base + "/tasks/" + t.id,
      { title: "Stolen" },
      404,
    );
    await other.client.request(
      "DELETE",
      base + "/tasks/" + t.id + "/comments/" + comment.id,
      undefined,
      404,
    );
    for (const method of ["GET", "PATCH", "DELETE"])
      await other.client.request(
        method,
        base2 + "/tasks/" + t.id,
        method === "PATCH" ? { title: "Bad nesting" } : undefined,
        404,
      );
    await new Client().request("GET", base, undefined, 401);
  });
  test("owner protected, viewer read-only, roles effective immediately, removal unassigns", async () => {
    const { owner, other, base } = await fixture();
    await invite(owner.client, other.client, base, other.user.email, "viewer");
    const t = (
      await owner.client.request(
        "POST",
        base + "/tasks",
        { title: "Assigned", assigneeId: other.user.id },
        201,
      )
    ).task;
    await other.client.request("GET", base);
    await other.client.request(
      "POST",
      base + "/tasks",
      { title: "Forbidden" },
      403,
    );
    await other.client.request(
      "POST",
      base + "/tasks/" + t.id + "/comments",
      { body: "Forbidden" },
      403,
    );
    await other.client.request("PATCH", base, { name: "Forbidden" }, 403);
    await other.client.request("DELETE", base, undefined, 403);
    await owner.client.request(
      "DELETE",
      base + "/members/" + owner.user.id,
      undefined,
      403,
    );
    await owner.client.request(
      "PATCH",
      base + "/members/" + owner.user.id,
      { role: "editor" },
      403,
    );
    await owner.client.request("PATCH", base + "/members/" + other.user.id, {
      role: "editor",
    });
    await other.client.request("PATCH", base + "/tasks/" + t.id, {
      status: "done",
    });
    await other.client.request(
      "POST",
      base + "/invitations",
      { email: "third@example.test", role: "viewer" },
      403,
    );
    await other.client.request(
      "DELETE",
      base + "/members/" + owner.user.id,
      undefined,
      403,
    );
    await owner.client.request(
      "DELETE",
      base + "/members/" + other.user.id,
      undefined,
      204,
    );
    expect(
      (await owner.client.request("GET", base + "/tasks/" + t.id)).task
        .assigneeId,
    ).toBeNull();
    await other.client.request("GET", base, undefined, 404);
  });
  test("invitation binding, concurrent one-time acceptance, expiry and invalidation on removal", async () => {
    const { owner, other, base } = await fixture();
    const i = (
      await owner.client.request(
        "POST",
        base + "/invitations",
        { email: " OTHER@EXAMPLE.TEST ", role: "editor" },
        201,
      )
    ).invite;
    await owner.client.request(
      "POST",
      "/invitations/accept",
      { token: i.token },
      403,
    );
    const req = () =>
      app.request("/api/invitations/accept", {
        method: "POST",
        headers: {
          Cookie: other.client.cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: i.token }),
      });
    expect(
      (await Promise.all([req(), req()])).map((r) => r.status).sort(),
    ).toEqual([200, 409]);
    expect((await owner.client.request("GET", base)).members).toHaveLength(2);
    await owner.client.request(
      "DELETE",
      base + "/members/" + other.user.id,
      undefined,
      204,
    );
    const expired = (
      await owner.client.request(
        "POST",
        base + "/invitations",
        { email: other.user.email, role: "viewer" },
        201,
      )
    ).invite;
    db.query("UPDATE invitations SET expiresAt=? WHERE tokenHash=?").run(
      Date.now() - 1,
      createHash("sha256").update(expired.token).digest("hex"),
    );
    await other.client.request(
      "POST",
      "/invitations/accept",
      { token: expired.token },
      400,
    );
    await other.client.request(
      "POST",
      "/invitations/accept",
      { token: "unknown" },
      404,
    );
    const pending = (
      await owner.client.request(
        "POST",
        base + "/invitations",
        { email: other.user.email, role: "editor" },
        201,
      )
    ).invite;
    await invite(owner.client, other.client, base, other.user.email);
    await owner.client.request(
      "DELETE",
      base + "/members/" + other.user.id,
      undefined,
      204,
    );
    await other.client.request(
      "POST",
      "/invitations/accept",
      { token: pending.token },
      404,
    );
  });
});

describe("Tasks, comments, search and durable data", () => {
  test("CRUD, defaults, literal filters and stable pagination with tied timestamps", async () => {
    const { owner, base } = await fixture(),
      c = owner.client;
    const titles = [
      "100% FINISH",
      "ordinary_task",
      "Ordinary task",
      "ЗАДАЧА",
      "Other",
    ];
    for (const title of titles)
      await c.request(
        "POST",
        base + "/tasks",
        {
          title,
          description: " Searchable details ",
          status: "done",
          priority: "high",
          assigneeId: owner.user.id,
          dueDate: "2028-02-29",
        },
        201,
      );
    db.query("UPDATE tasks SET createdAt='2026-01-01T00:00:00.000Z'").run();
    const first = await c.request("GET", base + "/tasks?pageSize=2"),
      second = await c.request("GET", base + "/tasks?pageSize=2&page=2");
    expect(first.total).toBe(5);
    expect(first.tasks).toHaveLength(2);
    expect(
      first.tasks
        .map((t) => t.id)
        .some((id) => second.tasks.some((t) => t.id === id)),
    ).toBe(false);
    expect((await c.request("GET", base + "/tasks?pageSize=2")).tasks).toEqual(
      first.tasks,
    );
    for (const [q, total] of [
      ["%25", 1],
      ["_", 1],
      ["ordinary", 2],
      [encodeURIComponent("ordinary "), 1],
      [encodeURIComponent("задача"), 1],
      ["details", 5],
      [encodeURIComponent("' OR 1=1 --"), 0],
    ] as const)
      expect((await c.request("GET", base + "/tasks?q=" + q)).total).toBe(
        total,
      );
    expect(
      (
        await c.request(
          "GET",
          base +
            "/tasks?q=finish&status=done&priority=high&assigneeId=" +
            owner.user.id,
        )
      ).total,
    ).toBe(1);
    const t = (
      await c.request("POST", base + "/tasks", { title: "  Default  " }, 201)
    ).task;
    expect(t).toMatchObject({
      title: "Default",
      description: "",
      status: "todo",
      priority: "medium",
      dueDate: null,
      assigneeId: null,
    });
    expect(
      (
        await c.request("PATCH", base + "/tasks/" + t.id, {
          title: "Renamed",
          dueDate: null,
        })
      ).task.title,
    ).toBe("Renamed");
    await c.request("DELETE", base + "/tasks/" + t.id, undefined, 204);
    await c.request("GET", base + "/tasks/" + t.id, undefined, 404);
  });
  test("malformed and invalid input never becomes a server error", async () => {
    const { owner, other, base } = await fixture(),
      c = owner.client;
    for (const data of [
      { title: "" },
      { title: " " },
      { title: "x".repeat(201) },
      { title: "x", description: "a".repeat(10001) },
      { title: "x", status: "pending" },
      { title: "x", priority: 1 },
      { title: "x", assigneeId: other.user.id },
      { title: "x", dueDate: "2027-02-29" },
      { title: "x", dueDate: "2026-13-01" },
      { title: "x", dueDate: "2026-2-01" },
      { title: "x", extra: true },
      [],
      null,
    ])
      await c.request("POST", base + "/tasks", data, 400);
    for (const query of [
      "page=0",
      "page=-1",
      "page=1.2",
      "pageSize=101",
      "pageSize=0",
      "page=NaN",
      "status=no",
      "priority=no",
    ])
      await c.request("GET", base + "/tasks?" + query, undefined, 400);
    const t = (await c.request("POST", base + "/tasks", { title: "x" }, 201))
      .task;
    await c.request("PATCH", base + "/tasks/" + t.id, {}, 400);
    const malformed = await app.request("/api" + base + "/tasks", {
      method: "POST",
      headers: { Cookie: c.cookie, "Content-Type": "application/json" },
      body: "{broken",
    });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error).toBeString();
    await c.request(
      "POST",
      base + "/tasks/" + t.id + "/comments",
      { body: " " },
      400,
    );
    await c.request(
      "POST",
      base + "/tasks/" + t.id + "/comments",
      { body: "a".repeat(2001) },
      400,
    );
  });
  test("comment scope and authorship, task cleanup, historical activity and project cascades", async () => {
    const { owner, other, base } = await fixture(),
      c = owner.client;
    await invite(c, other.client, base, other.user.email);
    const t = (
      await c.request("POST", base + "/tasks", { title: "History" }, 201)
    ).task;
    const second = (
      await c.request("POST", base + "/tasks", { title: "Second" }, 201)
    ).task;
    const path = base + "/tasks/" + t.id;
    const comment = (
      await c.request("POST", path + "/comments", { body: "  Original  " }, 201)
    ).comment;
    expect(comment.body).toBe("Original");
    await other.client.request(
      "DELETE",
      path + "/comments/" + comment.id,
      undefined,
      403,
    );
    await c.request(
      "DELETE",
      base + "/tasks/" + second.id + "/comments/" + comment.id,
      undefined,
      404,
    );
    const own = (
      await other.client.request(
        "POST",
        path + "/comments",
        { body: "Own" },
        201,
      )
    ).comment;
    await other.client.request(
      "DELETE",
      path + "/comments/" + own.id,
      undefined,
      204,
    );
    const another = (
      await other.client.request(
        "POST",
        path + "/comments",
        { body: "Moderated" },
        201,
      )
    ).comment;
    await c.request("DELETE", path + "/comments/" + another.id, undefined, 204);
    await c.request("PATCH", path, { title: "Renamed" });
    await c.request("DELETE", path, undefined, 204);
    expect(
      db.query("SELECT * FROM comments WHERE taskId=?").all(t.id),
    ).toHaveLength(0);
    const events = (await c.request("GET", base + "/activity")).events;
    expect(events.map((e) => e.action)).toEqual([
      "task.created",
      "task.created",
      "comment.created",
      "comment.created",
      "comment.deleted",
      "comment.created",
      "comment.deleted",
      "task.updated",
      "task.deleted",
    ]);
    expect(events.at(-1)!.taskTitle).toBe("Renamed");
    expect(events[0].taskTitle).toBe("History");
    await c.request("DELETE", base, undefined, 204);
    for (const table of ["tasks", "members", "activity", "invitations"])
      expect(
        db
          .query(`SELECT * FROM ${table} WHERE projectId=?`)
          .all(base.split("/").at(-1)!),
      ).toHaveLength(0);
    expect(db.query("PRAGMA foreign_key_check").all()).toHaveLength(0);
  });
  test("database reopening preserves sessions, tasks, comments and migration version", async () => {
    mkdirSync(resolve("work"), { recursive: true });
    const dir = mkdtempSync(resolve("work/persistence-"));
    db.close();
    db = openDatabase(resolve(dir, "nested/app.sqlite"));
    app = createApp(db, config);
    try {
      const { owner, base } = await fixture();
      const t = (
        await owner.client.request(
          "POST",
          base + "/tasks",
          { title: "Durable" },
          201,
        )
      ).task;
      await owner.client.request(
        "POST",
        base + "/tasks/" + t.id + "/comments",
        { body: "Stored" },
        201,
      );
      db.close();
      db = openDatabase(resolve(dir, "nested/app.sqlite"));
      app = createApp(db, config);
      expect(
        (await owner.client.request("GET", base + "/tasks/" + t.id)).task.title,
      ).toBe("Durable");
      expect(
        (
          await owner.client.request(
            "GET",
            base + "/tasks/" + t.id + "/comments",
          )
        ).comments[0].body,
      ).toBe("Stored");
      expect(db.query("SELECT * FROM migrations").all()).toHaveLength(1);
    } finally {
      db.close();
      db = openDatabase(":memory:");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
