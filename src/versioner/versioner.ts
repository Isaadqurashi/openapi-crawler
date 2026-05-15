import { createHash } from "crypto";
import type { ParsedSpec } from "../parser/specParser";

export interface HistoryEntry {
  version: string;
  hash: string;
  paths_delta: number;
  recorded_at: string;
}

export interface ExistingState {
  content_hash?: string | null;
  latest_version?: string | null;
  paths_count?: number | null;
  history?: HistoryEntry[];
}

export interface VersionDiff {
  changed: boolean;
  newHash: string;
  /** History entry to append. undefined when changed === false. */
  newHistoryEntry?: HistoryEntry;
  pathsDelta: number;
}

/**
 * SHA-256 over the raw, unparsed bytes. Using the raw text (not the parsed
 * tree) makes the comparison cheap and avoids false equality when two
 * different YAML formattings normalize to the same object.
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Decide whether a freshly fetched spec is a new version of the entry we
 * already have. The "or" here is deliberate:
 *
 *   - hash changed             → contents differ in any way (whitespace,
 *                                comments, real edits) → record it.
 *   - info.version changed     → semantic version bump even with identical
 *                                content (rare but legal) → record it.
 *
 * Returning a ready-to-append `newHistoryEntry` keeps the catalog layer
 * dumb — it just upserts what we give it.
 */
export function detectVersionChange(
  content: string,
  parsed: ParsedSpec,
  existing: ExistingState | null
): VersionDiff {
  const newHash = hashContent(content);
  const oldHash = existing?.content_hash ?? null;
  const oldVersion = existing?.latest_version ?? null;
  const oldPaths = existing?.paths_count ?? 0;

  const hashChanged = oldHash !== null && newHash !== oldHash;
  const versionChanged =
    oldVersion !== null && parsed.version !== "" && parsed.version !== oldVersion;
  const isNewEntry = existing === null || oldHash === null;

  // First time we see this spec OR something differs → record history.
  if (isNewEntry || hashChanged || versionChanged) {
    const pathsDelta = isNewEntry ? parsed.paths_count : parsed.paths_count - oldPaths;
    return {
      changed: true,
      newHash,
      pathsDelta,
      newHistoryEntry: {
        version: parsed.version,
        hash: newHash,
        paths_delta: pathsDelta,
        recorded_at: new Date().toISOString()
      }
    };
  }

  return { changed: false, newHash, pathsDelta: 0 };
}

/**
 * Human-readable summary line for the run report. Defensive about missing
 * fields so a partially populated entry doesn't crash the formatter.
 *
 * Example output:
 *   "Stripe API updated: 2024-04-10 → 2024-06-20 (+8 paths)"
 */
export function formatChangelog(
  title: string,
  oldVersion: string | null | undefined,
  newVersion: string,
  pathsDelta: number
): string {
  const sign = pathsDelta > 0 ? "+" : "";
  const pathFragment =
    pathsDelta === 0 ? "no path change" : `${sign}${pathsDelta} paths`;
  const safeOld = oldVersion ?? "—";
  const safeNew = newVersion || "—";
  return `${title} updated: ${safeOld} → ${safeNew} (${pathFragment})`;
}
