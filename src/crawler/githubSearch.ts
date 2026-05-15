import axios, { AxiosError } from "axios";
import { config } from "../config";
import type { Logger } from "../logger";

export interface DiscoveredSpec {
  /** "github:{owner}/{repo}/{path}" — stable across runs. */
  id: string;
  /** Raw download URL on raw.githubusercontent.com */
  source_url: string;
  owner: string;
  repo: string;
  path: string;
  branch: string;
}

interface GithubCodeItem {
  name: string;
  path: string;
  html_url: string;
  repository: {
    name: string;
    full_name: string;
    default_branch?: string;
    owner: { login: string };
  };
}

interface GithubCodeSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: GithubCodeItem[];
}

interface GithubRepoResponse {
  default_branch: string;
}

interface GithubContentItem {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  download_url: string | null;
  url: string;
}

const SEARCH_FILENAMES = [
  "openapi.yaml",
  "openapi.json",
  "swagger.yaml",
  "swagger.json"
];

const SPEC_FILENAME_PATTERN = /^(openapi|swagger)\.(ya?ml|json)$/i;

const GITHUB_API = "https://api.github.com";
const GITHUB_RAW = "https://raw.githubusercontent.com";
const PER_PAGE = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "openapi-crawler/1.0"
  };
  if (config.githubToken) {
    headers.Authorization = `Bearer ${config.githubToken}`;
  }
  return headers;
}

/**
 * Convert a github.com blob URL into a raw.githubusercontent.com URL.
 *
 * Input:  https://github.com/stripe/openapi/blob/master/openapi/spec3.yaml
 * Output: https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.yaml
 *
 * Returns null if the URL doesn't match the expected pattern, so callers
 * can skip malformed search results instead of poisoning the catalog.
 */
export function htmlUrlToRawUrl(htmlUrl: string): string | null {
  const match = htmlUrl.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/
  );
  if (!match) return null;
  const [, owner, repo, branch, filepath] = match;
  return `${GITHUB_RAW}/${owner}/${repo}/${branch}/${filepath}`;
}

function buildId(owner: string, repo: string, filepath: string): string {
  return `github:${owner}/${repo}/${filepath}`;
}

/**
 * Centralized GitHub request helper. Handles:
 *  - Auth + UA headers
 *  - 403/429 rate-limit responses (waits using X-RateLimit-Reset or backoff)
 *  - A polite delay between successive calls
 *  - Bounded retries
 */
async function githubGet<T>(
  url: string,
  logger: Logger,
  params?: Record<string, string | number>
): Promise<T | null> {
  const maxAttempts = config.maxRetries + 1;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      const response = await axios.get<T>(url, {
        headers: authHeaders(),
        params,
        timeout: config.requestTimeoutMs,
        validateStatus: (s) => s >= 200 && s < 300
      });
      // Courtesy delay so we don't burn through the per-minute search budget
      // — applied AFTER a successful call so a fresh run can start quickly.
      await sleep(config.requestDelayMs);
      return response.data;
    } catch (err) {
      const ax = err as AxiosError;
      const status = ax.response?.status;

      if (status === 404) {
        logger.debug("github 404", { url });
        return null;
      }

      // Primary or secondary rate limit. GitHub signals both via 403/429.
      if (status === 403 || status === 429) {
        const reset = ax.response?.headers?.["x-ratelimit-reset"];
        const retryAfter = ax.response?.headers?.["retry-after"];
        let waitMs = Math.min(2 ** attempt * 1000, 30_000);
        if (retryAfter) {
          const s = Number.parseInt(String(retryAfter), 10);
          if (Number.isFinite(s) && s > 0) waitMs = Math.min(s * 1000, 60_000);
        } else if (reset) {
          const resetMs = Number.parseInt(String(reset), 10) * 1000 - Date.now();
          if (resetMs > 0) waitMs = Math.min(resetMs + 1000, 90_000);
        }
        logger.warn("github rate limited", {
          url,
          attempt,
          waitMs,
          httpStatus: status
        });
        if (attempt >= maxAttempts) return null;
        await sleep(waitMs);
        continue;
      }

      // 5xx → backoff and retry. 4xx (other than above) → give up.
      if (status && status >= 500 && status < 600 && attempt < maxAttempts) {
        const waitMs = Math.min(2 ** attempt * 1000, 30_000);
        logger.warn("github 5xx, retrying", { url, attempt, waitMs, httpStatus: status });
        await sleep(waitMs);
        continue;
      }

      if (!status && attempt < maxAttempts) {
        // Network/timeout — retry.
        const waitMs = Math.min(2 ** attempt * 1000, 30_000);
        logger.warn("github network error, retrying", {
          url,
          attempt,
          waitMs,
          error: ax.message
        });
        await sleep(waitMs);
        continue;
      }

      logger.error("github request failed", {
        url,
        httpStatus: status,
        error: ax.message
      });
      return null;
    }
  }
  return null;
}

/**
 * Run GitHub Code Search for a single filename. Paginates until either we
 * exhaust results or hit `limit`. The API caps search results to 1000 items
 * regardless of `total_count`, so we don't try to be cleverer than that.
 */
