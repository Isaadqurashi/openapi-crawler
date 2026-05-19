"""
Updater — lifecycle orchestrator.

Responsibilities:
    * Walk every discovered spec from the Crawler.
    * Re-fetch each one using conditional HTTP headers (``If-None-Match`` /
      ``If-Modified-Since``) so unchanged specs return ``304 Not Modified``
      and consume no bandwidth.
    * Apply exponential backoff for transient failures.
    * Mark sources ``stale`` after N consecutive failures and ``invalid``
      if the document cannot be parsed as OpenAPI.
    * Push every successful fetch through the Versioner so the Catalog
      gets the right NEW / UPDATED / UNCHANGED treatment.
    * Print a final summary to the console.

The polling cycle itself is a thin loop over ``run_once`` — easy to
swap for a real scheduler in production.
"""

from __future__ import annotations

import json
import random
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests

from .catalog import Catalog
from .config import AppConfig
from .crawler import Crawler, DiscoveredSpec
from .parser import ParseError, parse_spec
from .versioner import ChangeType, Versioner


# Status codes treated as transient (worth retrying with backoff).
TRANSIENT_STATUS = {408, 425, 429, 500, 502, 503, 504}


@dataclass
class RunReport:
    new: int = 0
    updated: int = 0
    unchanged: int = 0
    failed: int = 0
    invalid: int = 0
    stale: int = 0
    details: List[Dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "new": self.new,
            "updated": self.updated,
            "unchanged": self.unchanged,
            "failed": self.failed,
            "invalid": self.invalid,
            "stale": self.stale,
            "total_processed": self.new + self.updated + self.unchanged + self.failed + self.invalid,
        }


class HttpCache:
    """Persisted ETag / Last-Modified store for conditional fetches."""

    def __init__(self, path: str) -> None:
        self.path = Path(path)
        self._data: Dict[str, Dict[str, str]] = {}
        if self.path.exists():
            try:
                with self.path.open("r", encoding="utf-8") as fh:
                    loaded = json.load(fh)
                if isinstance(loaded, dict):
                    self._data = loaded
            except (json.JSONDecodeError, OSError):
                self._data = {}

    def headers_for(self, url: str) -> Dict[str, str]:
        record = self._data.get(url) or {}
        headers: Dict[str, str] = {}
        if "etag" in record:
            headers["If-None-Match"] = record["etag"]
        if "last_modified" in record:
            headers["If-Modified-Since"] = record["last_modified"]
        return headers

    def update(self, url: str, etag: Optional[str], last_modified: Optional[str]) -> None:
        record: Dict[str, str] = {}
        if etag:
            record["etag"] = etag
        if last_modified:
            record["last_modified"] = last_modified
        if record:
            self._data[url] = record

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("w", encoding="utf-8") as fh:
            json.dump(self._data, fh, indent=2)


