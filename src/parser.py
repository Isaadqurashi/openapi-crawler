"""
OpenAPI / Swagger specification parser.

Supports:
    * OpenAPI 3.x (key: ``openapi``)
    * Swagger 2.x (key: ``swagger``)
    * YAML and JSON file contents

The parser extracts the canonical fields described in the task brief
(title, version, description, servers, paths_count, tags) and reports
the OAS major version. Invalid documents raise ``ParseError`` rather than
returning partial data, so the caller can mark the spec ``invalid``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List

import yaml


class ParseError(ValueError):
    """Raised when a document is not a recognisable OpenAPI/Swagger spec."""


@dataclass
class ParsedSpec:
    """Normalised representation of an OpenAPI/Swagger spec."""
    title: str
    version: str
    description: str
    servers: List[str]
    paths_count: int
    paths: List[str]
    tags: List[str]
    oas_version: str           # e.g. "3.0.3" or "2.0"
    oas_major: str             # "2" or "3"
    raw: Dict[str, Any] = field(repr=False)


def _load_document(content: str) -> Dict[str, Any]:
    """Load YAML or JSON content into a Python dict.

    YAML is a superset of JSON for our purposes, so a single
    ``yaml.safe_load`` covers both formats.
    """
    if not content or not content.strip():
        raise ParseError("Empty document")

    # Try strict JSON first — it's much cheaper and gives clearer errors.
    try:
        doc = json.loads(content)
    except json.JSONDecodeError:
        try:
            doc = yaml.safe_load(content)
        except yaml.YAMLError as exc:
            raise ParseError(f"Could not parse as JSON or YAML: {exc}") from exc

    if not isinstance(doc, dict):
        raise ParseError("Top-level document must be a mapping/object")
    return doc


def _extract_servers(doc: Dict[str, Any], oas_major: str) -> List[str]:
    """Servers are represented differently between OAS 2 and OAS 3."""
    if oas_major == "3":
        servers = doc.get("servers") or []
        return [str(s.get("url", "")) for s in servers if isinstance(s, dict) and s.get("url")]

    # Swagger 2.x: build a URL list from host + basePath + schemes.
    host = doc.get("host")
    base_path = doc.get("basePath", "")
    schemes = doc.get("schemes") or (["https"] if host else [])
    if not host:
        return []
    return [f"{scheme}://{host}{base_path}" for scheme in schemes]


def _extract_tags(doc: Dict[str, Any]) -> List[str]:
    tags = doc.get("tags") or []
    out: List[str] = []
    for tag in tags:
        if isinstance(tag, dict) and tag.get("name"):
            out.append(str(tag["name"]))
        elif isinstance(tag, str):
            out.append(tag)
    return out


def parse_spec(content: str) -> ParsedSpec:
    """Parse raw spec content (bytes already decoded) into a ParsedSpec.

    Raises ``ParseError`` if the document is not a valid OAS 2 or OAS 3 spec.
    """
    doc = _load_document(content)

    if "openapi" in doc:
        oas_version = str(doc["openapi"])
        oas_major = "3"
    elif "swagger" in doc:
        oas_version = str(doc["swagger"])
        oas_major = "2"
    else:
        raise ParseError("Document has neither 'openapi' nor 'swagger' top-level key")

    info = doc.get("info")
    if not isinstance(info, dict):
        raise ParseError("Missing or invalid 'info' object")

    title = str(info.get("title") or "").strip()
    version = str(info.get("version") or "").strip()
    if not title or not version:
        raise ParseError("'info.title' and 'info.version' are required")

    paths = doc.get("paths") or {}
    if not isinstance(paths, dict):
        raise ParseError("'paths' must be an object")
    path_keys = sorted(p for p in paths.keys() if isinstance(p, str))

    return ParsedSpec(
        title=title,
        version=version,
        description=str(info.get("description") or "").strip(),
        servers=_extract_servers(doc, oas_major),
        paths_count=len(path_keys),
        paths=path_keys,
        tags=_extract_tags(doc),
        oas_version=oas_version,
        oas_major=oas_major,
        raw=doc,
    )
