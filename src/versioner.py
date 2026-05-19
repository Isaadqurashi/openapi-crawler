"""
Versioner — the core control component.

Responsibilities:
    1. Compute a deterministic cryptographic hash of the raw spec bytes.
    2. Compare a newly fetched spec against the latest catalogued entry
       using **both** ``info.version`` and the content hash.
    3. Emit a changelog diff summary including ``paths_delta`` (added /
       removed path counts).
    4. Decide whether the catalog needs a NEW entry, an APPEND to the
       ``history[]`` array of an existing entry, or NO ACTION at all.

The versioner never writes to disk directly — it returns plain data that
the catalog/updater layers persist. This keeps it pure and easy to unit
test.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional

from .parser import ParsedSpec


class ChangeType(str, Enum):
    NEW = "new"             # spec id not in catalog yet
    UPDATED = "updated"     # known spec; content hash and/or info.version changed
    UNCHANGED = "unchanged" # known spec; identical content


@dataclass
class PathsDelta:
    added: List[str] = field(default_factory=list)
    removed: List[str] = field(default_factory=list)

    @property
    def net(self) -> int:
        return len(self.added) - len(self.removed)

    def as_summary(self) -> str:
        """Return human-readable summary like ``+8/-2``."""
        sign = "+" if self.net >= 0 else ""
        return f"{sign}{self.net} (added={len(self.added)}, removed={len(self.removed)})"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "added": self.added,
            "removed": self.removed,
            "net": self.net,
        }


@dataclass
class ChangeDecision:
    """Versioner's verdict for a freshly fetched spec."""
    change_type: ChangeType
    content_hash: str
    paths_delta: PathsDelta
    new_history_entry: Optional[Dict[str, Any]] = None  # set when new/updated


class Versioner:
    """Deterministic change-detection logic."""

    def __init__(self, hash_algorithm: str = "sha256") -> None:
        if hash_algorithm not in hashlib.algorithms_available:
            raise ValueError(f"Unsupported hash algorithm: {hash_algorithm}")
        self._algo = hash_algorithm

    # ---- hashing -------------------------------------------------------
    def compute_hash(self, content: str | bytes) -> str:
        """Return ``algo:hexdigest`` for the given content.

        Including the algorithm name in the prefix means the catalog can
        later evolve to a stronger hash without ambiguity.
        """
        if isinstance(content, str):
            content = content.encode("utf-8")
        h = hashlib.new(self._algo)
        h.update(content)
        return f"{self._algo}:{h.hexdigest()}"

    # ---- diffing -------------------------------------------------------
    @staticmethod
    def diff_paths(old_paths: List[str], new_paths: List[str]) -> PathsDelta:
        old_set = set(old_paths or [])
        new_set = set(new_paths or [])
        return PathsDelta(
            added=sorted(new_set - old_set),
            removed=sorted(old_set - new_set),
        )

    # ---- decision making ----------------------------------------------
    def evaluate(
        self,
        parsed: ParsedSpec,
        raw_content: str | bytes,
        existing_entry: Optional[Dict[str, Any]],
    ) -> ChangeDecision:
        """Decide what should happen to the catalog for this spec.

        Args:
            parsed: Parsed spec from ``parser.parse_spec``.
            raw_content: Bytes/text of the spec — used for hashing.
            existing_entry: The current catalog entry for this id, or
                None if we've never seen this spec before.
        """
        content_hash = self.compute_hash(raw_content)
        now = datetime.now(timezone.utc).isoformat()

        # ---- brand new spec ----
        if existing_entry is None:
            paths_delta = PathsDelta(added=list(parsed.paths), removed=[])
            history_entry = {
                "version": parsed.version,
                "hash": content_hash,
                "paths_count": parsed.paths_count,
                "paths_delta": paths_delta.to_dict(),
                "fetched_at": now,
            }
            return ChangeDecision(
                change_type=ChangeType.NEW,
                content_hash=content_hash,
                paths_delta=paths_delta,
                new_history_entry=history_entry,
            )

        # ---- existing spec ----
        # Find the most recent hash/version from the history (or fallback
        # to the top-level latest_version field for safety).
        history: List[Dict[str, Any]] = existing_entry.get("history") or []
        last = history[-1] if history else {}
        last_hash = last.get("hash")
        last_version = last.get("version") or existing_entry.get("latest_version")

        # Reconstruct the previous path set from the cumulative deltas so
        # we can compute an accurate added/removed list.
        previous_paths = self._reconstruct_paths(history)

        hash_changed = (last_hash != content_hash)
        version_changed = (last_version != parsed.version)

        if not hash_changed and not version_changed:
            return ChangeDecision(
                change_type=ChangeType.UNCHANGED,
                content_hash=content_hash,
                paths_delta=PathsDelta(),
                new_history_entry=None,
            )

        paths_delta = self.diff_paths(previous_paths, parsed.paths)
        history_entry = {
            "version": parsed.version,
            "hash": content_hash,
            "paths_count": parsed.paths_count,
            "paths_delta": paths_delta.to_dict(),
            "fetched_at": now,
            "hash_changed": hash_changed,
            "version_changed": version_changed,
        }
        return ChangeDecision(
            change_type=ChangeType.UPDATED,
            content_hash=content_hash,
            paths_delta=paths_delta,
            new_history_entry=history_entry,
        )

    # ---- helpers ------------------------------------------------------
    @staticmethod
    def _reconstruct_paths(history: List[Dict[str, Any]]) -> List[str]:
        """Replay path deltas in order to recover the previous path set."""
        current: set[str] = set()
        for entry in history:
            delta = entry.get("paths_delta") or {}
            for p in delta.get("added", []):
                current.add(p)
            for p in delta.get("removed", []):
                current.discard(p)
        return sorted(current)
