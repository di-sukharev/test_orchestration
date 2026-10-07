import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const databasePath = process.env.DATABASE_PATH ?? './data/taskforge.sqlite';
if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });

export const db = new Database(databasePath, { create: true, strict: true });
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
`);

const applied = db.query('SELECT version FROM schema_migrations WHERE version = 1').get();
if (!applied) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        session_version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX sessions_user_idx ON sessions(user_id);
      CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE memberships (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('editor','viewer')),
        created_at TEXT NOT NULL,
        PRIMARY KEY(project_id,user_id)
      );
      CREATE TRIGGER prevent_owner_membership BEFORE INSERT ON memberships
      WHEN NEW.user_id=(SELECT owner_user_id FROM projects WHERE id=NEW.project_id)
      BEGIN SELECT RAISE(ABORT,'project owner is represented by projects.owner_user_id'); END;
      CREATE INDEX memberships_user_idx ON memberships(user_id,project_id);
      CREATE TABLE invitations (
        token_hash TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('editor','viewer')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      );
      CREATE INDEX invitations_project_idx ON invitations(project_id);
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
        description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 10000),
        status TEXT NOT NULL CHECK(status IN ('todo','in_progress','done')),
        priority TEXT NOT NULL CHECK(priority IN ('low','medium','high')),
        assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        due_date TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX tasks_project_order_idx ON tasks(project_id,created_at DESC,id DESC);
      CREATE INDEX tasks_project_status_idx ON tasks(project_id,status);
      CREATE INDEX tasks_project_priority_idx ON tasks(project_id,priority);
      CREATE INDEX tasks_assignee_idx ON tasks(project_id,assignee_id);
      CREATE TABLE comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        author_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
        created_at TEXT NOT NULL
      );
      CREATE INDEX comments_task_order_idx ON comments(task_id,created_at,id);
      CREATE TABLE activity (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        action TEXT NOT NULL,
        task_id TEXT,
        task_title TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX activity_project_order_idx ON activity(project_id,created_at DESC,id DESC);
      INSERT INTO schema_migrations(version,applied_at) VALUES (1,datetime('now'));
    `);
  })();
}

export function now(): string {
  return new Date().toISOString();
}

export function id(): string {
  return crypto.randomUUID();
}

export function token(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export type User = { id: string; name: string; email: string };
export type Role = 'owner' | 'editor' | 'viewer';
export type Project = { id: string; name: string; owner_user_id: string; created_at: string };
export type Task = {
  id: string; project_id: string; title: string; description: string; status: string;
  priority: string; assignee_id: string | null; due_date: string | null; created_at: string; updated_at: string;
};

export function publicUser(user: User): User {
  return { id: user.id, name: user.name, email: user.email };
}

export function projectFor(userId: string, projectId: string): { project: Project; role: Role } | null {
  const project = db.query('SELECT * FROM projects WHERE id=?').get(projectId) as Project | null;
  if (!project) return null;
  if (project.owner_user_id === userId) return { project, role: 'owner' };
  const member = db.query('SELECT role FROM memberships WHERE project_id=? AND user_id=?').get(projectId, userId) as { role: 'editor' | 'viewer' } | null;
  return member ? { project, role: member.role } : null;
}
