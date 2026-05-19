"""
Crawler — source discovery.

Two complementary discovery strategies:

1. **GitHub Code Search** for every filename pattern in the config
   (``openapi.yaml``, ``openapi.json``, ``swagger.yaml``, ``swagger.json``
   and any configured ``{API NAME}.json`` patterns).

2. **Bootstrap repos** — a configurable list of well-known repositories.
   For each, we hit the GitHub Git Tree API (``recursive=1``) and pick
   out any file whose basename matches one of the search patterns. This
   is much more reliable than Code Search (which is heavily rate
   limited and only indexes a fraction of public code).

The crawler yields ``DiscoveredSpec`` records and stops once
``max_specs_per_run`` distinct specs have been seen. Each record carries
enough metadata for the Updater to actually fetch the raw bytes.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, Iterator, List, Optional, Set
from urllib.parse import quote

import requests

from .config import CrawlerConfig


@dataclass(frozen=True)
class DiscoveredSpec:
    """A spec we plan to fetch.

    ``spec_id`` follows the pattern ``github:{owner}/{repo}/{path}`` so
    every spec has a stable identifier across runs.
    """
    spec_id: str
    source_url: str       # Raw file URL — the URL the Updater fetches.
    html_url: str         # Human-friendly URL for the catalog/logs.
    owner: str
    repo: str
    path: str
    ref: Optional[str] = None   # Branch/commit; None means default branch.


class GitHubClient:
    """Thin GitHub REST wrapper with built-in rate-limit awareness."""

    def __init__(self, base_url: str, token: str, user_agent: str, timeout: int = 20) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._session = requests.Session()
        self._session.headers.update({
            "Accept": "application/vnd.github+json",
            "User-Agent": user_agent,
            "X-GitHub-Api-Version": "2022-11-28",
        })
        if token:
            self._session.headers["Authorization"] = f"Bearer {token}"

    def get(self, path: str, params: Optional[Dict[str, str | int]] = None) -> requests.Response:
        url = path if path.startswith("http") else f"{self.base_url}{path}"
        return self._session.get(url, params=params, timeout=self.timeout)

    def has_token(self) -> bool:
        return "Authorization" in self._session.headers


class Crawler:
    """Discovers candidate OpenAPI specs from GitHub."""

    def __init__(self, config: CrawlerConfig, github_token: str, logger) -> None:
        self.cfg = config
        self.logger = logger
        self.gh = GitHubClient(
            base_url=config.github_api_base,
            token=github_token,
            user_agent=config.user_agent,
        )

    # ------------------------------------------------------------------
    def discover(self) -> List[DiscoveredSpec]:
        """Run all discovery strategies and return de-duplicated specs."""
        seen: Set[str] = set()
        results: List[DiscoveredSpec] = []
        limit = self.cfg.max_specs_per_run

        def _add(spec: DiscoveredSpec) -> bool:
            """Return True if the loop should stop (limit reached)."""
            if spec.spec_id in seen:
                return False
            seen.add(spec.spec_id)
            results.append(spec)
            return len(results) >= limit

        # 1) GitHub Code Search — collect results per query with a per-query
        #    minimum quota so all 4 filename types always get representation.
        #    Without a quota the most-common pattern fills the cap before
        #    rarer patterns such as swagger.json ever get any slots.
        if not self.gh.has_token():
            self.logger.warning(
                "crawler.code_search_skipped",
                extra={"reason": "GITHUB_TOKEN not set; code search requires auth"},
            )
        else:
            queries = self._build_search_queries()
            if queries:
                # Give each query at least this many slots before overflow sharing.
                # Without this the first search pattern (most common) fills the
                # cap before later patterns such as swagger.json get any slots.
                per_query_min = max(1, limit // len(queries))
                # Collect per-query buckets first, then merge in round-robin order.
                buckets: List[List[DiscoveredSpec]] = []
                for query in queries:
                    bucket: List[DiscoveredSpec] = []
                    for spec in self._search_github(query):
                        if spec.spec_id not in seen and len(bucket) < per_query_min:
                            bucket.append(spec)
                    buckets.append(bucket)

                # Round-robin merge: take one from each bucket in turn until limit.
                any_left = True
                idx = 0
                while any_left and len(results) < limit:
                    any_left = False
                    for bucket in buckets:
                        if idx < len(bucket):
                            _add(bucket[idx])
                            any_left = True
                            if len(results) >= limit:
                                break
                    idx += 1

                # Fill remaining slots with overflow from any query, in order.
                if len(results) < limit:
                    for query in queries:
                        for spec in self._search_github(query):
                            if len(results) >= limit:
                                break
                            _add(spec)

            if len(results) >= limit:
                self.logger.info(
                    "crawler.limit_reached",
                    extra={"stage": "code_search", "count": len(results)},
                )
                return results

        # 2) Bootstrap repos — cheap (1 tree API call per repo).
        for repo_spec in self.cfg.bootstrap_repos:
            for spec in self._crawl_bootstrap_repo(repo_spec):
                if _add(spec):
                    self.logger.info(
                        "crawler.limit_reached",
                        extra={"stage": "bootstrap", "count": len(results)},
                    )
                    return results

        self.logger.info(
            "crawler.discovery_complete",
            extra={"discovered": len(results)},
        )
        return results

    # ------------------------------------------------------------------
    def _build_search_queries(self) -> List[str]:
        """One query per filename pattern — no compound/invalid queries."""
        queries: List[str] = []
        for fname in self.cfg.search_filenames:
            fname = fname.strip()
            if fname:
                queries.append(f"filename:{fname}")
        for api in self.cfg.api_name_filenames:
            api = api.strip()
            if api:
                queries.append(f"filename:{api}.json")
        return queries

    def _search_github(self, query: str) -> Iterator[DiscoveredSpec]:
        """Call ``/search/code`` for a single filename query."""
        per_page = max(1, min(self.cfg.github_results_per_query, 100))
        try:
            resp = self.gh.get(
                "/search/code",
                params={"q": query, "per_page": per_page},
            )
        except requests.RequestException as exc:
            self.logger.error(
                "crawler.code_search_request_failed",
                extra={"query": query, "error": str(exc)},
            )
            return

        if resp.status_code == 403 and "rate limit" in resp.text.lower():
            self.logger.warning(
                "crawler.code_search_rate_limited",
                extra={"query": query, "status": resp.status_code},
            )
            return

        if resp.status_code != 200:
            self.logger.warning(
                "crawler.code_search_non_200",
                extra={
                    "query": query,
                    "status": resp.status_code,
                    "body_snippet": resp.text[:200],
                },
            )
            return

        items = resp.json().get("items", [])
        self.logger.info(
            "crawler.code_search_results",
            extra={"query": query, "count": len(items)},
        )

        # GitHub Code Search `filename:` is a *substring* match, so it also
        # returns backup and template variants (.bak, .txt, .tpl, etc.).
        # Enforce an exact basename check so only canonical filenames pass.
        canonical = {f.lower() for f in self.cfg.search_filenames}
        canonical.update(
            {f"{n.strip().lower()}.json" for n in self.cfg.api_name_filenames if n.strip()}
        )

        for item in items:
            spec = self._spec_from_code_search_item(item)
            if spec is None:
                continue
            if spec.path.rsplit("/", 1)[-1].lower() not in canonical:
                continue
            yield spec

    @staticmethod
    def _spec_from_code_search_item(item: Dict) -> Optional[DiscoveredSpec]:
        repo = item.get("repository") or {}
        owner = (repo.get("owner") or {}).get("login")
        repo_name = repo.get("name")
        path = item.get("path")
        html_url = item.get("html_url")
        default_branch = repo.get("default_branch") or "main"
        if not (owner and repo_name and path):
            return None
        raw_url = (
            f"https://raw.githubusercontent.com/"
            f"{owner}/{repo_name}/{default_branch}/{quote(path)}"
        )
        return DiscoveredSpec(
            spec_id=f"github:{owner}/{repo_name}/{path}",
            source_url=raw_url,
            html_url=html_url or raw_url,
            owner=owner,
            repo=repo_name,
            path=path,
            ref=default_branch,
        )

    # ------------------------------------------------------------------
    def _crawl_bootstrap_repo(self, repo_spec: str) -> Iterator[DiscoveredSpec]:
        """Walk a single bootstrap repo via the Git Tree API."""
        if ":" in repo_spec:
            full, ref = repo_spec.split(":", 1)
        else:
            full, ref = repo_spec, None
        if "/" not in full:
            self.logger.warning(
                "crawler.bootstrap_invalid_repo",
                extra={"repo_spec": repo_spec},
            )
            return
        owner, repo_name = full.split("/", 1)

        # Resolve the default branch if no ref was supplied.
        if not ref:
            try:
                meta = self.gh.get(f"/repos/{owner}/{repo_name}")
                if meta.status_code != 200:
                    self.logger.warning(
                        "crawler.bootstrap_repo_meta_failed",
                        extra={"repo": full, "status": meta.status_code},
                    )
                    return
                ref = meta.json().get("default_branch") or "main"
            except requests.RequestException as exc:
                self.logger.error(
                    "crawler.bootstrap_repo_meta_error",
                    extra={"repo": full, "error": str(exc)},
                )
                return

        try:
            tree_resp = self.gh.get(
                f"/repos/{owner}/{repo_name}/git/trees/{ref}",
                params={"recursive": 1},
            )
        except requests.RequestException as exc:
            self.logger.error(
                "crawler.bootstrap_tree_error",
                extra={"repo": full, "error": str(exc)},
            )
            return

        if tree_resp.status_code != 200:
            self.logger.warning(
                "crawler.bootstrap_tree_failed",
                extra={"repo": full, "status": tree_resp.status_code},
            )
            return

        body = tree_resp.json()
        truncated = body.get("truncated", False)
        if truncated:
            self.logger.warning(
                "crawler.bootstrap_tree_truncated",
                extra={"repo": full, "ref": ref},
            )

        matchers = {f.lower() for f in self.cfg.search_filenames}
        # Also accept any of the configured {API NAME}.json patterns.
        matchers.update({f"{n.strip().lower()}.json" for n in self.cfg.api_name_filenames if n.strip()})

        match_count = 0
        for entry in body.get("tree", []):
            if entry.get("type") != "blob":
                continue
            path = entry.get("path") or ""
            base = path.rsplit("/", 1)[-1].lower()
            if base not in matchers:
                continue
            raw_url = (
                f"https://raw.githubusercontent.com/"
                f"{owner}/{repo_name}/{ref}/{quote(path)}"
            )
            html_url = f"https://github.com/{owner}/{repo_name}/blob/{ref}/{quote(path)}"
            match_count += 1
            yield DiscoveredSpec(
                spec_id=f"github:{owner}/{repo_name}/{path}",
                source_url=raw_url,
                html_url=html_url,
                owner=owner,
                repo=repo_name,
                path=path,
                ref=ref,
            )

        self.logger.info(
            "crawler.bootstrap_repo_complete",
            extra={"repo": full, "ref": ref, "matches": match_count},
        )
