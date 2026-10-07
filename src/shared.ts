export type Role = "owner" | "editor" | "viewer";
export type Status = "todo" | "in_progress" | "done";
export type Priority = "low" | "medium" | "high";
export interface User {
  id: string;
  name: string;
  email: string;
}
export interface Project {
  id: string;
  name: string;
  role: Role;
}
export interface Member extends User {
  role: Role;
}
export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  assigneeId: string | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Comment {
  id: string;
  body: string;
  authorId: string;
  authorName: string;
  createdAt: string;
}
export interface Activity {
  id: string;
  action: string;
  actorId: string;
  actorName: string;
  createdAt: string;
  taskTitle: string;
}
