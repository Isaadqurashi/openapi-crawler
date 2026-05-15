import axios, { AxiosError, AxiosResponse } from "axios";
import { config } from "../config";
import logger from "../logger";

export interface FetchOptions {
  /** Previous ETag — sent as If-None-Match for conditional fetches. */
  etag?: string | null;
  /** Previous Last-Modified value — sent as If-Modified-Since. */
  lastModified?: string | null;
  /** Override max retries; defaults to config.maxRetries. */
  maxRetries?: number;
}

export type FetchResult =
  | {
      status: "ok";
      body: string;
      etag: string | null;
      lastModified: string | null;
      finalUrl: string;
    }
  | {
      status: "not_modified";
      etag: string | null;
      lastModified: string | null;
    }
  | {
      status: "failed";
      error: string;
      httpStatus?: number;
    };

/**
 * Sleep for `ms` milliseconds. Centralized so tests can mock it if needed.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determine if an error response should be retried. We retry on:
 *  - Network errors (no response)
 *  - 5xx server errors
 *  - 429 Too Many Requests
 *  - 403 (often a secondary GitHub rate-limit signal)
 *
 * We do NOT retry on 4xx other than the above — those are deterministic
 * client errors (404, 401, etc.) where retrying just wastes quota.
 */
function isRetryable(err: AxiosError): boolean {
  if (!err.response) return true; // network / timeout
  const code = err.response.status;
  return code === 429 || code === 403 || (code >= 500 && code < 600);
}

/**
 * Compute backoff delay. We honor Retry-After when GitHub sends it, otherwise
 * we use exponential backoff: 1s → 2s → 4s … (capped at 30s).
 */
function computeBackoff(attempt: number, err: AxiosError): number {
  const retryAfterHeader = err.response?.headers?.["retry-after"];
  if (retryAfterHeader) {
    const seconds = Number.parseInt(String(retryAfterHeader), 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, 60_000);
    }
  }
  return Math.min(1000 * 2 ** attempt, 30_000);
}

/**
 * Download a single spec file. Supports ETag / Last-Modified for incremental
 * fetches; a 304 returns `status: "not_modified"` so callers can skip parsing.
 *
 * After `maxRetries` failures we return `status: "failed"`. The caller is
 * responsible for translating that into a "stale" catalog entry.
 */
export async function fetchSpec(
  url: string,
  options: FetchOptions = {}
): Promise<FetchResult> {
  const maxRetries = options.maxRetries ?? config.maxRetries;
  const headers: Record<string, string> = {
    "User-Agent": "openapi-crawler/1.0",
    Accept: "text/plain, application/json, application/yaml, */*"
  };
  if (options.etag) headers["If-None-Match"] = options.etag;
  if (options.lastModified) headers["If-Modified-Since"] = options.lastModified;

  let lastError: AxiosError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response: AxiosResponse<string> = await axios.get(url, {
        headers,
        timeout: config.requestTimeoutMs,
        // Treat 304 as a non-error so axios doesn't throw on it.
        validateStatus: (s) => (s >= 200 && s < 300) || s === 304,
        // We want the raw text — yaml/json detection happens in parser.
        responseType: "text",
        transformResponse: [(data) => data]
      });

      const etag = (response.headers["etag"] as string) || null;
      const lastModified =
        (response.headers["last-modified"] as string) || null;

      if (response.status === 304) {
        return { status: "not_modified", etag, lastModified };
      }

      return {
        status: "ok",
        body: response.data,
        etag,
        lastModified,
        finalUrl: response.request?.res?.responseUrl || url
      };
    } catch (err) {
      const axiosErr = err as AxiosError;
      lastError = axiosErr;
      const status = axiosErr.response?.status;

      if (attempt < maxRetries && isRetryable(axiosErr)) {
        const delay = computeBackoff(attempt, axiosErr);
        logger.warn("fetch retry", {
          url,
          attempt: attempt + 1,
          maxRetries,
          httpStatus: status,
          delayMs: delay
        });
        await sleep(delay);
        continue;
      }
      break;
    }
  }

  return {
    status: "failed",
    error: lastError?.message ?? "unknown error",
    httpStatus: lastError?.response?.status
  };
}

export default fetchSpec;
