# OpenAPI Spec Crawler

> APIMatic Intern Screening Task — discovers, parses, versions, and catalogs public OpenAPI specs from GitHub.

## Setup

1. Clone the repo
2. Install dependencies:

```bash
npm install
```

3. Copy `.env.example` to `.env` and fill in your GitHub token:

```
GITHUB_TOKEN=your_personal_access_token
MAX_SPECS=50
POLL_INTERVAL_HOURS=24
SEEDS_PATH=seeds.json
CATALOG_PATH=catalog.json
```

4. Build:

```bash
npx tsc
```

## Running

```bash
make crawl         # run a one-time crawl
make update        # re-fetch existing catalog entries (ETag-aware)
make catalog       # print catalog summary
make watch         # daemon: crawl on POLL_INTERVAL_HOURS
make test          # run the test suite with coverage
make validate      # validate catalog.json schema (after crawl)
```

Or without Make:

```bash
node dist/index.js crawl
node dist/index.js watch
npm test
```

## Architecture

The system follows a linear pipeline:

```
Crawler → Parser → Versioner → Catalog → (Optional) Updater
```

- **Crawler** (`src/crawler/githubSearch.ts`, `seeds.ts`, `fetcher.ts`): Loads `seeds.json` raw URLs first, then queries GitHub Code Search for `openapi.yaml`, `openapi.json`, `swagger.yaml`, `swagger.json`. Handles pagination, rate limits (2s delay between API calls), and seed-repo bootstrapping.

- **Parser** (`src/parser/specParser.ts`): Parses YAML or JSON, detects OAS 2.x / 3.x, extracts `title`, `version`, `description`, `servers`, `paths_count`, `tags`, `oas_version`.

- **Versioner** (`src/versioner/versioner.ts`): Detects changes via `info.version` and SHA-256 content hash. Maintains append-only `history[]` with `paths_delta`. First ingest keeps `history: []`; updates append history entries.

- **Catalog** (`src/catalog/catalogStore.ts`): Persists entries to `catalog.json` using atomic write (temp file + rename). Indexes by `source_url` for lookups. Content-hash deduplication skips byte-identical specs from different forks.

- **Updater** (`src/updater/updater.ts`): Re-fetch cycle with ETag/Last-Modified, exponential backoff retries, and `stale` status after consecutive failures.

## Design Decisions & Tradeoffs

1. **SHA-256 content hashing** — Catches silent path edits when `info.version` is unchanged. History stores a 16-char hash prefix per task spec; full hash is kept on the entry for dedup.

2. **Atomic catalog writes** — Avoids corrupt `catalog.json` if the process is killed mid-write.

3. **Seed list first** — `seeds.json` raw URLs are processed before GitHub search so the catalog contains high-quality APIs even when search is rate-limited.

4. **Content-hash deduplication** — Same spec vendored across forks becomes one catalog entry (first wins).

5. **Crawl limit** — `MAX_SPECS` caps ingestion per run; logged when reached.

6. **Known tradeoffs**:
   - GitHub Code Search can return noisy filename matches; we filter to exact canonical filenames.
   - Rate limiting means a full crawl of 50 specs takes several minutes.
   - Byte-identical dedup does not merge semantically identical specs with different formatting.
   - `retry_count` resets only in-catalog; deleting `catalog.json` clears failure state.

## License

MIT
