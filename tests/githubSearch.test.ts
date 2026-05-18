jest.mock("axios");
jest.mock("../src/config", () => ({
  config: {
    githubToken: "test-token",
    maxSpecs: 80,
    pollIntervalMs: 86_400_000,
    pollIntervalHours: 24,
    maxRetries: 0,
    staleAfterRetries: 3,
    catalogPath: "/tmp/catalog.json",
    seedsPath: "/fake/seeds.json",
    logLevel: "error",
    seedRepos: [],
    githubRequestDelayMs: 0,
    requestTimeoutMs: 10_000
  }
}));
jest.mock("../src/crawler/seeds", () => ({
  loadSeedUrls: jest.fn(() => []),
  seedsToDiscovered: jest.fn(() => []),
  resolveSeedsPath: jest.fn(() => "/fake/seeds.json")
}));

import axios from "axios";
import {
  htmlUrlToRawUrl,
  discoverSpecs
} from "../src/crawler/githubSearch";
import { createLogger } from "../src/logger";

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("htmlUrlToRawUrl", () => {
  it("converts a github blob URL to raw.githubusercontent.com", () => {
    const raw = htmlUrlToRawUrl(
      "https://github.com/stripe/openapi/blob/master/openapi/spec3.yaml"
    );
    expect(raw).toBe(
      "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.yaml"
    );
  });

  it("returns null for malformed URLs", () => {
    expect(htmlUrlToRawUrl("https://example.com/not-github")).toBeNull();
  });
});

describe("discoverSpecs", () => {
  const logger = createLogger({ command: "test" });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("maps search API items to discovered specs with raw URLs", async () => {
    mockedAxios.get.mockImplementation(async (url: string) => {
      if (url.includes("/search/code")) {
        return {
          data: {
            total_count: 1,
            incomplete_results: false,
            items: [
              {
                name: "openapi.yaml",
                path: "openapi.yaml",
                html_url:
                  "https://github.com/acme/api/blob/main/openapi.yaml",
                repository: {
                  name: "api",
                  full_name: "acme/api",
                  owner: { login: "acme" }
                }
              }
            ]
          }
        };
      }
      throw new Error(`unexpected url ${url}`);
    });

    const results = await discoverSpecs(logger, 4);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "github:acme/api/openapi.yaml",
      source_url:
        "https://raw.githubusercontent.com/acme/api/main/openapi.yaml",
      owner: "acme",
      repo: "api",
      path: "openapi.yaml",
      branch: "main"
    });
    expect(mockedAxios.get).toHaveBeenCalled();
  });

  it("returns empty array when search has no items", async () => {
    mockedAxios.get.mockResolvedValue({
      data: { total_count: 0, incomplete_results: false, items: [] }
    });

    const results = await discoverSpecs(logger, 8);

    expect(results).toEqual([]);
    expect(mockedAxios.get).toHaveBeenCalled();
  });

  it("handles rate-limit responses without throwing", async () => {
    const rateLimited = Object.assign(new Error("rate limited"), {
      response: { status: 429, headers: { "retry-after": "0" } }
    });
    mockedAxios.get.mockRejectedValue(rateLimited);

    const results = await discoverSpecs(logger, 4);

    expect(results).toEqual([]);
  });

  it("runs a github search for each canonical filename", async () => {
    mockedAxios.get.mockResolvedValue({
      data: { total_count: 0, incomplete_results: false, items: [] }
    });

    await discoverSpecs(logger, 12);

    const searchCalls = mockedAxios.get.mock.calls.filter((c) =>
      String(c[0]).includes("/search/code")
    );
    expect(searchCalls).toHaveLength(4);
    const filenames = searchCalls.map(
      (c) => (c[1] as { params?: { q?: string } })?.params?.q
    );
    expect(filenames).toEqual(
      expect.arrayContaining([
        "filename:openapi.yaml",
        "filename:openapi.json",
        "filename:swagger.yaml",
        "filename:swagger.json"
      ])
    );
  });
});
