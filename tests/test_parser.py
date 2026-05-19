"""Unit tests for ``src.parser``."""

from __future__ import annotations

import unittest
from pathlib import Path

from src.parser import ParseError, parse_spec


FIXTURES = Path(__file__).parent / "fixtures"


class TestOpenApi3Parsing(unittest.TestCase):
    def setUp(self) -> None:
        self.content = (FIXTURES / "sample_openapi.yaml").read_text(encoding="utf-8")

    def test_parses_basic_fields(self) -> None:
        spec = parse_spec(self.content)
        self.assertEqual(spec.title, "Sample Petstore")
        self.assertEqual(spec.version, "1.0.0")
        self.assertEqual(spec.oas_major, "3")
        self.assertTrue(spec.oas_version.startswith("3."))

    def test_paths_count_matches_path_keys(self) -> None:
        spec = parse_spec(self.content)
        self.assertEqual(spec.paths_count, 3)
        self.assertEqual(len(spec.paths), 3)
        self.assertIn("/pets", spec.paths)
        self.assertIn("/pets/{id}", spec.paths)
        self.assertIn("/store", spec.paths)

    def test_servers_extracted(self) -> None:
        spec = parse_spec(self.content)
        self.assertEqual(len(spec.servers), 2)
        self.assertTrue(all(url.startswith("https://") for url in spec.servers))

    def test_tags_extracted(self) -> None:
        spec = parse_spec(self.content)
        self.assertEqual(sorted(spec.tags), ["pets", "store"])


class TestSwagger2Parsing(unittest.TestCase):
    def setUp(self) -> None:
        self.content = (FIXTURES / "sample_swagger.json").read_text(encoding="utf-8")

    def test_detects_swagger_major(self) -> None:
        spec = parse_spec(self.content)
        self.assertEqual(spec.oas_major, "2")
        self.assertEqual(spec.oas_version, "2.0")

    def test_paths_count(self) -> None:
        spec = parse_spec(self.content)
        self.assertEqual(spec.paths_count, 3)

    def test_servers_built_from_host_basepath_schemes(self) -> None:
        spec = parse_spec(self.content)
        self.assertEqual(spec.servers, ["https://legacy.example.com/api"])


class TestInvalidDocuments(unittest.TestCase):
    def test_empty_document_raises(self) -> None:
        with self.assertRaises(ParseError):
            parse_spec("")

    def test_garbage_raises(self) -> None:
        with self.assertRaises(ParseError):
            parse_spec("this is not json or yaml: : : [")

    def test_missing_version_keys_raises(self) -> None:
        doc = '{"info": {"title": "Foo", "version": "1"}, "paths": {}}'
        with self.assertRaises(ParseError):
            parse_spec(doc)

    def test_missing_info_raises(self) -> None:
        doc = '{"openapi": "3.0.0", "paths": {}}'
        with self.assertRaises(ParseError):
            parse_spec(doc)

    def test_missing_title_raises(self) -> None:
        doc = '{"openapi": "3.0.0", "info": {"version": "1.0"}, "paths": {}}'
        with self.assertRaises(ParseError):
            parse_spec(doc)


class TestYamlAndJsonInterop(unittest.TestCase):
    def test_json_content_parses_via_yaml_path(self) -> None:
        # The parser tries JSON first; pure JSON content must work.
        json_doc = '{"openapi":"3.0.0","info":{"title":"X","version":"1"},"paths":{"/a":{}}}'
        spec = parse_spec(json_doc)
        self.assertEqual(spec.title, "X")
        self.assertEqual(spec.paths_count, 1)

    def test_yaml_content_parses(self) -> None:
        yaml_doc = (
            "openapi: 3.0.0\n"
            "info:\n  title: Y\n  version: 2\n"
            "paths:\n  /a: {}\n  /b: {}\n"
        )
        spec = parse_spec(yaml_doc)
        self.assertEqual(spec.title, "Y")
        self.assertEqual(spec.paths_count, 2)


if __name__ == "__main__":
    unittest.main()
