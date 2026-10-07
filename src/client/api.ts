import { useEffect, useState } from "react";
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  url: string,
  method = "GET",
  data?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch("/api" + url, {
    method,
    credentials: "same-origin",
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal,
  });
  if (response.status === 204) return undefined as T;
  const result = await response.json();
  if (!response.ok) {
    if (
      response.status === 401 &&
      !["/auth/login", "/auth/register", "/auth/me"].includes(url) &&
      !(
        url === "/auth/password" && result.error === "Invalid email or password"
      )
    )
      window.dispatchEvent(new Event("session-expired"));
    throw new ApiError(result.error ?? "Request failed", response.status);
  }
  return result as T;
}
export function useResource<T>(url: string, version = 0) {
  const [state, setState] = useState<{
    data?: T;
    error?: string;
    loading: boolean;
  }>({ loading: true });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true });
    api<T>(url, "GET", undefined, controller.signal)
      .then((data) => setState({ data, loading: false }))
      .catch((error: Error) => {
        if (!controller.signal.aborted)
          setState({ error: error.message, loading: false });
      });
    return () => controller.abort();
  }, [url, version, retry]);
  return { ...state, reload: () => setRetry((n) => n + 1) };
}
export function useAction() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return {
    busy,
    error,
    run: async (action: () => Promise<void>) => {
      if (busy) return;
      setBusy(true);
      setError("");
      try {
        await action();
      } catch (error) {
        setError(
          error instanceof Error
            ? error.message
            : "Something went wrong. Please try again.",
        );
      } finally {
        setBusy(false);
      }
    },
  };
}
export function go(path: string) {
  window.location.hash = path;
  window.scrollTo(0, 0);
}
