"""Unit tests for ``src.catalog`` (schema enforcement + persistence)."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from src.catalog import Catalog
from src.parser import parse_spec
from src.versioner import Versioner


def _make_content(version: str, paths: list[str]) -> str:
    paths_block = "\n".join(f"  {p}: {{}}" for p in paths)
    return (
        "openapi: 3.0.0\n"
        f"info:\n  title: T\n  version: {version}\n"
        f"paths:\n{paths_block}\n"
    )


class TestCatalogPersistence(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp()
        self.path = os.path.join(self.tmp, "catalog.json")

    def test_new_entry_has_all_required_keys(self) -> None:
        cat = Catalog(self.path)
        versioner = Versioner()
        content = _make_content("1.0.0", ["/a", "/b"])
        parsed = parse_spec(content)
        decision = versioner.evaluate(parsed, content, existing_entry=None)
        cat.apply_decision(
            spec_id="github:foo/bar/openapi.yaml",
            source_url="https://github.com/foo/bar/blob/main/openapi.yaml",
            parsed=parsed,
            decision=decision,
        )
        cat.save()

        with open(self.path) as fh:
            saved = json.load(fh)
        entry = saved["entries"][0]
        for k in ("id", "source_url", "title", "oas_version", "latest_version",
                  "paths_count", "fetched_at", "status", "history"):
            self.assertIn(k, entry)
        self.assertEqual(entry["status"], "active")
        self.assertEqual(len(entry["history"]), 1)

    def test_update_appends_history(self) -> None:
        cat = Catalog(self.path)
        v = Versioner()
        c1 = _make_content("1.0.0", ["/a"])
        c2 = _make_content("1.1.0", ["/a", "/b"])
        spec_id = "github:x/y/openapi.yaml"

        d1 = v.evaluate(parse_spec(c1), c1, existing_entry=None)
        cat.apply_decision(spec_id=spec_id, source_url="u", parsed=parse_spec(c1), decision=d1)

        existing = cat.get(spec_id)
        d2 = v.evaluate(parse_spec(c2), c2, existing_entry=existing)
        cat.apply_decision(spec_id=spec_id, source_url="u", parsed=parse_spec(c2), decision=d2)

        entry = cat.get(spec_id)
        self.assertEqual(len(entry["history"]), 2)
        self.assertEqual(entry["latest_version"], "1.1.0")
        self.assertEqual(entry["paths_count"], 2)
        # History is append-only — the first entry is preserved verbatim.
        self.assertEqual(entry["history"][0]["version"], "1.0.0")

    def test_mark_stale_changes_status(self) -> None:
        cat = Catalog(self.path)
        v = Versioner()
        c = _make_content("1.0.0", ["/a"])
        d = v.evaluate(parse_spec(c), c, existing_entry=None)
        cat.apply_decision(spec_id="x", source_url="u", parsed=parse_spec(c), decision=d)
        cat.mark_status("x", "stale")
        self.assertEqual(cat.get("x")["status"], "stale")

    def test_invalid_status_rejected(self) -> None:
        cat = Catalog(self.path)
        with self.assertRaises(ValueError):
            cat.mark_status("x", "bogus")

    def test_save_and_reload_round_trip(self) -> None:
        cat = Catalog(self.path)
        v = Versioner()
        c = _make_content("1.0.0", ["/a"])
        d = v.evaluate(parse_spec(c), c, existing_entry=None)
        cat.apply_decision(spec_id="x", source_url="u", parsed=parse_spec(c), decision=d)
        cat.save()

        reloaded = Catalog(self.path)
        self.assertEqual(reloaded.size(), 1)
        self.assertEqual(reloaded.get("x")["latest_version"], "1.0.0")


if __name__ == "__main__":
    unittest.main()
