import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
export const fail = (
  status: 400 | 401 | 403 | 404 | 409 | 429,
  message: string,
): never => {
  throw new HTTPException(status, { message });
};
export async function body(c: Context, keys: string[]) {
  let data: unknown;
  try {
    data = await c.req.json();
  } catch {
    return fail(400, "Malformed JSON body");
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    return fail(400, "Expected a JSON object");
  const obj = data as Record<string, unknown>;
  if (Object.keys(obj).some((key) => !keys.includes(key)))
    fail(400, "Unknown field in request");
  return obj;
}
export function text(
  value: unknown,
  label: string,
  min: number,
  max: number,
  trim = true,
): string {
  if (typeof value !== "string") return fail(400, `${label} must be text`);
  const result = trim ? value.trim() : value;
  if (result.length < min || result.length > max)
    fail(400, `${label} must be ${min}–${max} characters`);
  return result;
}
export function email(value: unknown) {
  const result = text(value, "Email", 3, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result))
    fail(400, "Enter a valid email address");
  return result;
}
export function choice<T extends string>(
  value: unknown,
  options: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !options.includes(value as T))
    return fail(400, `Invalid ${label}`);
  return value as T;
}
export function dueDate(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    return fail(400, "Due date must be a real date in YYYY-MM-DD format");
  return value;
}
export function positive(
  value: string | undefined,
  fallback: number,
  max: number,
) {
  if (value === undefined) return fallback;
  if (
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > max
  )
    return fail(
      400,
      "Pagination must use positive integers; pageSize cannot exceed 100",
    );
  return Number(value);
}
