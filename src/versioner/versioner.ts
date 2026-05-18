import { createHash } from "crypto";
import type { ParsedSpec } from "../parser/specParser";
import { utcTimestamp } from "../logger";

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
  newHistoryEntry?: HistoryEntry;
  pathsDelta: number;
  oldPathsCount?: number;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Short hash for history entries (task spec uses 16 hex chars). */
export function hashContentShort(content: string): string {
  return hashContent(content).slice(0, 16);
}

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
    oldVersion !== null &&
    parsed.version !== "unknown" &&
    parsed.version !== oldVersion;
  const isNewEntry = existing === null || oldHash === null;

  if (isNewEntry) {
    return {
      changed: true,
      newHash,
      pathsDelta: parsed.paths_count,
      oldPathsCount: 0
    };
  }

  if (hashChanged || versionChanged) {
    const pathsDelta = parsed.paths_count - oldPaths;
    return {
      changed: true,
      newHash,
      pathsDelta,
      oldPathsCount: oldPaths,
      newHistoryEntry: {
        version: parsed.version,
        hash: hashContentShort(content),
        paths_delta: pathsDelta,
        recorded_at: utcTimestamp()
      }
    };
  }

  return { changed: false, newHash, pathsDelta: 0, oldPathsCount: oldPaths };
}

export function formatChangelog(
  title: string,
  oldVersion: string | null | undefined,
  newVersion: string,
  pathsDelta: number,
  oldPaths?: number,
  newPaths?: number
): string {
  const safeOld = oldVersion ?? "—";
  const safeNew = newVersion || "—";
  if (oldPaths != null && newPaths != null) {
    const sign = pathsDelta > 0 ? "+" : "";
    return `[CHANGELOG] ${title}: version ${safeOld} → ${safeNew} | paths: ${oldPaths} → ${newPaths} (${sign}${pathsDelta})`;
  }
  const sign = pathsDelta > 0 ? "+" : "";
  const pathFragment =
    pathsDelta === 0 ? "no path change" : `${sign}${pathsDelta} paths`;
  return `${title} updated: ${safeOld} → ${safeNew} (${pathFragment})`;
}

export function formatChangelogStdout(
  title: string,
  oldVersion: string | null | undefined,
  newVersion: string,
  pathsDelta: number
): string {
  const sign = pathsDelta > 0 ? "+" : "";
  const pathFragment =
    pathsDelta === 0 ? "no path change" : `${sign}${pathsDelta}`;
  const safeOld = oldVersion ?? "?";
  const safeNew = newVersion || "?";
  return `[updated] ${title} v${safeOld} → v${safeNew} paths: ${pathFragment}`;
}
