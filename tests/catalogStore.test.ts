import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  loadCatalog,
  saveCatalog,
  upsertEntry,
  findEntry,
  type CatalogEntry
} from "../src/catalog/catalogStore";

function makeEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "github:owner/repo/openapi.yaml",
    source_url:
      "https://raw.githubusercontent.com/owner/repo/main/openapi.yaml",
    title: "Sample API",
    oas_version: "3.0.0",
    latest_version: "1.0.0",
    description: "",
    paths_count: 3,
    tags: ["users"],
    servers: ["https://api.example.com"],
    fetched_at: "2025-05-14T08:22:11.000Z",
    status: "active",
    etag: '"abc123"',
    last_modified: "Tue, 14 May 2025 08:22:11 GMT",
    content_hash: "a".repeat(64),
    history: [
      {
        version: "1.0.0",
        hash: "a".repeat(64),
        paths_delta: 3,
        recorded_at: "2025-05-14T08:22:11.000Z"
      }
    ],
    ...overrides
  };
}

describe("upsertEntry", () => {
  it("appends to an empty catalog", () => {
    const entry = makeEntry();
    const result = upsertEntry([], entry);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(entry);
  });

  it("replaces an existing entry with the same id", () => {
    const original = makeEntry();
    const updated = makeEntry({
      latest_version: "2.0.0",
      paths_count: 7
    });
    const result = upsertEntry([original], updated);
    expect(result).toHaveLength(1);
    expect(result[0].latest_version).toBe("2.0.0");
    expect(result[0].paths_count).toBe(7);
  });

  it("preserves history given by caller (no implicit history mutation)", () => {
    const original = makeEntry();
    const newHistory = [
      ...original.history,
      {
        version: "1.1.0",
        hash: "b".repeat(64),
        paths_delta: 2,
        recorded_at: "2025-06-01T00:00:00.000Z"
      }
    ];
    const updated = makeEntry({
      latest_version: "1.1.0",
      paths_count: 5,
      content_hash: "b".repeat(64),
      history: newHistory
    });
    const result = upsertEntry([original], updated);
    expect(result[0].history).toHaveLength(2);
    expect(result[0].history[0].version).toBe("1.0.0");
    expect(result[0].history[1].version).toBe("1.1.0");
  });

  it("does not mutate the input catalog array", () => {
    const original = [makeEntry()];
    const snapshot = JSON.stringify(original);
    upsertEntry(original, makeEntry({ id: "github:x/y/z" }));
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("appends entries with different ids", () => {
    const a = makeEntry({ id: "github:a/b/c" });
    const b = makeEntry({ id: "github:x/y/z" });
    const result = upsertEntry([a], b);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.id)).toEqual([
      "github:a/b/c",
      "github:x/y/z"
    ]);
  });
});

describe("findEntry", () => {
  it("returns the matching entry", () => {
    const entry = makeEntry();
    expect(findEntry([entry], entry.id)).toEqual(entry);
  });

  it("returns null when no match", () => {
    expect(findEntry([makeEntry()], "github:nope/nope/nope.yaml")).toBeNull();
  });
});

describe("loadCatalog / saveCatalog round-trip", () => {
  let tmpDir: string;
  let catalogPath: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "catalog-test-"));
    catalogPath = path.join(tmpDir, "catalog.json");
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when catalog file does not exist", async () => {
    const result = await loadCatalog(catalogPath);
    expect(result).toEqual([]);
  });

  it("returns empty array on empty/whitespace catalog file", async () => {
    await fsp.writeFile(catalogPath, "   \n", "utf8");
    const result = await loadCatalog(catalogPath);
    expect(result).toEqual([]);
  });

  it("persists and reloads catalog data unchanged", async () => {
    const original = [
      makeEntry({ id: "github:a/b/openapi.yaml" }),
      makeEntry({ id: "github:c/d/swagger.json", oas_version: "2.0" })
    ];
    await saveCatalog(original, catalogPath);
    const loaded = await loadCatalog(catalogPath);
    expect(loaded).toEqual(original);
  });

  it("writes JSON with 2-space indentation", async () => {
    await saveCatalog([makeEntry()], catalogPath);
    const raw = await fsp.readFile(catalogPath, "utf8");
    expect(raw).toContain("  "); // indented
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("creates the parent directory if missing", async () => {
    const nested = path.join(tmpDir, "deep", "down", "catalog.json");
    await saveCatalog([makeEntry()], nested);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("throws on corrupted JSON (does not silently discard history)", async () => {
    await fsp.writeFile(catalogPath, "{not valid json", "utf8");
    await expect(loadCatalog(catalogPath)).rejects.toThrow();
  });

  it("rejects non-array JSON payloads", async () => {
    await fsp.writeFile(catalogPath, '{"id":"x"}', "utf8");
    await expect(loadCatalog(catalogPath)).rejects.toThrow();
  });

  it("atomic write: no leftover .tmp file after success", async () => {
    await saveCatalog([makeEntry()], catalogPath);
    const files = await fsp.readdir(tmpDir);
    const leftovers = files.filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});
