import {
  hashContent,
  detectVersionChange,
  formatChangelog,
  formatChangelogStdout
} from "../src/versioner/versioner";
import type { ParsedSpec } from "../src/parser/specParser";

function makeParsed(overrides: Partial<ParsedSpec> = {}): ParsedSpec {
  return {
    title: "Test API",
    version: "1.0.0",
    description: "",
    oas_version: "3.0.0",
    paths_count: 5,
    tags: [],
    servers: [],
    status: "active",
    ...overrides
  };
}

describe("hashContent", () => {
  it("produces deterministic SHA-256 hashes", () => {
    const a = hashContent("hello world");
    const b = hashContent("hello world");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces different hashes for different content", () => {
    expect(hashContent("a")).not.toBe(hashContent("b"));
  });

  it("is sensitive to whitespace", () => {
    expect(hashContent("a")).not.toBe(hashContent("a "));
  });
});

describe("detectVersionChange", () => {
  it("treats first-ever fetch as changed with empty history (no history entry yet)", () => {
    const content = "openapi: 3.0.0";
    const parsed = makeParsed();
    const diff = detectVersionChange(content, parsed, null);
    expect(diff.changed).toBe(true);
    expect(diff.newHash).toBe(hashContent(content));
    expect(diff.newHistoryEntry).toBeUndefined();
    expect(diff.pathsDelta).toBe(5);
  });

  it("does NOT bump version when content and version are identical", () => {
    const content = "openapi: 3.0.0";
    const parsed = makeParsed({ version: "1.0.0", paths_count: 5 });
    const existing = {
      content_hash: hashContent(content),
      latest_version: "1.0.0",
      paths_count: 5
    };
    const diff = detectVersionChange(content, parsed, existing);
    expect(diff.changed).toBe(false);
    expect(diff.newHistoryEntry).toBeUndefined();
    expect(diff.pathsDelta).toBe(0);
  });

  it("bumps version when content hash changes", () => {
    const oldContent = "openapi: 3.0.0\n# old";
    const newContent = "openapi: 3.0.0\n# new";
    const parsed = makeParsed({ version: "1.0.0", paths_count: 7 });
    const existing = {
      content_hash: hashContent(oldContent),
      latest_version: "1.0.0",
      paths_count: 5
    };
    const diff = detectVersionChange(newContent, parsed, existing);
    expect(diff.changed).toBe(true);
    expect(diff.newHash).toBe(hashContent(newContent));
    expect(diff.pathsDelta).toBe(2); // 7 - 5
    expect(diff.newHistoryEntry?.paths_delta).toBe(2);
  });

  it("bumps version when info.version changes alone", () => {
    const content = "openapi: 3.0.0";
    const parsed = makeParsed({ version: "2.0.0", paths_count: 5 });
    const existing = {
      content_hash: hashContent(content),
      latest_version: "1.0.0",
      paths_count: 5
    };
    const diff = detectVersionChange(content, parsed, existing);
    expect(diff.changed).toBe(true);
    expect(diff.newHistoryEntry?.version).toBe("2.0.0");
    expect(diff.pathsDelta).toBe(0);
  });

  it("computes negative paths_delta when paths are removed", () => {
    const oldContent = "openapi: 3.0.0\n# v1";
    const newContent = "openapi: 3.0.0\n# v2";
    const parsed = makeParsed({ version: "1.1.0", paths_count: 3 });
    const existing = {
      content_hash: hashContent(oldContent),
      latest_version: "1.0.0",
      paths_count: 10
    };
    const diff = detectVersionChange(newContent, parsed, existing);
    expect(diff.changed).toBe(true);
    expect(diff.pathsDelta).toBe(-7);
  });

  it("includes a UTC timestamp on history entries when updating", () => {
    const oldContent = "openapi: 3.0.0\n# old";
    const newContent = "openapi: 3.0.0\n# new";
    const parsed = makeParsed({ version: "1.1.0", paths_count: 5 });
    const existing = {
      content_hash: hashContent(oldContent),
      latest_version: "1.0.0",
      paths_count: 3
    };
    const diff = detectVersionChange(newContent, parsed, existing);
    expect(diff.newHistoryEntry?.recorded_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
    );
  });
});

describe("formatChangelog", () => {
  it("formats a positive path change with [CHANGELOG] prefix", () => {
    const line = formatChangelog(
      "Stripe API",
      "2024-04-10",
      "2024-06-20",
      8,
      304,
      312
    );
    expect(line).toBe(
      "[CHANGELOG] Stripe API: version 2024-04-10 → 2024-06-20 | paths: 304 → 312 (+8)"
    );
  });

  it("formats a negative path change", () => {
    const line = formatChangelog("Acme", "1.0.0", "1.1.0", -3, 10, 7);
    expect(line).toBe(
      "[CHANGELOG] Acme: version 1.0.0 → 1.1.0 | paths: 10 → 7 (-3)"
    );
  });

  it("formats a zero path change", () => {
    const line = formatChangelog("Acme", "1.0.0", "1.0.1", 0, 5, 5);
    expect(line).toBe(
      "[CHANGELOG] Acme: version 1.0.0 → 1.0.1 | paths: 5 → 5 (0)"
    );
  });

  it("handles missing old version in legacy format", () => {
    const line = formatChangelog("New API", null, "1.0.0", 5);
    expect(line).toContain("New API updated:");
  });
});

describe("formatChangelogStdout", () => {
  it("formats compact terminal output", () => {
    const line = formatChangelogStdout(
      "Stripe API",
      "2024-04-10",
      "2024-06-20",
      8
    );
    expect(line).toBe(
      "[updated] Stripe API v2024-04-10 → v2024-06-20 paths: +8"
    );
  });
});
