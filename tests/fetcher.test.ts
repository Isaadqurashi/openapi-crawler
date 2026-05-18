import axios from "axios";
import { fetchSpec } from "../src/crawler/fetcher";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("fetchSpec", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns ok with body and etag on success", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: "openapi: 3.0.0",
      headers: { etag: '"abc"', "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT" },
      request: { res: { responseUrl: "https://example.com/spec.yaml" } }
    });

    const result = await fetchSpec("https://example.com/spec.yaml");
    expect(result).toEqual({
      status: "ok",
      body: "openapi: 3.0.0",
      etag: '"abc"',
      lastModified: "Mon, 01 Jan 2024 00:00:00 GMT",
      finalUrl: "https://example.com/spec.yaml"
    });
  });

  it("returns not_modified on 304", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      status: 304,
      data: "",
      headers: { etag: '"same"' }
    });

    const result = await fetchSpec("https://example.com/spec.yaml", {
      etag: '"same"'
    });
    expect(result).toEqual({
      status: "not_modified",
      etag: '"same"',
      lastModified: null
    });
    expect(mockedAxios.get).toHaveBeenCalledWith(
      "https://example.com/spec.yaml",
      expect.objectContaining({
        headers: expect.objectContaining({ "If-None-Match": '"same"' })
      })
    );
  });

  it("passes If-Modified-Since on subsequent requests", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      status: 304,
      data: "",
      headers: {}
    });

    await fetchSpec("https://example.com/spec.yaml", {
      lastModified: "Mon, 01 Jan 2024 00:00:00 GMT"
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      "https://example.com/spec.yaml",
      expect.objectContaining({
        headers: expect.objectContaining({
          "If-Modified-Since": "Mon, 01 Jan 2024 00:00:00 GMT"
        })
      })
    );
  });

  it("retries retryable errors with backoff then succeeds", async () => {
    const networkErr = Object.assign(new Error("timeout"), {
      response: undefined
    });
    mockedAxios.get
      .mockRejectedValueOnce(networkErr)
      .mockResolvedValueOnce({
        status: 200,
        data: "openapi: 3.0.0",
        headers: {},
        request: {}
      });

    const promise = fetchSpec("https://example.com/spec.yaml", { maxRetries: 2 });
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.status).toBe("ok");
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  it("returns failed after max retries on persistent errors", async () => {
    const err503 = Object.assign(new Error("Service Unavailable"), {
      response: { status: 503, headers: {} }
    });
    mockedAxios.get.mockRejectedValue(err503);

    const promise = fetchSpec("https://example.com/spec.yaml", { maxRetries: 2 });
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({
      status: "failed",
      error: "Service Unavailable",
      httpStatus: 503
    });
    expect(mockedAxios.get).toHaveBeenCalledTimes(3);
  });

  it("does not retry deterministic 404 errors", async () => {
    const err404 = Object.assign(new Error("Not Found"), {
      response: { status: 404, headers: {} }
    });
    mockedAxios.get.mockRejectedValueOnce(err404);

    const result = await fetchSpec("https://example.com/missing.yaml", {
      maxRetries: 3
    });

    expect(result.status).toBe("failed");
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });
});
