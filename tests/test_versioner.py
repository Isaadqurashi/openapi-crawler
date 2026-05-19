"""Unit tests for ``src.versioner`` (hashing + diffing logic)."""

from __future__ import annotations

import hashlib
import unittest

from src.parser import parse_spec
from src.versioner import ChangeType, Versioner


# ---------------------------------------------------------------------------
# Helpers to build small, deterministic specs without disk I/O.
# ---------------------------------------------------------------------------
def make_spec_content(version: str, paths: list[str]) -> str:
    paths_block = "\n".join(f"  {p}:\n    get:\n      responses:\n        '200': {{description: ok}}" for p in paths)
    return (
        "openapi: 3.0.0\n"
        f"info:\n  title: T\n  version: {version}\n"
        f"paths:\n{paths_block}\n"
    )


class TestHashing(unittest.TestCase):
    def test_hash_format_is_algo_prefixed(self) -> None:
        v = Versioner()
        h = v.compute_hash("hello")
        self.assertTrue(h.startswith("sha256:"))
        self.assertEqual(len(h.split(":", 1)[1]), 64)

    def test_hash_is_deterministic(self) -> None:
        v = Versioner()
        self.assertEqual(v.compute_hash("payload"), v.compute_hash("payload"))

    def test_hash_changes_with_content(self) -> None:
        v = Versioner()
        self.assertNotEqual(v.compute_hash("a"), v.compute_hash("b"))

    def test_hash_matches_stdlib(self) -> None:
        v = Versioner()
        expected = "sha256:" + hashlib.sha256(b"abc").hexdigest()
        self.assertEqual(v.compute_hash("abc"), expected)

    def test_invalid_algorithm_rejected(self) -> None:
        with self.assertRaises(ValueError):
            Versioner("not-a-real-algo")


class TestDiffing(unittest.TestCase):
    def test_paths_delta_added_and_removed(self) -> None:
        v = Versioner()
        delta = v.diff_paths(["/a", "/b"], ["/b", "/c", "/d"])
        self.assertEqual(delta.added, ["/c", "/d"])
        self.assertEqual(delta.removed, ["/a"])
        self.assertEqual(delta.net, 1)

    def test_no_changes_yields_empty_delta(self) -> None:
        v = Versioner()
        delta = v.diff_paths(["/a"], ["/a"])
        self.assertEqual(delta.added, [])
        self.assertEqual(delta.removed, [])
        self.assertEqual(delta.net, 0)

    def test_delta_summary_format(self) -> None:
        v = Versioner()
        delta = v.diff_paths([], ["/a", "/b", "/c"])
        self.assertIn("+3", delta.as_summary())


class TestEvaluate(unittest.TestCase):
    def setUp(self) -> None:
        self.v = Versioner()

    def test_new_spec_returns_new(self) -> None:
        content = make_spec_content("1.0.0", ["/a", "/b"])
        parsed = parse_spec(content)
        decision = self.v.evaluate(parsed, content, existing_entry=None)
        self.assertEqual(decision.change_type, ChangeType.NEW)
        self.assertEqual(decision.paths_delta.added, ["/a", "/b"])
        self.assertIsNotNone(decision.new_history_entry)
        self.assertEqual(decision.new_history_entry["version"], "1.0.0")

    def test_identical_content_returns_unchanged(self) -> None:
        content = make_spec_content("1.0.0", ["/a"])
        parsed = parse_spec(content)
        # First call creates the "previous" history entry.
        first = self.v.evaluate(parsed, content, existing_entry=None)
        existing = {
            "id": "x",
            "latest_version": "1.0.0",
            "history": [first.new_history_entry],
        }
        decision = self.v.evaluate(parsed, content, existing_entry=existing)
        self.assertEqual(decision.change_type, ChangeType.UNCHANGED)
        self.assertIsNone(decision.new_history_entry)

    def test_content_change_detected_even_when_version_unchanged(self) -> None:
        c1 = make_spec_content("1.0.0", ["/a"])
        c2 = make_spec_content("1.0.0", ["/a", "/b"])  # extra path; version same
        first = self.v.evaluate(parse_spec(c1), c1, existing_entry=None)
        existing = {
            "id": "x",
            "latest_version": "1.0.0",
            "history": [first.new_history_entry],
        }
        decision = self.v.evaluate(parse_spec(c2), c2, existing_entry=existing)
        self.assertEqual(decision.change_type, ChangeType.UPDATED)
        self.assertEqual(decision.paths_delta.added, ["/b"])
        self.assertEqual(decision.paths_delta.removed, [])

    def test_version_change_detected_even_when_paths_same(self) -> None:
        c1 = make_spec_content("1.0.0", ["/a"])
        c2 = make_spec_content("1.1.0", ["/a"])
        first = self.v.evaluate(parse_spec(c1), c1, existing_entry=None)
        existing = {
            "id": "x",
            "latest_version": "1.0.0",
            "history": [first.new_history_entry],
        }
        decision = self.v.evaluate(parse_spec(c2), c2, existing_entry=existing)
        self.assertEqual(decision.change_type, ChangeType.UPDATED)
        self.assertEqual(decision.paths_delta.net, 0)
        self.assertEqual(decision.new_history_entry["version"], "1.1.0")

    def test_history_replay_reconstructs_paths_correctly(self) -> None:
        # Three sequential updates, each adding & removing different paths.
        c1 = make_spec_content("1.0.0", ["/a", "/b"])
        c2 = make_spec_content("1.1.0", ["/b", "/c"])         # removed /a, added /c
        c3 = make_spec_content("1.2.0", ["/b", "/c", "/d"])    # added /d

        d1 = self.v.evaluate(parse_spec(c1), c1, existing_entry=None)
        existing = {"id": "x", "latest_version": "1.0.0", "history": [d1.new_history_entry]}

        d2 = self.v.evaluate(parse_spec(c2), c2, existing_entry=existing)
        existing["history"].append(d2.new_history_entry)
        existing["latest_version"] = "1.1.0"
        self.assertEqual(d2.paths_delta.added, ["/c"])
        self.assertEqual(d2.paths_delta.removed, ["/a"])

        d3 = self.v.evaluate(parse_spec(c3), c3, existing_entry=existing)
        self.assertEqual(d3.paths_delta.added, ["/d"])
        self.assertEqual(d3.paths_delta.removed, [])


if __name__ == "__main__":
    unittest.main()
