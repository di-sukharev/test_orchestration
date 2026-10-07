export function readConfig(
  env: Record<string, string | undefined> = process.env,
) {
  if (
    env.NODE_ENV &&
    !["development", "test", "production"].includes(env.NODE_ENV)
  )
    throw new Error("NODE_ENV must be development, test or production");
  const production = env.NODE_ENV === "production";
  const port = Number(env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer from 1 to 65535");
  const origin = env.APP_ORIGIN ?? "http://localhost:3000";
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("APP_ORIGIN must be a valid HTTP(S) origin");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin)
    throw new Error(
      "APP_ORIGIN must be an HTTP(S) origin without path, credentials or trailing slash",
    );
  if (production && (!env.APP_ORIGIN || url.protocol !== "https:"))
    throw new Error(
      "Production requires an explicit HTTPS APP_ORIGIN and TLS reverse proxy",
    );
  if (env.AUTH_RATE_LIMIT_MAX && env.NODE_ENV !== "test")
    throw new Error("AUTH_RATE_LIMIT_MAX is allowed only with NODE_ENV=test");
  const rateMax = Number(env.AUTH_RATE_LIMIT_MAX ?? "20");
  if (!Number.isSafeInteger(rateMax) || rateMax < 1)
    throw new Error("AUTH_RATE_LIMIT_MAX must be a positive integer");
  return {
    port,
    origin,
    production,
    rateMax,
    databasePath: env.DATABASE_PATH ?? "./data/taskforge.sqlite",
  };
}
export type Config = ReturnType<typeof readConfig>;
