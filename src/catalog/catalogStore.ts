import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { config } from "../config";
import type { HistoryEntry } from "../versioner/versioner";

export type CatalogStatus = "active" | "stale" | "invalid";

export interface CatalogEntry { // hire me :)
  id: string;
  source_url: string;
  title: string;
  oas_version: string;
  latest_version: string;
  description: string;
  paths_count: number;
  tags: string[];
  servers: string[];
  fetched_at: string;
  status: CatalogStatus;
  etag: string | null;
  last_modified: string | null;
  content_hash: string;
  /** Consecutive fetch failures; reset to 0 on a successful fetch. */
  retry_count: number;
  history: HistoryEntry[];
}

export type Catalog = CatalogEntry[];

/**
 * Load the catalog from disk. Returns an empty array when the file doesn't
 * exist (first run) or is unreadable. We deliberately swallow read errors
 * because a missing file is the normal startup state — anything more
 * dramatic would block the very first crawl.
 *
 * Corrupted JSON is treated differently: we throw so the operator notices
 * (silent recovery would discard real history).
 */
export async function loadCatalog(
  catalogPath: string = config.catalogPath
): Promise<Catalog> {
  try {
    const data = await fsp.readFile(catalogPath, "utf8");
    if (!data.trim()) return [];
    const parsed = JSON.parse(data) as Catalog;
    if (!Array.isArray(parsed)) {
      throw new Error(`catalog at ${catalogPath} is not a JSON array`);
    }
    return parsed;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Atomic write. Write into a sibling .tmp file, fsync if possible, then
 * rename. Rename is atomic on POSIX, so a reader either sees the old file
 * or the new one — never a half-written truncation.
 */
export async function saveCatalog(
  catalog: Catalog,
  catalogPath: string = config.catalogPath
): Promise<void> {
  const dir = path.dirname(catalogPath);
  await fsp.mkdir(dir, { recursive: true });

  const tmp = `${catalogPath}.${process.pid}.tmp`;
  const serialized = JSON.stringify(catalog, null, 2) + "\n";

  // Use open+writeFile+close pattern so we can fsync and avoid partial writes.
  const handle = await fsp.open(tmp, "w");
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, catalogPath);
}

/**
 * Synchronous helpers — handy for tests and small CLI commands like
 * `catalog`. The async versions remain the default for the crawl flow.
 */
export function loadCatalogSync(
  catalogPath: string = config.catalogPath
): Catalog {
  try {
    if (!fs.existsSync(catalogPath)) return [];
    const data = fs.readFileSync(catalogPath, "utf8");
    if (!data.trim()) return [];
    const parsed = JSON.parse(data) as Catalog;
    if (!Array.isArray(parsed)) {
      throw new Error(`catalog at ${catalogPath} is not a JSON array`);
    }
    return parsed;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Upsert: replace the entry with matching id, or append. Critically, we
 * preserve the existing `history` array — callers append a new entry to
 * `incoming.history` themselves before calling upsert, so this function
 * stays a thin write helper rather than baking in version policy.
 *
 * Returns a NEW catalog array (immutable update) to keep call sites
 * predictable in tests.
 */
export function upsertEntry(
  catalog: Catalog,
  incoming: CatalogEntry
): Catalog {
  const idx = catalog.findIndex((e) => e.id === incoming.id);
  if (idx === -1) {
    return [...catalog, incoming];
  }
  const next = catalog.slice();
  next[idx] = incoming;
  return next;
}

/**
 * Convenience: find an entry by id without scanning the whole array twice
 * at every caller. Returns null when absent.
 */
export function findEntry(
  catalog: Catalog,
  id: string
): CatalogEntry | null {
  return catalog.find((e) => e.id === id) ?? null;
}

/**
 * Find a catalog entry with the same content hash. Invalid entries are
 * excluded so a previously-broken spec can be re-ingested under a new id.
 */
export function findEntryByContentHash(
  catalog: Catalog,
  contentHash: string
): CatalogEntry | null {
  return (
    catalog.find(
      (e) => e.content_hash === contentHash && e.status !== "invalid"
    ) ?? null
  );
}

/**
 * Apply one failed fetch to an entry: increment retry_count and mark stale
 * only after `staleAfterRetries` consecutive failures.
 */
export function applyFetchFailure(
  entry: CatalogEntry,
  staleAfterRetries: number
): CatalogEntry {
  const retry_count = (entry.retry_count ?? 0) + 1;
  return {
    ...entry,
    retry_count,
    status: retry_count >= staleAfterRetries ? "stale" : entry.status,
    fetched_at: new Date().toISOString()
  };
}

/**
 * Clear retry state after a successful fetch.
 */
export function applyFetchSuccess(
  entry: CatalogEntry,
  overrides: Partial<CatalogEntry> = {}
): CatalogEntry {
  return {
    ...entry,
    ...overrides,
    retry_count: 0,
    status: "active",
    fetched_at: overrides.fetched_at ?? new Date().toISOString()
  };
}
