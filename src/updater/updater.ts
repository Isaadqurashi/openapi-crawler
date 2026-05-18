import { fetchSpec } from "../crawler/fetcher";
import { parseSpec } from "../parser/specParser";
import {
  detectVersionChange,
  formatChangelog,
  formatChangelogStdout,
  hashContent
} from "../versioner/versioner";
import {
  loadCatalog,
  saveCatalog,
  upsertEntry,
  applyFetchFailure,
  applyFetchSuccess,
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
  changelogs: string[];
}

function emptySummary(): RunSummary {
  return { newSpecs: 0, updated: 0, unchanged: 0, failed: 0, changelogs: [] };
}

/**
 * Re-fetch every non-invalid entry in the catalog and update history when
 * content has changed. Returns a summary the caller can print.
 */
export async function runUpdateCycle(logger: Logger): Promise<RunSummary> {
  const summary = emptySummary();
  const catalog = await loadCatalog();
  if (catalog.length === 0) {
    logger.info("update cycle: catalog is empty, nothing to do");
    return summary;
  }

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
      const refreshed = applyFetchSuccess(entry, {
        etag: result.etag ?? entry.etag,
        last_modified: result.lastModified ?? entry.last_modified
      });
      current = upsertEntry(current, refreshed);
      continue;
    }

    if (result.status === "failed") {
      summary.failed++;
      const failed = applyFetchFailure(entry, config.staleAfterRetries);
      current = upsertEntry(current, failed);
      logger.warn("fetch failed during update", {
        id: entry.id,
        error: result.error,
        httpStatus: result.httpStatus,
        retry_count: failed.retry_count,
        status: failed.status
      });
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
        content_hash: hashContent(result.body),
        retry_count: 0
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
      const changelog = formatChangelog(
        parsed.title || entry.title,
        entry.latest_version,
        parsed.version,
        diff.pathsDelta
      );
      const stdoutLine = formatChangelogStdout(
        parsed.title || entry.title,
        entry.latest_version,
        parsed.version,
        diff.pathsDelta
      );
      summary.changelogs.push(stdoutLine);
      const updated = applyFetchSuccess(entry, {
        title: parsed.title || entry.title,
        oas_version: parsed.oas_version,
        latest_version: parsed.version,
        description: parsed.description,
        paths_count: parsed.paths_count,
        tags: parsed.tags,
        servers: parsed.servers,
        etag: result.etag,
        last_modified: result.lastModified,
        content_hash: diff.newHash,
        history
      });
      current = upsertEntry(current, updated);
      logger.info(changelog, {
        id: entry.id,
        changelog,
        pathsDelta: diff.pathsDelta
      });
    } else {
      summary.unchanged++;
      const refreshed = applyFetchSuccess(entry, {
        etag: result.etag ?? entry.etag,
        last_modified: result.lastModified ?? entry.last_modified
      });
      current = upsertEntry(current, refreshed);
    }
  }

  await saveCatalog(current);
  logger.info("update cycle complete", { ...summary, changelogCount: summary.changelogs.length });
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

  void tick();

  return (): void => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
