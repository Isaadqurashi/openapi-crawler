import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config();

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  githubToken: string | undefined;
  maxSpecs: number;
  pollIntervalMs: number;
  maxRetries: number;
  /** Consecutive failed update/crawl fetches before marking an entry stale. */
  staleAfterRetries: number;
  catalogPath: string;
  logLevel: LogLevel;
  seedRepos: string[];
  /** Minimum delay between GitHub requests in milliseconds (rate-limit courtesy). */
  requestDelayMs: number;
  /** Per-request HTTP timeout in milliseconds. */
  requestTimeoutMs: number;
}

/**
 * Parse a positive integer from an env string, falling back to `fallback`
 * when the value is missing, empty, or invalid.
 */
function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseLogLevel(value: string | undefined): LogLevel {
  const allowed: LogLevel[] = ["debug", "info", "warn", "error"];
  if (value && (allowed as string[]).includes(value)) {
    return value as LogLevel;
  }
  return "info";
}

function parseSeedRepos(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /^[^/\s]+\/[^/\s]+$/.test(s));
}

/**
 * GITHUB_TOKEN is treated as optional but heavily encouraged. The token bumps
 * the search-API quota from 10 to 30 req/min and avoids cold rate limits.
 */
export const config: Config = {
  githubToken: process.env.GITHUB_TOKEN || undefined,
  maxSpecs: parseIntEnv(process.env.MAX_SPECS, 50),
  pollIntervalMs: parseIntEnv(process.env.POLL_INTERVAL_MS, 86_400_000),
  maxRetries: parseIntEnv(process.env.MAX_RETRIES, 3),
  staleAfterRetries: parseIntEnv(
    process.env.STALE_AFTER_RETRIES,
    parseIntEnv(process.env.MAX_RETRIES, 3)
  ),
  catalogPath: path.resolve(
    process.cwd(),
    process.env.CATALOG_PATH || "data/catalog.json"
  ),
  logLevel: parseLogLevel(process.env.LOG_LEVEL),
  seedRepos: parseSeedRepos(process.env.SEED_REPOS),
  // 1 req/s without token (per GitHub guidelines), 200ms with token.
  requestDelayMs: process.env.GITHUB_TOKEN ? 200 : 1000,
  requestTimeoutMs: 10_000
};

export default config;
