import * as yaml from "js-yaml";
import logger from "../logger";

export type SpecStatus = "active" | "invalid";

export interface ParsedSpec {
  title: string;
  version: string;
  description: string;
  oas_version: string;
  paths_count: number;
  tags: string[];
  servers: string[];
  status: SpecStatus;
}

interface RawSpec {
  openapi?: unknown;
  swagger?: unknown;
  info?: {
    title?: unknown;
    version?: unknown;
    description?: unknown;
  };
  paths?: Record<string, unknown>;
  tags?: Array<{ name?: unknown }>;
  servers?: Array<{ url?: unknown }>;
  host?: unknown;
  basePath?: unknown;
  schemes?: unknown[];
}

const DESCRIPTION_MAX = 300;

/**
 * Return a fallback "invalid" result. Centralizing this keeps every
 * error branch consistent and free of literal field repetition.
 */
function invalid(): ParsedSpec {
  return {
    title: "",
    version: "",
    description: "",
    oas_version: "",
    paths_count: 0,
    tags: [],
    servers: [],
    status: "invalid"
  };
}

/**
 * Convert any value into a trimmed string. Non-strings (numbers, booleans)
 * are coerced via String(). Objects/arrays would produce "[object Object]"
 * or comma-joined garbage, which is useless in a catalog — for those we
 * return "" so the caller can treat the field as absent.
 */
function toStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return "";
  return String(v).trim();
}

/**
 * Decide whether the source looks more like JSON or YAML. Heuristic:
 *  1. If a file path/url is provided and ends in .json → JSON.
 *  2. If the trimmed body begins with `{` or `[` → JSON.
 *  3. Otherwise YAML (a superset that also accepts JSON, but we still
 *     try JSON first for speed and better error messages).
 */
function looksLikeJson(content: string, source?: string): boolean {
  if (source && /\.json($|\?)/i.test(source)) return true;
  const trimmed = content.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

/**
 * Best-effort parse of raw text into an object. Returns null on failure;
 * the caller marks the spec as invalid.
 */
function parseContent(content: string, source?: string): RawSpec | null {
  const tryJson = looksLikeJson(content, source);

  // First pass: preferred format.
  try {
    if (tryJson) return JSON.parse(content) as RawSpec;
    return yaml.load(content) as RawSpec;
  } catch (err) {
    logger.debug("primary parse failed, trying fallback", {
      source,
      preferred: tryJson ? "json" : "yaml",
      error: (err as Error).message
    });
  }

  // Second pass: the other format. Some repos serve YAML with a .json
  // extension or vice versa; this keeps us resilient.
  try {
    if (tryJson) return yaml.load(content) as RawSpec;
    return JSON.parse(content) as RawSpec;
  } catch (err) {
    logger.warn("spec parse failed in both formats", {
      source,
      error: (err as Error).message
    });
    return null;
  }
}

/**
 * Extract the OpenAPI / Swagger version identifier. OAS3 uses `openapi`,
 * Swagger 2 uses `swagger`. Returns "" when neither is present, which
 * causes the spec to be marked invalid.
 */
function extractOasVersion(spec: RawSpec): string {
  if (spec.openapi != null) return toStr(spec.openapi);
  if (spec.swagger != null) return toStr(spec.swagger);
  return "";
}

/**
 * Pull server URLs. OpenAPI 3 has `servers[].url`. Swagger 2 has a flat
 * `host` + `basePath` + `schemes` triplet which we stitch back together
 * so downstream consumers see a consistent shape.
 */
function extractServers(spec: RawSpec): string[] {
  if (Array.isArray(spec.servers)) {
    return spec.servers
      .map((s) => toStr(s?.url))
      .filter((u) => u.length > 0);
  }

  // Swagger 2 reconstruction.
  if (spec.host) {
    const host = toStr(spec.host);
    const basePath = toStr(spec.basePath);
    const schemes = Array.isArray(spec.schemes)
      ? spec.schemes.map(toStr).filter((s) => s.length > 0)
      : ["https"];
    return schemes.map((scheme) => `${scheme}://${host}${basePath}`);
  }

  return [];
}

function extractTags(spec: RawSpec): string[] {
  if (!Array.isArray(spec.tags)) return [];
  return spec.tags
    .map((t) => toStr(t?.name))
    .filter((name) => name.length > 0);
}

function truncate(s: string, limit: number): string {
  return s.length > limit ? s.slice(0, limit) : s;
}

/**
 * Parse raw spec content and extract the catalog-relevant fields. Never
 * throws — invalid content returns status="invalid" so callers can keep
 * iterating through a discovery batch.
 *
 * @param content Raw file content (text)
 * @param source  Optional source URL or filename — used for format detection
 *                and for richer log messages.
 */
export function parseSpec(content: string, source?: string): ParsedSpec {
  if (typeof content !== "string" || content.trim().length === 0) {
    return invalid();
  }

  const spec = parseContent(content, source);
  if (!spec || typeof spec !== "object") return invalid();

  const oasVersion = extractOasVersion(spec);
  if (!oasVersion) {
    // Missing the "openapi" or "swagger" discriminator → not a spec.
    return invalid();
  }

  const info = spec.info || {};
  const paths =
    spec.paths && typeof spec.paths === "object" ? spec.paths : {};

  const title = toStr(info.title);
  const version = toStr(info.version);

  return {
    title: title || "Untitled",
    version: version || "unknown",
    description: truncate(toStr(info.description), DESCRIPTION_MAX),
    oas_version: oasVersion,
    paths_count: Object.keys(paths).length,
    tags: extractTags(spec),
    servers: extractServers(spec),
    status: "active"
  };
}

export default parseSpec;
