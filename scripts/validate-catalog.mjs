#!/usr/bin/env node
import fs from "fs";
import path from "path";

const catalogPath = path.resolve(
  process.cwd(),
  process.env.CATALOG_PATH || "catalog.json"
);

const required = new Set([
  "id",
  "source_url",
  "title",
  "oas_version",
  "latest_version",
  "paths_count",
  "fetched_at",
  "status",
  "history"
]);

if (!fs.existsSync(catalogPath)) {
  console.error(`Missing catalog: ${catalogPath}`);
  process.exit(1);
}

const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
if (!Array.isArray(catalog)) {
  console.error("catalog.json must be a JSON array");
  process.exit(1);
}

console.log(`${catalog.length} entries`);

if (catalog.length < 5) {
  console.error("Expected at least 5 entries from a live crawl");
  process.exit(1);
}

for (let i = 0; i < catalog.length; i++) {
  const entry = catalog[i];
  const missing = [...required].filter((k) => !(k in entry));
  if (missing.length) {
    console.error(`Entry ${i} missing fields: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (!Number.isInteger(entry.paths_count)) {
    console.error(`Entry ${i} paths_count is not an integer`);
    process.exit(1);
  }
  if (!["active", "stale", "invalid"].includes(entry.status)) {
    console.error(`Entry ${i} has invalid status: ${entry.status}`);
    process.exit(1);
  }
  if (!Array.isArray(entry.history)) {
    console.error(`Entry ${i} history is not an array`);
    process.exit(1);
  }
  if (!entry.id.startsWith("github:")) {
    console.error(`Entry ${i} id must start with github:`);
    process.exit(1);
  }
}

console.log("All entries valid");
