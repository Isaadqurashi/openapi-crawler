# OpenAPI Spec Crawler

A CLI tool that discovers public OpenAPI/Swagger specifications on GitHub, parses them, tracks version changes via content hashing, and persists a local catalog with full history.

---

## Setup instructions

### Prerequisites

Node.js ≥ 18, npm

### Install

```bash
npm install
npx tsc
```

### Set your GitHub token (required for 30 req/min instead of 10)

```bash
# bash / macOS / Linux
export GITHUB_TOKEN=your_personal_access_token

# PowerShell
$env:GITHUB_TOKEN = "your_personal_access_token"
```

Copy `.env.example` to `.env` to persist settings. A token with no scopes is enough for public search.

### Run

```bash
npm test                              # run all tests with coverage
node dist/index.js crawl              # discover and index specs
node dist/index.js catalog            # view current catalog
node dist/index.js update             # re-check all indexed specs
```

The catalog is written to `data/catalog.json` by default (`CATALOG_PATH` overrides).

---

## Architecture overview

The crawler is a five-stage pipeline. GitHub Code Search (plus optional seed repos) produces raw spec URLs; each URL is fetched with conditional HTTP headers, parsed into a normalized record, versioned by SHA-256 content hash, and persisted to a flat JSON catalog. A separate update pass re-fetches known entries and appends history when content changes.

```
GitHub Search API
        ↓
[githubSearch] — discovers raw spec URLs
        ↓
[fetcher] — downloads with ETag caching
        ↓
[specParser] — extracts title, version, paths, tags
        ↓
[versioner] — hashes content, diffs against stored version
        ↓
[catalogStore] — persists to catalog.json
```

| Module | Responsibility |
|---|---|
| `crawler/githubSearch` | Code Search + seed-repo walk; maps blob URLs to `raw.githubusercontent.com` |
| `crawler/fetcher` | HTTP download with `If-None-Match` / `If-Modified-Since`, retries, backoff |
| `parser/specParser` | OpenAPI 3.x + Swagger 2.0, YAML or JSON |
| `versioner/versioner` | SHA-256 hashing, history entries, changelog formatting |
| `catalog/catalogStore` | Atomic load/save, upsert, content-hash lookup, retry/stale helpers |
| `updater/updater` | Re-fetch loop for existing catalog entries |

---

## Design decisions

**SHA-256 for change detection (not semantic diffing).** Hashing raw bytes is O(n), deterministic, and catches any edit—including whitespace and comments. Semantic diffing would be slower, require a full parse tree comparison, and could miss formatting-only changes that still matter for reproducible builds.

**Flat JSON file (not a database).** The screening scope is a single-machine CLI with tens of specs, not thousands. A JSON array is human-readable, diff-friendly in git, and needs no migrations. Atomic write-to-tmp + rename keeps corruption risk low.

**Content-hash deduplication (not URL-based).** The same OpenAPI file is often vendored across forks (`APIs-guru/openapi-directory`, mirrors, tutorials). Different `github:owner/repo/path` ids with identical bytes are one API. We skip inserts when `content_hash` already exists and log `skipped duplicate (same content hash)`.

**Rate limiting on GitHub.** Authenticated requests use a 200ms courtesy delay; anonymous uses 1s. On 403/429 we honor `Retry-After` and `X-RateLimit-Reset`, else exponential backoff (capped). Fetches run sequentially to stay predictable and within quota.

**Stale after N consecutive failures.** A single transient 503 does not mark an entry stale. `retry_count` increments per failed update/crawl fetch; after `STALE_AFTER_RETRIES` (default 3) the entry becomes `stale`. Successful fetches reset the counter and restore `active`.

---

## Known tradeoffs

1. **GitHub search is capped** — Code Search returns at most ~30 results per query page and ~1000 total per query. Discovery is useful but not exhaustive; seed repos top up known-good sources.
2. **Content-hash dedup is byte-exact** — Two semantically identical specs with different YAML formatting remain separate entries.
3. **No persistent retry state across processes** — `retry_count` lives in `catalog.json`; deleting the catalog resets failure tracking.
4. **ETag support varies** — `raw.githubusercontent.com` often supports conditional requests, but not every host does; without ETags every update re-downloads full content.
5. **Shallow path counting** — `paths_count` is top-level path keys, not per-operation counts.
6. **Default branch only** — Specs on release branches or tags are not discovered unless search happens to index them.

---

## Catalog schema

Each entry includes `oas_version`, `content_hash`, `retry_count`, and an append-only `history[]`. See `data/catalog.sample.json` for examples.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `GITHUB_TOKEN` | _(none)_ | PAT for higher search quota (30 vs 10 req/min) |
| `MAX_SPECS` | `50` | Max specs ingested per crawl |
| `MAX_RETRIES` | `3` | HTTP retries per fetch inside `fetcher` |
| `STALE_AFTER_RETRIES` | `3` | Consecutive failed catalog fetches before `stale` |
| `POLL_INTERVAL_MS` | `86400000` | Update loop interval when polling |
| `CATALOG_PATH` | `data/catalog.json` | Catalog file location |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `SEED_REPOS` | _(empty)_ | Comma-separated `owner/repo` fallback list |

---

## Testing

```bash
npm test
```

Unit tests cover parser, versioner, catalog store, fetcher (mocked axios), GitHub search (mocked API), and updater (mocked fetch + catalog). Target overall coverage is above 70% for `src/**/*.ts` (excluding CLI entry).

---

## License

MIT
