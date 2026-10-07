import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDatabase(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec(
    "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
  );
  db.transaction(() => {
    db.exec(
      `CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL);`,
    );
    if (db.query("SELECT version FROM migrations WHERE version=1").get())
      return;
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, passwordHash TEXT NOT NULL);
      CREATE TABLE sessions (tokenHash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expiresAt INTEGER NOT NULL);
      CREATE INDEX sessions_user ON sessions(userId);
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE members (projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, userId TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')), PRIMARY KEY(projectId,userId));
      CREATE UNIQUE INDEX one_owner ON members(projectId) WHERE role='owner';
      CREATE INDEX members_user ON members(userId);
      CREATE TABLE invitations (tokenHash TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('editor','viewer')), expiresAt INTEGER NOT NULL, acceptedAt TEXT);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('todo','in_progress','done')), priority TEXT NOT NULL CHECK(priority IN ('low','medium','high')), assigneeId TEXT REFERENCES users(id), dueDate TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, searchTitle TEXT NOT NULL, searchDescription TEXT NOT NULL);
      CREATE INDEX tasks_project ON tasks(projectId,createdAt,id);
      CREATE TABLE comments (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, authorId TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE INDEX comments_task ON comments(taskId,createdAt,id);
      CREATE TABLE activity (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, taskTitle TEXT NOT NULL, action TEXT NOT NULL, actorId TEXT NOT NULL REFERENCES users(id), createdAt TEXT NOT NULL);
      CREATE INDEX activity_project ON activity(projectId,seq);
    `);
    db.query("INSERT INTO migrations VALUES (1,?)").run(
      new Date().toISOString(),
    );
  })();
  return db;
}
