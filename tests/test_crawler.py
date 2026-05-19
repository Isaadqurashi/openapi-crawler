"""Unit tests for ``src.crawler`` — pure / network-free methods only.

Covered:
  - DiscoveredSpec dataclass (fields, immutability, optional ref)
  - GitHubClient.has_token() (with / without token)
  - Crawler._build_search_queries() (filename patterns, api_name_filenames,
    blank-entry filtering, ordering)
  - Crawler._spec_from_code_search_item() (full item, missing fields, URL
    construction, spec_id format, default_branch fallback, path encoding)
"""

from __future__ import annotations

import unittest

from src.config import CrawlerConfig
from src.crawler import Crawler, DiscoveredSpec, GitHubClient


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------

def _cfg(
    search_filenames=None,
    api_name_filenames=None,
    bootstrap_repos=None,
    max_specs_per_run=50,
    github_results_per_query=30,
    github_api_base="https://api.github.com",
    user_agent="test-agent/1.0",
) -> CrawlerConfig:
    return CrawlerConfig(
        search_filenames=search_filenames if search_filenames is not None
                         else ["openapi.yaml", "openapi.json"],
        api_name_filenames=api_name_filenames if api_name_filenames is not None else [],
        bootstrap_repos=bootstrap_repos or [],
        max_specs_per_run=max_specs_per_run,
        github_results_per_query=github_results_per_query,
        github_api_base=github_api_base,
        user_agent=user_agent,
    )


class _NullLogger:
    """Silence all log calls so tests produce no output."""
    def info(self, *a, **kw): pass
    def warning(self, *a, **kw): pass
    def error(self, *a, **kw): pass


def _crawler(**kw) -> Crawler:
    return Crawler(_cfg(**kw), github_token="", logger=_NullLogger())


def _code_search_item(
    owner="acme",
    repo="myapi",
    path="openapi.yaml",
    default_branch="main",
    html_url=None,
) -> dict:
    return {
        "path": path,
        "html_url": html_url or f"https://github.com/{owner}/{repo}/blob/{default_branch}/{path}",
        "repository": {
            "name": repo,
            "default_branch": default_branch,
            "owner": {"login": owner},
        },
    }


# ---------------------------------------------------------------------------
# DiscoveredSpec
# ---------------------------------------------------------------------------

class TestDiscoveredSpec(unittest.TestCase):

    def test_all_fields_accessible(self) -> None:
        spec = DiscoveredSpec(
            spec_id="github:foo/bar/openapi.yaml",
            source_url="https://raw.githubusercontent.com/foo/bar/main/openapi.yaml",
            html_url="https://github.com/foo/bar/blob/main/openapi.yaml",
            owner="foo",
            repo="bar",
            path="openapi.yaml",
            ref="main",
        )
        self.assertEqual(spec.spec_id, "github:foo/bar/openapi.yaml")
        self.assertEqual(spec.owner, "foo")
        self.assertEqual(spec.repo, "bar")
        self.assertEqual(spec.ref, "main")

    def test_frozen_prevents_mutation(self) -> None:
        spec = DiscoveredSpec(
            spec_id="s", source_url="u", html_url="h",
            owner="o", repo="r", path="p",
        )
        with self.assertRaises(Exception):   # dataclasses.FrozenInstanceError
            spec.owner = "changed"           # type: ignore[misc]

    def test_ref_defaults_to_none(self) -> None:
        spec = DiscoveredSpec(
            spec_id="s", source_url="u", html_url="h",
            owner="o", repo="r", path="p",
        )
        self.assertIsNone(spec.ref)

    def test_equal_when_same_spec_id_and_fields(self) -> None:
        kwargs = dict(
            spec_id="github:a/b/openapi.yaml",
            source_url="https://raw.githubusercontent.com/a/b/main/openapi.yaml",
            html_url="https://github.com/a/b/blob/main/openapi.yaml",
            owner="a", repo="b", path="openapi.yaml", ref="main",
        )
        self.assertEqual(DiscoveredSpec(**kwargs), DiscoveredSpec(**kwargs))


# ---------------------------------------------------------------------------
# GitHubClient.has_token
# ---------------------------------------------------------------------------

class TestGitHubClientHasToken(unittest.TestCase):

    def test_returns_true_when_token_provided(self) -> None:
        client = GitHubClient(
            base_url="https://api.github.com",
            token="ghp_fakefake123",
            user_agent="test/1.0",
        )
        self.assertTrue(client.has_token())

    def test_returns_false_when_token_empty(self) -> None:
        client = GitHubClient(
            base_url="https://api.github.com",
            token="",
            user_agent="test/1.0",
        )
        self.assertFalse(client.has_token())


# ---------------------------------------------------------------------------
# Crawler._build_search_queries
# ---------------------------------------------------------------------------

