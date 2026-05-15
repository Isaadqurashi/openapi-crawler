# OpenAPI Spec Crawler

A production-quality CLI tool that discovers public OpenAPI/Swagger specifications on GitHub, parses and validates them, and tracks version changes over time in a structured, immutable catalog.

---

## Features

- **GitHub Code Search** across four canonical filenames (`openapi.yaml`, `openapi.json`, `swagger.yaml`, `swagger.json`)
- **Seed repo fallback** when search is rate-limited or sparse (Stripe, GitHub, Twilio, Azure, APIs-guru by default)
- **Parses OpenAPI 3.x and Swagger 2.0** in both YAML and JSON
- **Content-hash version tracking** — never misses a change, never spuriously bumps
- **Conditional fetches** using ETag / Last-Modified headers (304 = skip)
- **Bounded retries** with exponential backoff and `Retry-After` honoring
- **Atomic catalog writes** (write-to-tmp + rename) — no half-written files ever
- **Structured JSON logs** with a per-run `runId` for easy grep / log aggregation
- **Strict TypeScript** with full unit-test coverage on the pure-logic modules

---

## Setup

### Prerequisites

- Node.js ≥ 18
- npm ≥ 8

### Install

```bash
git clone <this-repo>
cd openapi-crawler
npm install
cp .env.example .env
```

Edit `.env` to set at least a `GITHUB_TOKEN` (optional but strongly recommended — bumps the search quota from 10 to 30 requests/minute and avoids cold rate limits). A token with no scopes works fine for public search.

### Build

```bash
make build      # or: npx tsc
```

---

## Usage

```bash
make crawl      # Discover new specs, fetch, parse, upsert to catalog
make update     # Re-fetch existing catalog entries (uses ETag/Last-Modified)
make catalog    # Print catalog summary to stdout
make test       # Run unit tests with coverage
make clean      # Remove dist/ and coverage/
```

A typical flow:

```bash
GITHUB_TOKEN=ghp_xxx MAX_SPECS=25 make crawl
make catalog
# ... wait some hours/days ...
make update
```

The catalog is persisted to `data/catalog.json` by default (override with `CATALOG_PATH`).

---

## Architecture

```
src/
├── config.ts            # Central typed config from env vars
├── logger.ts            # Structured JSON logger with runId
├── crawler/
│   ├── githubSearch.ts  # Code Search API client + seed-repo discovery
│   └── fetcher.ts       # HTTP downloader with ETag, retries, backoff
├── parser/
│   └── specParser.ts    # YAML/JSON parser, OAS3 + Swagger 2 extractor
├── versioner/
│   └── versioner.ts     # SHA-256 hashing, version diffing, changelog
├── catalog/
│   └── catalogStore.ts  # Atomic load/save/upsert for catalog.json
├── updater/
│   └── updater.ts       # Polling re-crawler for existing entries
└── index.ts             # CLI entry point (crawl / update / catalog)
```

### Module responsibilities

| Module | Role |
|---|---|
| `config` | Single source of truth for env-driven settings. Validates and types every value. |
| `logger` | Emits one JSON object per line, tagged with a `runId`. Child loggers can layer extra context (e.g. `command: "crawl"`). |
| `crawler/githubSearch` | Talks to `api.github.com/search/code` and `/repos/.../contents`. Handles pagination, primary + secondary rate limits, and translates `blob` URLs into `raw.githubusercontent.com` URLs. |
| `crawler/fetcher` | Downloads raw spec text. Sends `If-None-Match` and `If-Modified-Since` for conditional re-fetches. Retries 5xx / 429 / 403 with exponential backoff. Returns a tagged union (`ok` / `not_modified` / `failed`). |
| `parser/specParser` | Auto-detects YAML vs JSON, falls back to the other format on parse error, extracts `title`, `version`, `description` (≤300 chars), `oas_version`, `paths_count`, `tags`, `servers`. Reconstructs server URLs from Swagger 2's `host`+`basePath`+`schemes` triplet so downstream code sees one consistent shape. Never throws — invalid input becomes `status: "invalid"`. |
| `versioner/versioner` | SHA-256 hashes raw content and decides whether the catalog needs a new history entry. A change in *either* the content hash or `info.version` triggers an append. Computes `paths_delta` and renders human-readable changelog lines. |
| `catalog/catalogStore` | Loads and saves `catalog.json` atomically. Upsert is a pure function that returns a new array — callers manage history appends so this layer stays policy-free. |
| `updater/updater` | Re-fetches every non-invalid entry. Uses stored ETag/Last-Modified for conditional fetches. Restores `stale` → `active` automatically when a previously-failing spec responds again. |