async function searchByFilename(
  filename: string,
  limit: number,
  logger: Logger
): Promise<DiscoveredSpec[]> {
  const collected: DiscoveredSpec[] = [];
  let page = 1;

  while (collected.length < limit) {
    const data = await githubGet<GithubCodeSearchResponse>(
      `${GITHUB_API}/search/code`,
      logger,
      { q: `filename:${filename}`, per_page: PER_PAGE, page }
    );
    if (!data || !data.items || data.items.length === 0) break;

    for (const item of data.items) {
      if (collected.length >= limit) break;

      // GitHub's `filename:` qualifier does substring matching, so a query
      // for `openapi.yaml` also returns `openapi.yaml.j2`, `openapi.yaml.tmpl`,
      // `openapi.yamlx`, etc. Those are template/generator files, not specs.
      // Filter to the canonical filename only (case-insensitive).
      if (item.name.toLowerCase() !== filename.toLowerCase()) {
        logger.debug("skipping non-canonical filename match", {
          got: item.name,
          want: filename
        });
        continue;
      }

      const raw = htmlUrlToRawUrl(item.html_url);
      if (!raw) continue;
      const owner = item.repository.owner.login;
      const repo = item.repository.name;
      const filepath = item.path;
      const id = buildId(owner, repo, filepath);
      // Extract branch from the URL we just built (4th path segment).
      const branchMatch = raw.match(
        new RegExp(`^${GITHUB_RAW}/${owner}/${repo}/([^/]+)/`)
      );
      const branch = branchMatch?.[1] ?? "HEAD";

      collected.push({
        id,
        source_url: raw,
        owner,
        repo,
        path: filepath,
        branch
      });
      logger.info("discovered spec", { id, source_url: raw, via: "search" });
    }

    if (data.items.length < PER_PAGE) break;
    page++;
  }

  return collected;
}

/**
 * Recursively walk a seed repo's contents (depth-limited) and collect any
 * files whose name matches SPEC_FILENAME_PATTERN. We resolve the repo's
 * default branch first so the resulting raw URLs survive default-branch
 * renames (e.g. master → main).
 *
 * Depth limit guards against monorepos like azure-rest-api-specs which
 * have thousands of nested directories. The crawl-level MAX_SPECS cap is
 * still the hard stop.
 */
async function discoverInRepo(
  ownerRepo: string,
  limit: number,
  logger: Logger,
  maxDepth = 6
): Promise<DiscoveredSpec[]> {
  const [owner, repo] = ownerRepo.split("/");
  if (!owner || !repo) return [];

  const meta = await githubGet<GithubRepoResponse>(
    `${GITHUB_API}/repos/${owner}/${repo}`,
    logger
  );
  if (!meta) return [];
  const branch = meta.default_branch;

  const results: DiscoveredSpec[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: "", depth: 0 }];

  while (queue.length > 0 && results.length < limit) {
    const { path: dir, depth } = queue.shift()!;
    const url = dir
      ? `${GITHUB_API}/repos/${owner}/${repo}/contents/${dir}`
      : `${GITHUB_API}/repos/${owner}/${repo}/contents`;

    const contents = await githubGet<GithubContentItem[]>(url, logger, {
      ref: branch
    });
    if (!contents || !Array.isArray(contents)) continue;

    for (const item of contents) {
      if (results.length >= limit) break;
      if (item.type === "file" && SPEC_FILENAME_PATTERN.test(item.name)) {
        const rawUrl = `${GITHUB_RAW}/${owner}/${repo}/${branch}/${item.path}`;
        const spec: DiscoveredSpec = {
          id: buildId(owner, repo, item.path),
          source_url: rawUrl,
          owner,
          repo,
          path: item.path,
          branch
        };
        results.push(spec);
        logger.info("discovered spec", {
          id: spec.id,
          source_url: spec.source_url,
          via: "seed"
        });
      } else if (item.type === "dir" && depth < maxDepth) {
        queue.push({ path: item.path, depth: depth + 1 });
      }
    }
  }

  return results;
}

/**
 * Main discovery entry point. Strategy:
 *
 *   1. Run code search across all four canonical filenames. Stop early
 *      once we've collected `maxSpecs` deduplicated results.
 *   2. If search yielded fewer than `maxSpecs` (rate limited, sparse,
 *      or no token), top up from the configured seed repos.
 *
 * Deduplication is by catalog `id` so we don't process the same path
 * twice even if both the .yaml and .json discovery happen to find it.
 */
export async function discoverSpecs(
  logger: Logger,
  maxSpecs: number = config.maxSpecs
): Promise<DiscoveredSpec[]> {
  const seen = new Set<string>();
  const collected: DiscoveredSpec[] = [];

  for (const filename of SEARCH_FILENAMES) {
    if (collected.length >= maxSpecs) break;
    const remaining = maxSpecs - collected.length;
    try {
      const batch = await searchByFilename(filename, remaining, logger);
      for (const item of batch) {
        if (collected.length >= maxSpecs) break;
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        collected.push(item);
      }
    } catch (err) {
      logger.warn("search batch failed, continuing", {
        filename,
        error: (err as Error).message
      });
    }
  }

  if (collected.length < maxSpecs && config.seedRepos.length > 0) {
    logger.info("topping up from seed repos", {
      currentCount: collected.length,
      seedRepoCount: config.seedRepos.length
    });
    for (const seed of config.seedRepos) {
      if (collected.length >= maxSpecs) break;
      const remaining = maxSpecs - collected.length;
      const batch = await discoverInRepo(seed, remaining, logger);
      for (const item of batch) {
        if (collected.length >= maxSpecs) break;
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        collected.push(item);
      }
    }
  }

  logger.info("discovery complete", { total: collected.length });
  return collected;
}
