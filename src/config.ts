import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config();

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  githubToken: string | undefined;
  maxSpecs: number;
  pollIntervalMs: number;
  pollIntervalHours: number;
  maxRetries: number;
  staleAfterRetries: number;
  catalogPath: string;
  seedsPath: string;
  logLevel: LogLevel;
  seedRepos: string[];
  /** Minimum delay between GitHub API requests (ms). Task default: 2s. */
  githubRequestDelayMs: number;
  requestTimeoutMs: number;
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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

const pollIntervalHours = parseIntEnv(process.env.POLL_INTERVAL_HOURS, 24);

export const config: Config = {
  githubToken: process.env.GITHUB_TOKEN || undefined,
  maxSpecs: parseIntEnv(process.env.MAX_SPECS, 80),
  pollIntervalHours,
  pollIntervalMs:
    parseIntEnv(process.env.POLL_INTERVAL_MS, 0) ||
    pollIntervalHours * 3_600_000,
  maxRetries: parseIntEnv(process.env.MAX_RETRIES, 3),
  staleAfterRetries: parseIntEnv(
    process.env.STALE_AFTER_RETRIES,
    parseIntEnv(process.env.MAX_RETRIES, 3)
  ),
  catalogPath: path.resolve(
    process.cwd(),
    process.env.CATALOG_PATH || "catalog.json"
  ),
  seedsPath: path.resolve(
    process.cwd(),
    process.env.SEEDS_PATH || "seeds.json"
  ),
  logLevel: parseLogLevel(process.env.LOG_LEVEL),
  seedRepos: parseSeedRepos(process.env.SEED_REPOS),
  githubRequestDelayMs: parseIntEnv(
    process.env.GITHUB_REQUEST_DELAY_MS,
    2000
  ),
  requestTimeoutMs: 15_000
};

export default config;
