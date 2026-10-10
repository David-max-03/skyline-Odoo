"use client";

import { useCallback, useEffect, useState } from "react";
import type { ApiErrorBody } from "./contracts";

/**
 * The only way UI code talks to the server.
 *
 *   const events = await api<EventSummary[]>("/api/events");
 *   await api("/api/events", { method: "POST", body: input });
 *   const { data, error, loading, reload } = useApi<Dashboard>("/api/dashboard");
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Send a multipart form instead of JSON, for requests that carry a file. */
  form?: FormData;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      // For a form the browser sets the multipart content type and boundary itself.
      headers: options.form || options.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
    });
  } catch {
    throw new ApiError(0, "network", "Could not reach the server. Check your connection and try again.");
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // fall through to the generic error below
  }

  if (!response.ok) {
    const error = (payload as ApiErrorBody | null)?.error;
    // A staff or member page whose session has ended goes back to sign-in.
    if (
      response.status === 401 &&
      typeof window !== "undefined" &&
      /^\/(org|member)(\/|$)/.test(window.location.pathname)
    ) {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      // A full page load on purpose: it drops all client state held for the old session.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(`/login?next=${next}`);
    }
    throw new ApiError(
      response.status,
      error?.code ?? "unknown",
      error?.message ?? `The server returned an error (${response.status}).`,
      error?.fields ?? {},
    );
  }
  return (payload as { data: T }).data;
}

/** Turns anything thrown into a message fit to show a person. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "Something went wrong. Please try again.";
}

export function fieldErrors(error: unknown): Record<string, string> {
  return error instanceof ApiError ? error.fields : {};
}

interface Loaded<T> {
  key: string;
  path: string;
  data: T | null;
  error: ApiError | null;
}

export interface ApiState<T> {
  data: T | null;
  error: ApiError | null;
  /** True for the first load and for every reload. */
  loading: boolean;
  reload: () => void;
}

/**
 * Loads `path` and keeps the result. Pass null to skip. While reloading, the
 * previous data stays visible so screens do not flash empty.
 */
export function useApi<T>(path: string | null): ApiState<T> {
  const [tick, setTick] = useState(0);
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null);
  const key = path === null ? null : `${path}#${tick}`;

  useEffect(() => {
    if (path === null || key === null) return;
    const controller = new AbortController();
    api<T>(path, { signal: controller.signal }).then(
      (data) => setLoaded({ key, path, data, error: null }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const apiError =
          error instanceof ApiError ? error : new ApiError(0, "unknown", "Something went wrong.");
        setLoaded((previous) => ({
          key,
          path,
          data: previous?.path === path ? previous.data : null,
          error: apiError,
        }));
      },
    );
    return () => controller.abort();
  }, [path, key]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const current = loaded && loaded.path === path ? loaded : null;
  return {
    data: current?.data ?? null,
    error: current?.key === key ? current.error : null,
    loading: key !== null && current?.key !== key,
    reload,
  };
}
