import * as fs from "fs";
import * as path from "path";
import type { DiscoveredSpec } from "./githubSearch";

interface SeedsFile {
  seeds?: string[];
}

/**
 * Parse a raw.githubusercontent.com URL into a DiscoveredSpec.
 */
export function rawUrlToDiscoveredSpec(rawUrl: string): DiscoveredSpec | null {
  const match = rawUrl.match(
    /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/
  );
  if (!match) return null;
  const [, owner, repo, branch, filepath] = match;
  return {
    id: `github:${owner}/${repo}/${filepath}`,
    source_url: rawUrl,
    owner,
    repo,
    path: filepath,
    branch
  };
}

/**
 * Load seed URLs from a JSON file: `{ "seeds": ["https://raw..."] }`.
 */
export function loadSeedUrls(seedsPath: string): string[] {
  try {
    if (!fs.existsSync(seedsPath)) return [];
    const raw = fs.readFileSync(seedsPath, "utf8");
    const parsed = JSON.parse(raw) as SeedsFile;
    if (!parsed.seeds || !Array.isArray(parsed.seeds)) return [];
    return parsed.seeds.filter(
      (u): u is string => typeof u === "string" && u.trim().length > 0
    );
  } catch {
    return [];
  }
}

export function resolveSeedsPath(configured?: string): string {
  return path.resolve(process.cwd(), configured || "seeds.json");
}

export function seedsToDiscovered(urls: string[]): DiscoveredSpec[] {
  const out: DiscoveredSpec[] = [];
  for (const url of urls) {
    const spec = rawUrlToDiscoveredSpec(url.trim());
    if (spec) out.push(spec);
  }
  return out;
}
