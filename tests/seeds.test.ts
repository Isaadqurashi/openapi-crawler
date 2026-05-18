import {
  rawUrlToDiscoveredSpec,
  seedsToDiscovered
} from "../src/crawler/seeds";

describe("seeds", () => {
  it("parses raw GitHub URLs into discovered specs with github: ids", () => {
    const url =
      "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.yaml";
    const spec = rawUrlToDiscoveredSpec(url);
    expect(spec).toMatchObject({
      id: "github:stripe/openapi/openapi/spec3.yaml",
      source_url: url,
      owner: "stripe",
      repo: "openapi",
      branch: "master",
      path: "openapi/spec3.yaml"
    });
  });

  it("returns null for non-raw URLs", () => {
    expect(
      rawUrlToDiscoveredSpec("https://github.com/stripe/openapi/blob/main/x.yaml")
    ).toBeNull();
  });

  it("converts multiple seed URLs", () => {
    const urls = [
      "https://raw.githubusercontent.com/a/b/main/openapi.yaml",
      "https://raw.githubusercontent.com/c/d/v1/swagger.json"
    ];
    const specs = seedsToDiscovered(urls);
    expect(specs).toHaveLength(2);
    expect(specs[0].id).toBe("github:a/b/openapi.yaml");
    expect(specs[1].id).toBe("github:c/d/swagger.json");
  });
});
