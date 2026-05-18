#!/usr/bin/env node
import { config } from "./config";
import { createLogger, utcTimestamp, type Logger } from "./logger";
import { discoverSpecs, type DiscoveredSpec } from "./crawler/githubSearch";
import { fetchSpec } from "./crawler/fetcher";
import { parseSpec } from "./parser/specParser";
import {
  detectVersionChange,
  formatChangelog,
  formatChangelogStdout,
  hashContent
} from "./versioner/versioner";
import {
  loadCatalog,
  saveCatalog,
  upsertEntry,
  findEntry,
  findEntryBySourceUrl,
  findEntryByContentHash,
  applyFetchFailure,
  applyFetchSuccess,
  type Catalog,
  type CatalogEntry
} from "./catalog/catalogStore";
import { runUpdateCycle } from "./updater/updater";

export interface CrawlStats {
  discovered: number;
  new: number;
  updated: number;
  unchanged: number;
  invalid: number;
  failed: number;
  duplicates: number;
  changelogs: string[];
}

function emptyStats(): CrawlStats {
  return {
    discovered: 0,
    new: 0,
    updated: 0,
    unchanged: 0,
    invalid: 0,
    failed: 0,
    duplicates: 0,
    changelogs: []
  };
}

function printRunSummaryBox(
  runId: string,
  stats: CrawlStats,
  durationSeconds: number
): void {
  const total =
    stats.new + stats.updated + stats.unchanged + stats.invalid + stats.failed;
  console.log("");
  console.log("╔══════════════════════════════╗");
  console.log("║  Crawl Run Summary           ║");
  console.log("╠══════════════════════════════╣");
  console.log(`║  Run ID   : ${runId.padEnd(18)}║`);
  console.log(`║  New       : ${String(stats.new).padEnd(17)}║`);
  console.log(`║  Updated   : ${String(stats.updated).padEnd(17)}║`);
  console.log(`║  Unchanged : ${String(stats.unchanged).padEnd(17)}║`);
  console.log(`║  Duplicates: ${String(stats.duplicates).padEnd(17)}║`);
  console.log(`║  Failed    : ${String(stats.failed).padEnd(17)}║`);
  console.log(`║  Total     : ${String(total).padEnd(17)}║`);
  console.log("╚══════════════════════════════╝");
  console.log(`  Duration: ${durationSeconds.toFixed(1)}s`);
}

function printChangelogSection(
  changelogs: string[],
  updatedCount: number
): void {
  if (changelogs.length > 0) {
    console.log("");
    console.log("Changelog:");
    for (const line of changelogs) {
      console.log(`  ${line}`);
    }
    return;
  }
  if (updatedCount === 0) {
    console.log("");
    console.log(
      "Changelog: no spec changes this run (diffs appear here when content changes)."
    );
  }
}

