import { parseSpec } from "../src/parser/specParser";

describe("parseSpec", () => {
  describe("OpenAPI 3.x YAML", () => {
    const oas3Yaml = `
openapi: "3.0.0"
info:
  title: Petstore API
  version: 1.2.3
  description: A sample API for managing pets.
servers:
  - url: https://api.example.com/v1
  - url: https://staging.example.com/v1
paths:
  /pets:
    get:
      summary: List pets
  /pets/{id}:
    get:
      summary: Get pet
  /owners:
    get:
      summary: List owners
tags:
  - name: pets
  - name: owners
`;

    it("extracts title, version, and oas_version", () => {
      const result = parseSpec(oas3Yaml);
      expect(result.status).toBe("active");
      expect(result.title).toBe("Petstore API");
      expect(result.version).toBe("1.2.3");
      expect(result.oas_version).toBe("3.0.0");
    });

    it("counts paths correctly", () => {
      const result = parseSpec(oas3Yaml);
      expect(result.paths_count).toBe(3);
    });

    it("extracts tag names as strings", () => {
      const result = parseSpec(oas3Yaml);
      expect(result.tags).toEqual(["pets", "owners"]);
    });

    it("extracts server URLs", () => {
      const result = parseSpec(oas3Yaml);
      expect(result.servers).toEqual([
        "https://api.example.com/v1",
        "https://staging.example.com/v1"
      ]);
    });

    it("includes description (under 300 chars)", () => {
      const result = parseSpec(oas3Yaml);
      expect(result.description).toBe("A sample API for managing pets.");
    });
  });

  describe("Swagger 2.0 JSON", () => {
    const swagger2Json = JSON.stringify({
      swagger: "2.0",
      info: {
        title: "Legacy API",
        version: "0.9.0",
        description: "An older Swagger 2 spec"
      },
      host: "api.legacy.example.com",
      basePath: "/v1",
      schemes: ["https"],
      paths: {
        "/users": {},
        "/users/{id}": {}
      },
      tags: [{ name: "users" }]
    });

    it("identifies oas_version as 2.0", () => {
      const result = parseSpec(swagger2Json);
      expect(result.oas_version).toBe("2.0");
      expect(result.status).toBe("active");
    });

    it("reconstructs server URL from host + basePath + schemes", () => {
      const result = parseSpec(swagger2Json);
      expect(result.servers).toEqual(["https://api.legacy.example.com/v1"]);
    });

    it("counts paths and extracts tags", () => {
      const result = parseSpec(swagger2Json);
      expect(result.paths_count).toBe(2);
      expect(result.tags).toEqual(["users"]);
    });
  });

  describe("invalid input", () => {
    it("returns status=invalid on malformed YAML", () => {
      const broken = "openapi: 3.0.0\ninfo:\n  title: [unclosed";
      const result = parseSpec(broken);
      expect(result.status).toBe("invalid");
    });

    it("returns status=invalid when openapi/swagger field is missing", () => {
      const notASpec = JSON.stringify({ info: { title: "x" }, paths: {} });
      const result = parseSpec(notASpec);
      expect(result.status).toBe("invalid");
    });

    it("returns status=invalid on empty input", () => {
      expect(parseSpec("").status).toBe("invalid");
      expect(parseSpec("   ").status).toBe("invalid");
    });
  });

  describe("edge cases", () => {
    it("treats missing paths as paths_count=0", () => {
      const noPaths = `
openapi: "3.0.0"
info:
  title: Empty API
  version: 1.0.0
`;
      const result = parseSpec(noPaths);
      expect(result.paths_count).toBe(0);
      expect(result.status).toBe("active");
    });

    it("truncates descriptions over 300 chars", () => {
      const longDesc = "x".repeat(500);
      const spec = `
openapi: "3.0.0"
info:
  title: API
  version: 1.0.0
  description: "${longDesc}"
`;
      const result = parseSpec(spec);
      expect(result.description.length).toBe(300);
    });

    it("returns empty arrays when tags/servers are absent", () => {
      const minimal = `
openapi: "3.0.0"
info:
  title: Minimal
  version: 1.0.0
paths: {}
`;
      const result = parseSpec(minimal);
      expect(result.tags).toEqual([]);
      expect(result.servers).toEqual([]);
    });

    it("falls back from JSON to YAML when content type is mislabeled", () => {
      const yamlContent = `
openapi: "3.0.0"
info:
  title: Mislabeled
  version: 1.0.0
paths: {}
`;
      // Pass a .json source even though content is YAML.
      const result = parseSpec(yamlContent, "https://example.com/spec.json");
      expect(result.status).toBe("active");
      expect(result.title).toBe("Mislabeled");
    });

    it("coerces object-valued info.version to empty string (no [object Object])", () => {
      // Some specs ship malformed info.version as a structured object.
      // We should NEVER let "[object Object]" leak into the catalog.
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Bad Version", version: { major: 1, minor: 0 } },
        paths: {}
      });
      const result = parseSpec(spec);
      expect(result.status).toBe("active");
      expect(result.version).toBe("");
      expect(result.version).not.toContain("object");
    });

    it("coerces numeric info.version to a string", () => {
      const spec = JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Numeric Version", version: 2 },
        paths: {}
      });
      const result = parseSpec(spec);
      expect(result.version).toBe("2");
    });
  });
});
