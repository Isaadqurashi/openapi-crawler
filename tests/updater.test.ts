import { fetchSpec } from "../src/crawler/fetcher";
import {
  loadCatalog,
  saveCatalog,
  type CatalogEntry
} from "../src/catalog/catalogStore";
import { runUpdateCycle } from "../src/updater/updater";
import { createLogger } from "../src/logger";
import { hashContent } from "../src/versioner/versioner";
import { config } from "../src/config";

jest.mock("../src/crawler/fetcher");
jest.mock("../src/catalog/catalogStore", () => {
  const actual = jest.requireActual("../src/catalog/catalogStore");
  return {
    ...actual,
    loadCatalog: jest.fn(),
    saveCatalog: jest.fn()
  };
});

const mockedFetch = fetchSpec as jest.MockedFunction<typeof fetchSpec>;
const mockedLoad = loadCatalog as jest.MockedFunction<typeof loadCatalog>;
const mockedSave = saveCatalog as jest.MockedFunction<typeof saveCatalog>;

function makeEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  const body = "openapi: 3.0.0\ninfo:\n  title: Test\n  version: 1.0.0\npaths: {}\n";
  const hash = hashContent(body);
  return {
    id: "github:test/repo/openapi.yaml",
    source_url: "https://raw.githubusercontent.com/test/repo/main/openapi.yaml",
    title: "Test",
    oas_version: "3.0.0",
    latest_version: "1.0.0",
    description: "",
    paths_count: 0,
    tags: [],
    servers: [],
    fetched_at: "2025-01-01T00:00:00.000Z",
    status: "active",
    etag: null,
    last_modified: null,
    content_hash: hash,
    retry_count: 0,
    history: [
      {
        version: "1.0.0",
        hash,
        paths_delta: 0,
        recorded_at: "2025-01-01T00:00:00.000Z"
      }
    ],
    ...overrides
  };
}

describe("runUpdateCycle", () => {
  const logger = createLogger({ command: "test" });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedSave.mockResolvedValue(undefined);
  });

  it("counts unchanged when content hash is identical", async () => {
    const entry = makeEntry();
    const body =
      "openapi: 3.0.0\ninfo:\n  title: Test\n  version: 1.0.0\npaths: {}\n";
    mockedLoad.mockResolvedValue([entry]);
    mockedFetch.mockResolvedValue({
      status: "ok",
      body,
      etag: '"new"',
      lastModified: null,
      finalUrl: entry.source_url
    });

    const summary = await runUpdateCycle(logger);
    expect(summary.unchanged).toBe(1);
    expect(summary.updated).toBe(0);
    expect(mockedSave).toHaveBeenCalled();
  });

  it("counts updated and records changelog when hash changes", async () => {
    const entry = makeEntry();
    const newBody =
      "openapi: 3.0.0\ninfo:\n  title: Test\n  version: 2.0.0\npaths:\n  /pets: {}\n";
    mockedLoad.mockResolvedValue([entry]);
    mockedFetch.mockResolvedValue({
      status: "ok",
      body: newBody,
      etag: '"v2"',
      lastModified: null,
      finalUrl: entry.source_url
    });

    const summary = await runUpdateCycle(logger);
    expect(summary.updated).toBe(1);
    expect(summary.changelogs.length).toBe(1);
    expect(summary.changelogs[0]).toContain("[updated]");
    expect(summary.changelogs[0]).toContain("paths:");
  });

  it("increments retry_count on fetch failure", async () => {
    const entry = makeEntry({ retry_count: 0 });
    mockedLoad.mockResolvedValue([entry]);
    mockedFetch.mockResolvedValue({
      status: "failed",
      error: "network down"
    });

    await runUpdateCycle(logger);

    const saved = mockedSave.mock.calls[0][0] as CatalogEntry[];
    expect(saved[0].retry_count).toBe(1);
    expect(saved[0].status).toBe("active");
  });

  it("marks entry stale after N consecutive failures", async () => {
    const n = config.staleAfterRetries;
    const entry = makeEntry({ retry_count: n - 1, status: "active" });
    mockedLoad.mockResolvedValue([entry]);
    mockedFetch.mockResolvedValue({
      status: "failed",
      error: "gone"
    });

    await runUpdateCycle(logger);

    const saved = mockedSave.mock.calls[0][0] as CatalogEntry[];
    expect(saved[0].retry_count).toBe(n);
    expect(saved[0].status).toBe("stale");
  });
});
