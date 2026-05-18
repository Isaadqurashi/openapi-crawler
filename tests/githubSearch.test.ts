import axios from "axios";
import {
  htmlUrlToRawUrl,
  discoverSpecs
} from "../src/crawler/githubSearch";
import { createLogger } from "../src/logger";

jest.mock("axios");
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
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
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

    const promise = discoverSpecs(logger, 1);
    await jest.runAllTimersAsync();
    const results = await promise;

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
  });

  it("returns empty array when search has no items", async () => {
    mockedAxios.get.mockResolvedValue({
      data: { total_count: 0, incomplete_results: false, items: [] }
    });

    const promise = discoverSpecs(logger, 5);
    await jest.runAllTimersAsync();
    const results = await promise;

    expect(results).toEqual([]);
  });

  it("handles rate-limit responses without throwing", async () => {
    const rateLimited = Object.assign(new Error("rate limited"), {
      response: { status: 429, headers: { "retry-after": "0" } }
    });
    mockedAxios.get.mockRejectedValue(rateLimited);

    const promise = discoverSpecs(logger, 1);
    await jest.runAllTimersAsync();
    const results = await promise;

    expect(results).toEqual([]);
  });
});
