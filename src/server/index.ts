import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createApp } from "./app";
import { readConfig } from "./config";
import { openDatabase } from "./db";

const config = readConfig();
const db = openDatabase(config.databasePath);
const app = createApp(db, config);
const dist = resolve("dist");
if (!(await Bun.file(resolve(dist, "index.html")).exists()))
  throw new Error(
    "Built frontend missing. Run bun run build before start (or before API development).",
  );
// Register static handling after API routes; unknown API paths always remain JSON.
app.get("*", async (c) => {
  if (c.req.path === "/api" || c.req.path.startsWith("/api/"))
    return c.json({ error: "Resource not found" }, 404);
  let pathname: string;
  try {
    pathname = decodeURIComponent(c.req.path);
  } catch {
    return c.text("Invalid path", 400);
  }
  const path = resolve(dist, "." + pathname);
  if (!path.startsWith(dist + "/") && path !== dist)
    return c.text("Not found", 404);
  const file = Bun.file(path);
  if (
    path !== dist &&
    (await stat(path)
      .then((info) => info.isFile())
      .catch(() => false))
  ) {
    c.header(
      "Cache-Control",
      pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    );
    return new Response(file, { headers: c.res.headers });
  }
  if (pathname.startsWith("/assets/")) return c.text("Not found", 404);
  c.header("Cache-Control", "no-cache");
  return new Response(Bun.file(resolve(dist, "index.html")), {
    headers: c.res.headers,
  });
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: config.port,
  // Hono enforces the 64 KiB cap before parsing, including streamed bodies.
  // Let it produce the contract-required JSON 400 instead of Bun's plain 413.
  maxRequestBodySize: Number.MAX_SAFE_INTEGER,
  fetch: (req, server) =>
    app.fetch(req, { ip: server.requestIP(req)?.address ?? "local" }),
});
console.log(`TaskForge listening on 127.0.0.1:${server.port}`);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    void server.stop(true);
    db.close();
    process.exit(0);
  });
