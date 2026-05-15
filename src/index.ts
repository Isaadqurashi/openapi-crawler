#!/usr/bin/env node
import { config } from "./config";
import { createLogger } from "./logger";
import { discoverSpecs, type DiscoveredSpec } from "./crawler/githubSearch";
import { fetchSpec } from "./crawler/fetcher";
import { parseSpec } from "./parser/specParser";
import {
  detectVersionChange,
  formatChangelog,
  hashContent
} from "./versioner/versioner";
import {
  loadCatalog,
  saveCatalog,
  upsertEntry,
  findEntry,
  type Catalog,
  type CatalogEntry
} from "./catalog/catalogStore";
import { runUpdateCycle } from "./updater/updater";

interface CrawlStats {
  discovered: number;
  new: number;
  updated: number;
  unchanged: number;
  invalid: number;
  failed: number;
}

/**
 * Run a fresh crawl: discover specs via GitHub, fetch each, parse it, and
 * upsert into the catalog. Single-stream (no parallel fetches) by design —
 * GitHub raw is generous but we'd rather be polite and predictable than
 * shave a few seconds.
 */
async function runCrawl(): Promise<CrawlStats> {
  const logger = createLogger({ command: "crawl" });
  logger.info("crawl start", {
    maxSpecs: config.maxSpecs,
    hasToken: Boolean(config.githubToken),
    catalogPath: config.catalogPath
  });

  const stats: CrawlStats = {
    discovered: 0,
    new: 0,
    updated: 0,
    unchanged: 0,
    invalid: 0,
    failed: 0
  };

  let catalog: Catalog = await loadCatalog();
  logger.info("catalog loaded", { existingEntries: catalog.length });

  const discovered: DiscoveredSpec[] = await discoverSpecs(logger);
  stats.discovered = discovered.length;

  for (const spec of discovered) {
    const existing = findEntry(catalog, spec.id);
    const fetchResult = await fetchSpec(spec.source_url, {
      etag: existing?.etag ?? null,
      lastModified: existing?.last_modified ?? null
    });

    if (fetchResult.status === "not_modified" && existing) {
      stats.unchanged++;
      logger.debug("not modified", { id: spec.id });
      catalog = upsertEntry(catalog, {
        ...existing,
        fetched_at: new Date().toISOString(),
        status: "active",
        etag: fetchResult.etag ?? existing.etag,
        last_modified: fetchResult.lastModified ?? existing.last_modified
      });
      continue;
    }

    if (fetchResult.status === "failed") {
      stats.failed++;
      logger.warn("fetch failed", {
        id: spec.id,
        url: spec.source_url,
        error: fetchResult.error,
        httpStatus: fetchResult.httpStatus
      });
      if (existing) {
        catalog = upsertEntry(catalog, {
          ...existing,
          status: "stale",
          fetched_at: new Date().toISOString()
        });
      }
      continue;
    }

    if (fetchResult.status !== "ok") {
      // Should be unreachable — "not_modified" without an existing entry
      // means there was nothing to be unmodified against. Skip defensively.
      logger.debug("unexpected 304 without existing entry", { id: spec.id });
      continue;
    }

    const body = fetchResult.body;
    const parsed = parseSpec(body, spec.source_url);

    if (parsed.status === "invalid") {
      stats.invalid++;
      logger.warn("invalid spec", { id: spec.id });
      const invalidEntry: CatalogEntry = {
        id: spec.id,
        source_url: spec.source_url,
        title: existing?.title ?? "",
        oas_version: "",
        latest_version: existing?.latest_version ?? "",
        description: "",
        paths_count: 0,
        tags: [],
        servers: [],
        fetched_at: new Date().toISOString(),
        status: "invalid",
        etag: fetchResult.etag,
        last_modified: fetchResult.lastModified,
        content_hash: hashContent(body),
        history: existing?.history ?? []
      };
      catalog = upsertEntry(catalog, invalidEntry);
      continue;
    }

    const diff = detectVersionChange(body, parsed, existing);

    if (!diff.changed && existing) {
      stats.unchanged++;
      catalog = upsertEntry(catalog, {
        ...existing,
        fetched_at: new Date().toISOString(),
        status: "active",
        etag: fetchResult.etag,
        last_modified: fetchResult.lastModified
      });
      continue;
    }

    // New or updated.
    const isNew = !existing;
    if (isNew) {
      stats.new++;
    } else {
      stats.updated++;
      logger.info(
        formatChangelog(
          parsed.title || existing.title,
          existing.latest_version,
          parsed.version,
          diff.pathsDelta
        ),
        { id: spec.id }
      );
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
      fetched_at: new Date().toISOString(),
      status: "active",
      etag: fetchResult.etag,
      last_modified: fetchResult.lastModified,
      content_hash: diff.newHash,
      history: newHistory
    };
    catalog = upsertEntry(catalog, entry);
    logger.info("catalog upserted", { id: spec.id, isNew });
  }

  await saveCatalog(catalog);
  logger.info("catalog saved", { entryCount: catalog.length });
  logger.info("crawl complete", { ...stats });

  return stats;
}

/**
 * Print a one-line-per-entry summary of the catalog. Designed for humans
 * skimming the terminal — for machine use, just cat the JSON directly.
 */
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

  // Sort newest first by fetched_at for a more useful overview.
  const sorted = [...catalog].sort((a, b) =>
    a.fetched_at < b.fetched_at ? 1 : -1
  );

  for (const entry of sorted) {
    const title = entry.title || "(untitled)";
    const versions = entry.history.length;
    console.log(
      `[${entry.status}] ${title}  v${entry.latest_version || "?"}  ` +
        `paths=${entry.paths_count}  history=${versions}  ${entry.id}`
    );
  }
}

function printHelp(): void {
  const help = [
    "openapi-crawler",
    "",
    "Usage:",
    "  node dist/index.js crawl     Run a fresh crawl",
    "  node dist/index.js update    Re-fetch existing catalog entries",
    "  node dist/index.js catalog   Print catalog summary to stdout",
    "  node dist/index.js help      Show this help",
    "",
    "Environment:",
    "  GITHUB_TOKEN, MAX_SPECS, POLL_INTERVAL_MS, MAX_RETRIES,",
    "  CATALOG_PATH, LOG_LEVEL, SEED_REPOS",
    "",
    "See .env.example for defaults."
  ].join("\n");
  console.log(help);
}

function printCrawlSummary(stats: CrawlStats): void {
  console.log("");
  console.log("Run summary:");
  console.log(`  Discovered:       ${stats.discovered}`);
  console.log(`  New specs:        ${stats.new}`);
  console.log(`  Updated specs:    ${stats.updated}`);
  console.log(`  Unchanged specs:  ${stats.unchanged}`);
  console.log(`  Invalid specs:    ${stats.invalid}`);
  console.log(`  Failed specs:     ${stats.failed}`);
}

async function main(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case "crawl": {
      const stats = await runCrawl();
      printCrawlSummary(stats);
      break;
    }
    case "update": {
      const logger = createLogger({ command: "update" });
      const summary = await runUpdateCycle(logger);
      console.log("");
      console.log("Update summary:");
      console.log(`  New specs found:  ${summary.newSpecs}`);
      console.log(`  Updated specs:    ${summary.updated}`);
      console.log(`  Unchanged specs:  ${summary.unchanged}`);
      console.log(`  Failed specs:     ${summary.failed}`);
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