class TestBuildSearchQueries(unittest.TestCase):

    def test_standard_filenames_become_filename_queries(self) -> None:
        c = _crawler(search_filenames=["openapi.yaml", "openapi.json",
                                       "swagger.yaml", "swagger.json"])
        queries = c._build_search_queries()
        self.assertEqual(queries, [
            "filename:openapi.yaml",
            "filename:openapi.json",
            "filename:swagger.yaml",
            "filename:swagger.json",
        ])

    def test_api_name_filenames_appended_as_dot_json(self) -> None:
        c = _crawler(
            search_filenames=["openapi.yaml"],
            api_name_filenames=["stripe", "twilio"],
        )
        queries = c._build_search_queries()
        self.assertIn("filename:stripe.json", queries)
        self.assertIn("filename:twilio.json", queries)

    def test_empty_search_filenames_yields_no_queries(self) -> None:
        c = _crawler(search_filenames=[], api_name_filenames=[])
        self.assertEqual(c._build_search_queries(), [])

    def test_blank_and_whitespace_entries_are_skipped(self) -> None:
        c = _crawler(
            search_filenames=["openapi.yaml", "  ", ""],
            api_name_filenames=["  ", "github"],
        )
        queries = c._build_search_queries()
        # only "openapi.yaml" and "github" should produce queries
        self.assertEqual(len(queries), 2)
        self.assertIn("filename:openapi.yaml", queries)
        self.assertIn("filename:github.json", queries)

    def test_search_filenames_come_before_api_name_filenames(self) -> None:
        c = _crawler(
            search_filenames=["openapi.yaml"],
            api_name_filenames=["stripe"],
        )
        queries = c._build_search_queries()
        self.assertEqual(queries[0], "filename:openapi.yaml")
        self.assertEqual(queries[-1], "filename:stripe.json")

    def test_empty_api_name_filenames_adds_nothing_extra(self) -> None:
        c = _crawler(
            search_filenames=["openapi.yaml"],
            api_name_filenames=[],
        )
        queries = c._build_search_queries()
        self.assertEqual(queries, ["filename:openapi.yaml"])


# ---------------------------------------------------------------------------
# Crawler._spec_from_code_search_item (static method — no network)
# ---------------------------------------------------------------------------

class TestSpecFromCodeSearchItem(unittest.TestCase):

    def test_full_item_builds_correct_spec(self) -> None:
        item = _code_search_item(
            owner="stripe", repo="openapi", path="openapi.yaml",
            default_branch="master",
        )
        spec = Crawler._spec_from_code_search_item(item)
        self.assertIsNotNone(spec)
        self.assertEqual(spec.owner, "stripe")
        self.assertEqual(spec.repo, "openapi")
        self.assertEqual(spec.path, "openapi.yaml")
        self.assertEqual(spec.ref, "master")

    def test_spec_id_follows_github_owner_repo_path_pattern(self) -> None:
        item = _code_search_item(owner="acme", repo="api", path="specs/openapi.yaml")
        spec = Crawler._spec_from_code_search_item(item)
        self.assertEqual(spec.spec_id, "github:acme/api/specs/openapi.yaml")

    def test_raw_url_points_to_raw_githubusercontent(self) -> None:
        item = _code_search_item(
            owner="acme", repo="api", path="openapi.yaml", default_branch="main",
        )
        spec = Crawler._spec_from_code_search_item(item)
        self.assertTrue(
            spec.source_url.startswith("https://raw.githubusercontent.com/acme/api/main/"),
            msg=f"Unexpected raw URL: {spec.source_url}",
        )

    def test_html_url_used_when_present(self) -> None:
        explicit = "https://github.com/acme/api/blob/main/openapi.yaml"
        item = _code_search_item(html_url=explicit)
        spec = Crawler._spec_from_code_search_item(item)
        self.assertEqual(spec.html_url, explicit)

    def test_default_branch_falls_back_to_main(self) -> None:
        item = _code_search_item()
        # Remove default_branch to trigger the fallback
        del item["repository"]["default_branch"]
        spec = Crawler._spec_from_code_search_item(item)
        self.assertIsNotNone(spec)
        self.assertIn("/main/", spec.source_url)

    def test_missing_owner_returns_none(self) -> None:
        item = _code_search_item()
        del item["repository"]["owner"]
        self.assertIsNone(Crawler._spec_from_code_search_item(item))

    def test_missing_repo_name_returns_none(self) -> None:
        item = _code_search_item()
        del item["repository"]["name"]
        self.assertIsNone(Crawler._spec_from_code_search_item(item))

    def test_missing_path_returns_none(self) -> None:
        item = _code_search_item()
        del item["path"]
        self.assertIsNone(Crawler._spec_from_code_search_item(item))

    def test_path_with_spaces_is_percent_encoded_in_raw_url(self) -> None:
        item = _code_search_item(path="specs/my api/openapi.yaml")
        spec = Crawler._spec_from_code_search_item(item)
        self.assertIsNotNone(spec)
        self.assertIn("my%20api", spec.source_url)


if __name__ == "__main__":
    unittest.main()
