import { fetchSpec } from "../crawler/fetcher";
import { parseSpec } from "../parser/specParser";
import {
  detectVersionChange,
  formatChangelog,
  hashContent
} from "../versioner/versioner";
import {
  loadCatalog,
  saveCatalog,
  upsertEntry,
  type Catalog,
  type CatalogEntry
} from "../catalog/catalogStore";
import { config } from "../config";
import type { Logger } from "../logger";

export interface RunSummary {
  newSpecs: number;
  updated: number;
  unchanged: number;
  failed: number;
}

function emptySummary(): RunSummary {
  return { newSpecs: 0, updated: 0, unchanged: 0, failed: 0 };
}

/**
 * Re-fetch every non-invalid entry in the catalog and update history when
 * content has changed. Returns a summary the caller can print.
 *
 * The flow per entry mirrors the initial crawl, but with two differences:
 *   1. We pass the stored ETag / Last-Modified for conditional fetches.
 *      A 304 short-circuits straight to "unchanged".
 *   2. We never add a brand-new entry here — that's `crawl`'s job. So
 *      `newSpecs` in the summary stays 0 unless this gets wired into
 *      a discovery pass too.
 */
export async function runUpdateCycle(logger: Logger): Promise<RunSummary> {
  const summary = emptySummary();
  const catalog = await loadCatalog();
  if (catalog.length === 0) {
    logger.info("update cycle: catalog is empty, nothing to do");
    return summary;
  }

  // Snapshot the catalog so we mutate `current` per iteration but iterate
  // over the original list. Avoids surprises if upsert ever reorders.
  const targets = catalog.filter((e) => e.status !== "invalid");
  let current: Catalog = catalog;

  for (const entry of targets) {
    const result = await fetchSpec(entry.source_url, {
      etag: entry.etag,
      lastModified: entry.last_modified
    });

    if (result.status === "not_modified") {
      summary.unchanged++;
      logger.debug("not modified", { id: entry.id });
      // Update the freshness timestamp + status so a previously-stale
      // entry that's now responding correctly is restored to active.
      const refreshed: CatalogEntry = {
        ...entry,
        fetched_at: new Date().toISOString(),
        status: "active",
        etag: result.etag ?? entry.etag,
        last_modified: result.lastModified ?? entry.last_modified
      };
      current = upsertEntry(current, refreshed);
      continue;
    }

    if (result.status === "failed") {
      summary.failed++;
      logger.warn("fetch failed during update", {
        id: entry.id,
        error: result.error,
        httpStatus: result.httpStatus
      });
      const failed: CatalogEntry = {
        ...entry,
        status: "stale",
        fetched_at: new Date().toISOString()
      };
      current = upsertEntry(current, failed);
      continue;
    }

    const parsed = parseSpec(result.body, entry.source_url);

    if (parsed.status === "invalid") {
      summary.failed++;
      const invalidEntry: CatalogEntry = {
        ...entry,
        status: "invalid",
        fetched_at: new Date().toISOString(),
        etag: result.etag,
        last_modified: result.lastModified,
        content_hash: hashContent(result.body)
      };
      current = upsertEntry(current, invalidEntry);
      logger.warn("spec became invalid", { id: entry.id });
      continue;
    }

    const diff = detectVersionChange(result.body, parsed, entry);
    if (diff.changed) {
      summary.updated++;
      const history = [...entry.history];
      if (diff.newHistoryEntry) history.push(diff.newHistoryEntry);
      const updated: CatalogEntry = {
        ...entry,
        title: parsed.title || entry.title,
        oas_version: parsed.oas_version,
        latest_version: parsed.version,
        description: parsed.description,
        paths_count: parsed.paths_count,
        tags: parsed.tags,
        servers: parsed.servers,
        fetched_at: new Date().toISOString(),
        status: "active",
        etag: result.etag,
        last_modified: result.lastModified,
        content_hash: diff.newHash,
        history
      };
      current = upsertEntry(current, updated);
      logger.info(
        formatChangelog(
          parsed.title || entry.title,
          entry.latest_version,
          parsed.version,
          diff.pathsDelta
        ),
        { id: entry.id }
      );
    } else {
      summary.unchanged++;
      const refreshed: CatalogEntry = {
        ...entry,
        fetched_at: new Date().toISOString(),
        status: "active",
        etag: result.etag ?? entry.etag,
        last_modified: result.lastModified ?? entry.last_modified
      };
      current = upsertEntry(current, refreshed);
    }
  }

  await saveCatalog(current);
  logger.info("update cycle complete", { ...summary });
  return summary;
}

/**
 * Forever loop on POLL_INTERVAL_MS. Useful when the crawler is run as
 * a long-lived process (systemd, Docker). Returns a function the caller
 * can call to stop the loop cleanly.
 */
export function startPolling(logger: Logger): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await runUpdateCycle(logger);
    } catch (err) {
      logger.error("update cycle threw", { error: (err as Error).message });
    }
    if (!stopped) {
      timer = setTimeout(tick, config.pollIntervalMs);
    }
  };

  // Kick off the first cycle immediately, then space subsequent ones.
  void tick();

  return (): void => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