export async function runCrawl(logger?: Logger): Promise<CrawlStats> {
  const log = logger ?? createLogger({ command: "crawl" });
  const started = Date.now();

  log.info("crawl starting", {
    event: "run_start",
    maxSpecs: config.maxSpecs,
    hasToken: Boolean(config.githubToken),
    catalogPath: config.catalogPath,
    seedsPath: config.seedsPath
  });

  const stats = emptyStats();
  let catalog: Catalog = await loadCatalog();
  log.info("catalog loaded", {
    event: "catalog_loaded",
    existingEntries: catalog.length
  });

  const discovered: DiscoveredSpec[] = await discoverSpecs(log);
  stats.discovered = discovered.length;

  for (const spec of discovered) {
    const existing =
      findEntry(catalog, spec.id) ?? findEntryBySourceUrl(catalog, spec.source_url);

    if (existing?.status === "invalid") {
      continue;
    }

    const fetchResult = await fetchSpec(spec.source_url, {
      etag: existing?.etag ?? null,
      lastModified: existing?.last_modified ?? null
    });

    if (fetchResult.status === "not_modified" && existing) {
      stats.unchanged++;
      log.debug("spec unchanged (304)", {
        event: "spec_unchanged",
        spec_id: spec.id
      });
      catalog = upsertEntry(
        catalog,
        applyFetchSuccess(existing, {
          etag: fetchResult.etag ?? existing.etag,
          last_modified: fetchResult.lastModified ?? existing.last_modified
        })
      );
      continue;
    }

    if (fetchResult.status === "failed") {
      stats.failed++;
      log.warn("fetch failed", {
        event: "fetch_error",
        spec_id: spec.id,
        url: spec.source_url,
        error: fetchResult.error,
        httpStatus: fetchResult.httpStatus
      });
      if (existing) {
        const failed = applyFetchFailure(existing, config.staleAfterRetries);
        if (failed.status === "stale") {
          log.warn("spec marked stale", {
            event: "spec_stale",
            spec_id: spec.id,
            retry_count: failed.retry_count
          });
        }
        catalog = upsertEntry(catalog, failed);
      }
      continue;
    }

    if (fetchResult.status !== "ok") continue;

    const body = fetchResult.body;
    const contentHash = hashContent(body);

    log.info("spec fetched", {
      event: "spec_fetched",
      spec_id: spec.id,
      source_url: spec.source_url
    });

    const duplicateOf = findEntryByContentHash(catalog, contentHash);
    if (duplicateOf && duplicateOf.id !== spec.id) {
      stats.duplicates++;
      log.info("skipping duplicate spec", {
        event: "duplicate_skipped",
        spec_id: spec.id,
        duplicate_of: duplicateOf.id,
        content_hash: contentHash
      });
      continue;
    }

    const parsed = parseSpec(body, spec.source_url);

    if (parsed.status === "invalid") {
      stats.invalid++;
      log.warn("spec parse failed", {
        event: "spec_invalid",
        spec_id: spec.id,
        source_url: spec.source_url
      });
      if (!existing) {
        const invalidEntry: CatalogEntry = {
          id: spec.id,
          source_url: spec.source_url,
          title: "",
          oas_version: "",
          latest_version: "",
          description: "",
          paths_count: 0,
          tags: [],
          servers: [],
          fetched_at: utcTimestamp(),
          status: "invalid",
          etag: fetchResult.etag,
          last_modified: fetchResult.lastModified,
          content_hash: contentHash,
          retry_count: 0,
          history: []
        };
        catalog = upsertEntry(catalog, invalidEntry);
      }
      continue;
    }

    log.info("spec parsed", {
      event: "spec_parsed",
      spec_id: spec.id,
      title: parsed.title,
      paths_count: parsed.paths_count,
      oas_version: parsed.oas_version
    });

    const diff = detectVersionChange(body, parsed, existing);

    if (!diff.changed && existing) {
      stats.unchanged++;
      log.debug("spec unchanged", { event: "spec_unchanged", spec_id: spec.id });
      catalog = upsertEntry(
        catalog,
        applyFetchSuccess(existing, {
          etag: fetchResult.etag,
          last_modified: fetchResult.lastModified
        })
      );
      continue;
    }

    const isNew = !existing;
    if (isNew) {
      stats.new++;
    } else {
      stats.updated++;
      const changelog = formatChangelog(
        parsed.title || existing!.title,
        existing!.latest_version,
        parsed.version,
        diff.pathsDelta,
        diff.oldPathsCount,
        parsed.paths_count
      );
      const stdoutLine = formatChangelogStdout(
        parsed.title || existing!.title,
        existing!.latest_version,
        parsed.version,
        diff.pathsDelta
      );
      stats.changelogs.push(stdoutLine);
      log.info(changelog, {
        event: "spec_updated",
        spec_id: spec.id,
        old_version: existing!.latest_version,
        new_version: parsed.version,
        paths_delta: diff.pathsDelta,
        changelog
      });
    }

    const newHistory = existing ? [...existing.history] : [];
    if (diff.newHistoryEntry) newHistory.push(diff.newHistoryEntry);

    const entry: CatalogEntry = {
      id: spec.id,
      source_url: spec.source_url,
      title: parsed.title,
      oas_version: parsed.oas_version,
      latest_version: parsed.version,
      description: parsed.description,
      paths_count: parsed.paths_count,
      tags: parsed.tags,
      servers: parsed.servers,
      fetched_at: utcTimestamp(),
      status: "active",
      etag: fetchResult.etag,
      last_modified: fetchResult.lastModified,
      content_hash: diff.newHash,
      retry_count: 0,
      history: newHistory
    };
    catalog = upsertEntry(catalog, entry);
    log.info("catalog upserted", {
      event: "catalog_upsert",
      spec_id: spec.id,
      isNew
    });
  }

  await saveCatalog(catalog);
  const durationSeconds = (Date.now() - started) / 1000;

  log.info("crawl complete", {
    event: "run_complete",
    run_id: log.runId,
    new: stats.new,
    updated: stats.updated,
    unchanged: stats.unchanged,
    failed: stats.failed,
    invalid: stats.invalid,
    duplicates: stats.duplicates,
    total: catalog.length,
    duration_seconds: durationSeconds
  });

  return stats;
}

