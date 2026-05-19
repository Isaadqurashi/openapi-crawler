"""
Catalog persistence layer.

Loads and saves the versioned catalog (``catalog.json``). Enforces the
schema described in the task brief:

    id, source_url, title, oas_version, latest_version, paths_count,
    fetched_at, status, history[]

The catalog is append-only with respect to the ``history[]`` array — old
versions are never overwritten.
"""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from .parser import ParsedSpec
from .versioner import ChangeDecision, ChangeType


# Allowed lifecycle statuses for any catalog entry.
VALID_STATUSES = {"active", "stale", "invalid"}

# Top-level keys every entry must expose.
REQUIRED_KEYS = {
    "id", "source_url", "title", "oas_version", "latest_version",
    "paths_count", "fetched_at", "status", "history",
}


class Catalog:
    """Append-only JSON-backed catalog of OpenAPI specifications."""

    def __init__(self, path: str) -> None:
        self.path = Path(path)
        self._entries: Dict[str, Dict[str, Any]] = {}
        self._load()

    # ---- loading / saving --------------------------------------------
    def _load(self) -> None:
        if not self.path.exists():
            self._entries = {}
            return
        try:
            with self.path.open("r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (json.JSONDecodeError, OSError):
            # Corrupt or unreadable; start with an empty catalog rather
            # than overwriting potentially recoverable data.
            self._entries = {}
            return

        entries = data.get("entries", []) if isinstance(data, dict) else []
        self._entries = {e["id"]: e for e in entries if isinstance(e, dict) and "id" in e}

    def save(self) -> None:
        """Persist the catalog atomically (write-temp-then-rename)."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "count": len(self._entries),
            "entries": sorted(self._entries.values(), key=lambda e: e["id"]),
        }
        # Atomic write: write to a temp file in the same directory, then rename.
        fd, tmp_path = tempfile.mkstemp(
            prefix=".catalog-",
            suffix=".json.tmp",
            dir=str(self.path.parent),
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, indent=2, sort_keys=False)
                fh.write("\n")
            os.replace(tmp_path, self.path)
        except Exception:
            # Clean up the temp file if anything went wrong.
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise

    # ---- accessors ----------------------------------------------------
    def get(self, spec_id: str) -> Optional[Dict[str, Any]]:
        return self._entries.get(spec_id)

    def all(self) -> List[Dict[str, Any]]:
        return list(self._entries.values())

    def size(self) -> int:
        return len(self._entries)

    # ---- mutations ----------------------------------------------------
    def apply_decision(
        self,
        *,
        spec_id: str,
        source_url: str,
        parsed: ParsedSpec,
        decision: ChangeDecision,
    ) -> None:
        """Apply a Versioner decision to the catalog.

        For NEW: create a new entry.
        For UPDATED: append to history[] and refresh top-level fields.
        For UNCHANGED: refresh ``fetched_at`` and ``status`` only.
        """
        now = datetime.now(timezone.utc).isoformat()

        if decision.change_type == ChangeType.NEW:
            entry: Dict[str, Any] = {
                "id": spec_id,
                "source_url": source_url,
                "title": parsed.title,
                "oas_version": parsed.oas_version,
                "latest_version": parsed.version,
                "paths_count": parsed.paths_count,
                "fetched_at": now,
                "status": "active",
                "description": parsed.description,
                "servers": parsed.servers,
                "tags": parsed.tags,
                "history": [decision.new_history_entry] if decision.new_history_entry else [],
            }
            self._validate(entry)
            self._entries[spec_id] = entry
            return

        existing = self._entries.get(spec_id)
        if existing is None:
            # Defensive: treat as NEW if catalog state is out of sync.
            self.apply_decision(
                spec_id=spec_id,
                source_url=source_url,
                parsed=parsed,
                decision=ChangeDecision(
                    change_type=ChangeType.NEW,
                    content_hash=decision.content_hash,
                    paths_delta=decision.paths_delta,
                    new_history_entry=decision.new_history_entry,
                ),
            )
            return

        if decision.change_type == ChangeType.UPDATED and decision.new_history_entry:
            existing.setdefault("history", []).append(decision.new_history_entry)
            existing["latest_version"] = parsed.version
            existing["oas_version"] = parsed.oas_version
            existing["paths_count"] = parsed.paths_count
            existing["title"] = parsed.title
            existing["description"] = parsed.description
            existing["servers"] = parsed.servers
            existing["tags"] = parsed.tags

        # Always bump fetched_at + restore active status on a successful fetch.
        existing["fetched_at"] = now
        existing["status"] = "active"
        self._validate(existing)

    def mark_status(self, spec_id: str, status: str) -> None:
        """Mark an entry as ``stale`` or ``invalid`` after repeated failures."""
        if status not in VALID_STATUSES:
            raise ValueError(f"Invalid status: {status}")
        entry = self._entries.get(spec_id)
        if entry is None:
            return
        entry["status"] = status
        entry["fetched_at"] = datetime.now(timezone.utc).isoformat()

    # ---- schema validation -------------------------------------------
    @staticmethod
    def _validate(entry: Dict[str, Any]) -> None:
        missing = REQUIRED_KEYS - set(entry.keys())
        if missing:
            raise ValueError(f"Entry missing required keys: {sorted(missing)}")
        if entry["status"] not in VALID_STATUSES:
            raise ValueError(f"Invalid status: {entry['status']}")
        if not isinstance(entry["history"], list):
            raise ValueError("history must be a list")