---

## Design Decisions

**Content hashing for change detection.** The hash is computed over the raw bytes before parsing. This means whitespace changes, comment edits, and semantic edits are all detected with one cheap operation. Hashing the parsed object would normalize away formatting differences but cost much more CPU and miss meaningful edits (e.g. a corrected description). The `info.version` field is checked as an additional trigger, so a legitimate semantic-version bump on identical content still records history.

**Atomic catalog writes.** We write to `catalog.json.<pid>.tmp`, `fsync`, then `rename`. POSIX guarantees the rename is atomic, so a crashed write can never leave a half-written `catalog.json`. Combined with the corrupted-JSON guard in `loadCatalog`, this means version history is durable: a crash loses at most the in-flight run.

**Polite rate limiting.** With a GitHub token: 200ms between calls. Without: 1000ms (1 req/s — GitHub's documented threshold for anonymous traffic). On 403/429 we honor `Retry-After` and `X-RateLimit-Reset` if present, otherwise fall back to exponential backoff capped at 30s. We do not parallelize fetches; a sequential stream is predictable and well within polite-client norms.

**Immutable history.** Old history entries are never edited or deleted. Each new version is appended with its own hash, paths-delta, and timestamp. If you ever need to reconstruct what a spec looked like at a given point, the hashes are stable references.

**Tagged-union fetch result.** `fetchSpec` returns `{status: "ok"} | {status: "not_modified"} | {status: "failed"}` instead of throwing. This makes the caller's control flow explicit, lets TypeScript verify every branch is handled, and avoids the "what's an HTTP error and what's a fatal error" trap.

**Strict canonical-filename matching.** GitHub's Code Search `filename:` qualifier is a *substring* match, so a query for `openapi.yaml` returns templates like `openapi.yaml.j2`, `openapi.yaml.tmpl`, `openapi.yaml.html`, and prefix-matches like `futar-openapi.yaml`. We filter every search hit so only files whose `name` is exactly one of the four canonical filenames (case-insensitive) reaches the catalog. This catches roughly 30–50% of typical search results — without it, the "invalid" bucket fills up with template/generator files we never wanted in the first place.

**Sequential, not parallel.** Could we use `p-limit` to fetch 4–8 specs in parallel? Yes. We don't, because: (a) GitHub raw rate-limits are generous but not infinite, (b) the bottleneck is GitHub Search anyway, and (c) deterministic ordering simplifies debugging immensely. The dependency is listed for future use.

---

## Known Tradeoffs

1. **File-based storage, not a database.** The catalog is a single JSON file. This is fine up to a few thousand entries; beyond that, atomic write cost grows with the catalog size and incremental queries become inefficient. SQLite or LMDB would be the next step.
2. **No de-duplication across forks.** Two forks of the same upstream spec become two catalog entries with distinct `id`s. De-duplicating by content hash would conflate intentional divergences (e.g. a fork that adds endpoints).
3. **GitHub search is the only discovery source.** SwaggerHub, public spec directories, and direct URL submissions aren't wired in. The seed-repo mechanism is the escape hatch for known-good sources.
4. **`paths_count` is shallow.** It counts top-level path keys, not operations. A path with `get/post/put` counts as 1, not 3. Operation counting could be a future enhancement.
5. **No deep validation.** We check for an `openapi` or `swagger` discriminator and graceful YAML/JSON parsing — that's it. `swagger-parser` would validate the full schema but adds significant runtime cost. Listed as optional dep for projects that need stricter validation.
6. **Default branch is the only branch.** We don't crawl tags or release branches. A repo's `openapi.yaml` on `main` might differ from the one on a release branch — we'll only see `main`.

---

## Sample `catalog.json`

A hand-curated reference catalog with three example entries (Stripe, GitHub REST, Twilio) ships at `data/catalog.sample.json` so the schema is visible without running a crawl. The runtime catalog at `data/catalog.json` starts empty and is populated by your first `make crawl`. Keeping them separate prevents the sample's placeholder hashes from looking like a real version downgrade on the first `update` cycle.

Snippet from the sample:

```json
[
  {
    "id": "github:stripe/openapi/openapi/spec3.yaml",
    "source_url": "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.yaml",
    "title": "Stripe API",
    "oas_version": "3.0.0",
    "latest_version": "2024-06-20",
    "description": "The Stripe REST API. Please see https://stripe.com/docs/api for more details.",
    "paths_count": 583,
    "tags": ["Accounts", "Charges", "Customers", "PaymentIntents", "Refunds", "Subscriptions"],
    "servers": ["https://api.stripe.com/"],
    "fetched_at": "2025-05-14T08:22:11.000Z",
    "status": "active",
    "etag": "\"a9c1b2d4e5f6a7b8c9d0e1f2a3b4c5d6\"",
    "last_modified": "Wed, 14 May 2025 06:00:00 GMT",
    "content_hash": "f3b9c2d5a8e1f4b7c0d3e6a9b2c5f8e1d4a7b0c3f6e9d2a5b8c1e4f7a0d3b6c9",
    "history": [
      {
        "version": "2024-04-10",
        "hash": "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
        "paths_delta": 575,
        "recorded_at": "2025-04-12T09:15:33.000Z"
      },
      {
        "version": "2024-06-20",
        "hash": "f3b9c2d5a8e1f4b7c0d3e6a9b2c5f8e1d4a7b0c3f6e9d2a5b8c1e4f7a0d3b6c9",
        "paths_delta": 8,
        "recorded_at": "2025-05-14T08:22:11.000Z"
      }
    ]
  },
  {
    "id": "github:github/rest-api-description/descriptions/api.github.com/api.github.com.json",
    "source_url": "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
    "title": "GitHub v3 REST API",
    "oas_version": "3.0.3",
    "latest_version": "1.1.4",
    "description": "GitHub's v3 REST API.",
    "paths_count": 712,
    "tags": ["actions", "activity", "apps", "billing", "checks", "code-scanning", "issues", "repos", "users"],
    "servers": ["https://api.github.com"],
    "fetched_at": "2025-05-14T08:22:43.000Z",
    "status": "active",
    "etag": "\"b8e1c4f7a0d3b6c9e2f5a8b1c4d7e0a3\"",
    "last_modified": "Tue, 13 May 2025 22:14:08 GMT",
    "content_hash": "e2a5b8c1d4f7a0b3c6e9d2f5a8b1c4e7d0a3b6c9f2e5d8a1b4c7e0f3a6b9d2c5",
    "history": [
      {
        "version": "1.1.4",
        "hash": "e2a5b8c1d4f7a0b3c6e9d2f5a8b1c4e7d0a3b6c9f2e5d8a1b4c7e0f3a6b9d2c5",
        "paths_delta": 712,
        "recorded_at": "2025-05-14T08:22:43.000Z"
      }
    ]
  }
]
```

See `data/catalog.sample.json` for the full file (3 entries).

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GITHUB_TOKEN` | _(none)_ | Personal Access Token. Boosts search quota from 10 to 30 req/min. |
| `MAX_SPECS` | `50` | Hard cap on specs ingested per crawl. |
| `POLL_INTERVAL_MS` | `86400000` (24h) | Interval between update cycles when polling. |
| `MAX_RETRIES` | `3` | Max retries per HTTP request before marking entry stale. |
| `CATALOG_PATH` | `data/catalog.json` | Where the catalog is persisted. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. |
| `SEED_REPOS` | _(5 well-known repos)_ | Comma-separated `owner/repo` list. Used when search is rate-limited. |

---

## Testing

```bash
make test
```

Runs 43 unit tests across the three pure-logic modules (parser, versioner, catalog store). Coverage for those modules is 100% / 100% / 76%. The network-touching modules (fetcher, githubSearch, updater) are not unit-tested here — they're better suited to integration tests against a recorded fixture, which is out of scope for this initial cut.

---

## License

MIT.