async function showCatalog(): Promise<void> {
  const catalog = await loadCatalog();
  if (catalog.length === 0) {
    console.log("Catalog is empty. Run `make crawl` first.");
    return;
  }
  console.log(`Catalog: ${catalog.length} entries at ${config.catalogPath}\n`);

  const byStatus: Record<string, number> = {};
  for (const e of catalog) {
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
  }
  console.log("By status:", byStatus, "\n");

  const sorted = [...catalog].sort((a, b) =>
    a.fetched_at < b.fetched_at ? 1 : -1
  );

  for (const entry of sorted) {
    const title = entry.title || "(untitled)";
    const versions = entry.history.length;
    const statusLabel =
      entry.status === "stale" ? "[stale]" : `[${entry.status}]`;
    console.log(
      `${statusLabel} ${title}  oas=${entry.oas_version || "?"}  ` +
        `v${entry.latest_version || "?"}  paths=${entry.paths_count}  ` +
        `history=${versions}  ${entry.id}`
    );
  }
}

function printHelp(): void {
  console.log(`openapi-crawler

Usage:
  node dist/index.js crawl     Run a fresh crawl
  node dist/index.js update    Re-fetch existing catalog entries
  node dist/index.js catalog   Print catalog summary
  node dist/index.js watch     Daemon: crawl on POLL_INTERVAL_HOURS
  node dist/index.js help      Show this help

Environment:
  GITHUB_TOKEN, MAX_SPECS, SEEDS_PATH, POLL_INTERVAL_HOURS,
  CATALOG_PATH, MAX_RETRIES, STALE_AFTER_RETRIES, LOG_LEVEL

See .env.example for defaults.`);
}

export function runWatch(logger?: Logger): () => void {
  const log = logger ?? createLogger({ command: "watch" });
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const stats = await runCrawl(log.child({ cycle: Date.now() }));
      printRunSummaryBox(log.runId, stats, 0);
    } catch (err) {
      log.error("watch cycle failed", {
        event: "run_error",
        error: (err as Error).message
      });
    }
    if (!stopped) {
      log.info("sleeping until next crawl", {
        event: "sleeping",
        next_run_in_seconds: config.pollIntervalMs / 1000
      });
      timer = setTimeout(() => void tick(), config.pollIntervalMs);
    }
  };

  void tick();
  return (): void => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const started = Date.now();

  switch (command) {
    case "crawl": {
      const logger = createLogger({ command: "crawl" });
      const stats = await runCrawl(logger);
      const duration = (Date.now() - started) / 1000;
      printRunSummaryBox(logger.runId, stats, duration);
      printChangelogSection(stats.changelogs, stats.updated);
      break;
    }
    case "update": {
      const logger = createLogger({ command: "update" });
      const summary = await runUpdateCycle(logger);
      console.log("");
      console.log("Update summary:");
      console.log(`  Updated specs:    ${summary.updated}`);
      console.log(`  Unchanged specs:  ${summary.unchanged}`);
      console.log(`  Failed specs:     ${summary.failed}`);
      printChangelogSection(summary.changelogs, summary.updated);
      break;
    }
    case "watch": {
      const logger = createLogger({ command: "watch" });
      console.log(
        `Watch mode: crawling every ${config.pollIntervalHours}h (Ctrl+C to stop)`
      );
      const stop = runWatch(logger);
      process.on("SIGINT", () => {
        stop();
        process.exit(0);
      });
      await new Promise(() => {});
      break;
    }
    case "catalog": {
      await showCatalog();
      break;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined: {
      printHelp();
      break;
    }
    default: {
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("fatal error", err);
  process.exit(1);
});