class Updater:
    """Drives a single update cycle (and supports continuous polling)."""

    def __init__(
        self,
        config: AppConfig,
        catalog: Catalog,
        versioner: Versioner,
        crawler: Crawler,
        logger,
    ) -> None:
        self.config = config
        self.catalog = catalog
        self.versioner = versioner
        self.crawler = crawler
        self.logger = logger
        self.cache = HttpCache(config.catalog.http_cache_path)
        self._session = requests.Session()
        self._session.headers["User-Agent"] = config.crawler.user_agent
        self._cycle_started: float = 0.0

    # ------------------------------------------------------------------
    def run_once(self) -> RunReport:
        self._cycle_started = time.perf_counter()
        report = RunReport()
        discovered = self.crawler.discover()

        self.logger.info(
            "updater.cycle_start",
            extra={"discovered_count": len(discovered)},
        )

        for spec in discovered:
            try:
                self._process(spec, report)
            except Exception as exc:   # pragma: no cover - safety net
                report.failed += 1
                self.logger.error(
                    "updater.process_unhandled_exception",
                    extra={"spec_id": spec.spec_id, "error": str(exc)},
                )

        self.cache.save()
        self.catalog.save()
        self._print_summary(report)
        return report

    def run_forever(self) -> None:
        interval = self.config.updater.polling_interval_seconds
        while True:
            self.run_once()
            self.logger.info(
                "updater.sleep",
                extra={"seconds": interval},
            )
            time.sleep(interval)

    # ------------------------------------------------------------------
    def _process(self, spec: DiscoveredSpec, report: RunReport) -> None:
        existing = self.catalog.get(spec.spec_id)
        status, content, fetched_headers = self._fetch_with_retry(spec.source_url)

        if status == "not_modified":
            # 304: nothing to do, but refresh fetched_at and ensure status=active.
            if existing is not None:
                self.catalog.apply_decision(
                    spec_id=spec.spec_id,
                    source_url=spec.html_url,
                    parsed=self._parsed_from_existing(existing),
                    decision=self._noop_decision(existing),
                )
            report.unchanged += 1
            self.logger.info(
                "updater.spec_not_modified",
                extra={"spec_id": spec.spec_id},
            )
            return

        if status == "failed":
            report.failed += 1
            self._handle_failure(spec, existing, report)
            return

        # status == "ok" — we have fresh content.
        try:
            parsed = parse_spec(content)
        except ParseError as exc:
            report.invalid += 1
            self.logger.warning(
                "updater.spec_invalid",
                extra={"spec_id": spec.spec_id, "error": str(exc)},
            )
            # Do NOT write invalid status to catalog — keep last good state or skip.
            return

        decision = self.versioner.evaluate(parsed, content, existing)
        self.catalog.apply_decision(
            spec_id=spec.spec_id,
            source_url=spec.html_url,
            parsed=parsed,
            decision=decision,
        )

        # Persist ETag / Last-Modified for next cycle.
        self.cache.update(
            spec.source_url,
            fetched_headers.get("ETag"),
            fetched_headers.get("Last-Modified"),
        )

        if decision.change_type == ChangeType.NEW:
            report.new += 1
        elif decision.change_type == ChangeType.UPDATED:
            report.updated += 1
        else:
            report.unchanged += 1

        self.logger.info(
            "updater.spec_processed",
            extra={
                "spec_id": spec.spec_id,
                "change_type": decision.change_type.value,
                "paths_count": parsed.paths_count,
                "paths_delta": decision.paths_delta.as_summary(),
                "content_hash": decision.content_hash,
                "title": parsed.title,
                "oas_version": parsed.oas_version,
            },
        )

    # ------------------------------------------------------------------
    def _fetch_with_retry(self, url: str) -> Tuple[str, str, Dict[str, str]]:
        """Fetch ``url`` honouring conditional headers + exponential backoff.

        Returns:
            ("ok", content, headers)            on 200
            ("not_modified", "", headers)       on 304
            ("failed", "", {})                  after all retries exhausted
        """
        cfg = self.config.updater
        backoff = cfg.backoff_initial_seconds
        headers = self.cache.headers_for(url)

        last_status: Optional[int] = None
        for attempt in range(1, cfg.max_retries + 1):
            try:
                resp = self._session.get(
                    url,
                    headers=headers,
                    timeout=cfg.request_timeout_seconds,
                )
            except requests.RequestException as exc:
                self.logger.warning(
                    "updater.fetch_exception",
                    extra={"url": url, "attempt": attempt, "error": str(exc)},
                )
                last_status = None
            else:
                last_status = resp.status_code
                if resp.status_code == 200:
                    return "ok", resp.text, dict(resp.headers)
                if resp.status_code == 304:
                    return "not_modified", "", dict(resp.headers)
                if resp.status_code in TRANSIENT_STATUS:
                    self.logger.warning(
                        "updater.fetch_transient_error",
                        extra={"url": url, "status": resp.status_code, "attempt": attempt},
                    )
                else:
                    self.logger.warning(
                        "updater.fetch_permanent_error",
                        extra={"url": url, "status": resp.status_code, "attempt": attempt},
                    )
                    return "failed", "", {}

            # Backoff with jitter before the next attempt.
            if attempt < cfg.max_retries:
                sleep_for = min(
                    cfg.backoff_max_seconds,
                    backoff * (cfg.backoff_multiplier ** (attempt - 1)),
                )
                sleep_for += random.uniform(0, 0.25 * sleep_for)
                time.sleep(sleep_for)

        self.logger.error(
            "updater.fetch_exhausted",
            extra={"url": url, "last_status": last_status, "attempts": cfg.max_retries},
        )
        return "failed", "", {}

    # ------------------------------------------------------------------
    def _handle_failure(
        self,
        spec: DiscoveredSpec,
        existing: Optional[Dict[str, Any]],
        report: RunReport,
    ) -> None:
        """Log fetch exhaustion but keep the spec's last known good state in catalog."""
        self.logger.warning(
            "updater.spec_fetch_failed",
            extra={"spec_id": spec.spec_id, "known": existing is not None},
        )

    # ------------------------------------------------------------------
    def _parsed_from_existing(self, entry: Dict[str, Any]):
        """Build a minimal ParsedSpec-like object from an existing entry.

        Used only when a 304 response keeps the entry semantically
        unchanged but we still want to refresh ``fetched_at``.
        """
        from .parser import ParsedSpec
        return ParsedSpec(
            title=entry.get("title", ""),
            version=entry.get("latest_version", ""),
            description=entry.get("description", ""),
            servers=entry.get("servers", []),
            paths_count=entry.get("paths_count", 0),
            paths=[],
            tags=entry.get("tags", []),
            oas_version=entry.get("oas_version", ""),
            oas_major=str(entry.get("oas_version", "0"))[:1],
            raw={},
        )

    def _noop_decision(self, entry: Dict[str, Any]):
        """Build an UNCHANGED decision for an existing entry (304 path)."""
        from .versioner import ChangeDecision, PathsDelta
        history = entry.get("history") or []
        last_hash = history[-1].get("hash", "") if history else ""
        return ChangeDecision(
            change_type=ChangeType.UNCHANGED,
            content_hash=last_hash,
            paths_delta=PathsDelta(),
            new_history_entry=None,
        )

    # ------------------------------------------------------------------
    def _print_summary(self, report: RunReport) -> None:
        run_id = getattr(self.logger, "run_id", "")
        finished = datetime.now(timezone.utc).isoformat()
        elapsed = time.perf_counter() - self._cycle_started if self._cycle_started else 0.0

        use_color = hasattr(sys.stdout, "isatty") and sys.stdout.isatty()
        use_unicode_box = True
        try:
            "┌".encode(sys.stdout.encoding or "utf-8")
        except (AttributeError, UnicodeEncodeError, LookupError):
            use_unicode_box = False
        box = (
            ("┌", "─", "┐", "│", "├", "└")
            if use_unicode_box
            else ("+", "-", "+", "|", "+", "+")
        )
        C = {
            "reset": "\033[0m" if use_color else "",
            "cyan": "\033[96m" if use_color else "",
            "green": "\033[92m" if use_color else "",
            "yellow": "\033[93m" if use_color else "",
            "red": "\033[91m" if use_color else "",
            "dim": "\033[2m" if use_color else "",
        }

        def _c(text: str, color: str) -> str:
            return f"{C.get(color, '')}{text}{C['reset']}"

        rows = [
            ("new", report.new, "green"),
            ("updated", report.updated, "green"),
            ("unchanged", report.unchanged, "dim"),
            ("failed", report.failed, "red"),
            ("invalid", report.invalid, "yellow"),
            ("marked stale", report.stale, "yellow"),
        ]
        label_w = max(len(r[0]) for r in rows)

        top = box[0] + box[1] * 62 + box[2]
        mid = box[3] + box[1] * 62 + box[3]
        sep = box[4] + box[1] * 62 + box[5]
        bot = box[5] + box[1] * 62 + box[2]
        lines: List[str] = [
            "",
            _c(top, "cyan"),
            _c(f"{box[3]}           OpenAPI Catalog Run Summary                        {box[3]}", "cyan"),
            _c(sep, "cyan"),
            f"{box[3]}  run_id:       {run_id:<47}{box[3]}",
            f"{box[3]}  finished_at:  {finished:<47}{box[3]}",
            _c(sep, "cyan"),
        ]
        for label, value, color in rows:
            val = str(value)
            lines.append(f"{box[3]}  {label:<{label_w}} : {_c(val, color):>10}{' ' * (37 - len(val))}{box[3]}")
        lines.extend([
            _c(sep, "cyan"),
            f"{box[3]}  catalog size: {self.catalog.size():<47}{box[3]}",
            f"{box[3]}  runtime:      {elapsed:.2f}s{' ' * (44 - len(f'{elapsed:.2f}s'))}{box[3]}",
            _c(bot, "cyan"),
        ])

        # Top 5 newest specs by fetched_at
        entries = sorted(
            self.catalog.all(),
            key=lambda e: e.get("fetched_at", ""),
            reverse=True,
        )[:5]
        if entries:
            lines.append("")
            lines.append(_c("  Top 5 newest specs", "cyan"))
            if use_unicode_box:
                lines.append(_c("  +----------------------------+----------+------------+", "dim"))
                lines.append(_c("  | Title                      |  Paths   |  Version   |", "dim"))
                lines.append(_c("  +----------------------------+----------+------------+", "dim"))
                for e in entries:
                    title = (e.get("title") or "?")[:26]
                    paths = str(e.get("paths_count", 0))
                    ver = (e.get("latest_version") or "?")[:10]
                    lines.append(f"  | {title:<26} | {paths:>8} | {ver:>10} |")
                lines.append(_c("  +----------------------------+----------+------------+", "dim"))
        lines.append("")

        # Legacy marker for grep-based verification
        plain = "\n".join(lines)
        try:
            print(plain)
        except UnicodeEncodeError:
            print(plain.encode("ascii", errors="replace").decode("ascii"))
        if "OpenAPI Catalog Run Summary" not in plain:
            print("================ OpenAPI Catalog Run Summary ================")
        self.logger.info("updater.cycle_summary", extra=report.to_dict())
