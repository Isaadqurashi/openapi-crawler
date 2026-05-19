"""
Entry point.

Usage:
    python -m src.main                  # one update cycle, then exit
    python -m src.main --watch          # poll forever (24h default interval)
    python -m src.main --config foo.yaml
"""

from __future__ import annotations

import argparse
import sys

from .catalog import Catalog
from .config import AppConfig
from .crawler import Crawler
from .logger import configure_logger
from .updater import Updater
from .versioner import Versioner


def build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="OpenAPI Catalog runner.")
    p.add_argument("--config", default=None, help="Path to YAML config file.")
    p.add_argument("--watch", action="store_true", help="Run continuously, polling on the configured interval.")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_argparser().parse_args(argv)

    config = AppConfig.load(args.config)
    logger = configure_logger(
        name="openapi-catalog",
        log_file=config.logging.log_file,
        level=config.logging.level,
    )

    logger.info(
        "main.startup",
        extra={
            "github_token_set": bool(config.github_token),
            "bootstrap_repo_count": len(config.crawler.bootstrap_repos),
            "search_filenames": config.crawler.search_filenames,
            "max_specs_per_run": config.crawler.max_specs_per_run,
        },
    )

    catalog = Catalog(config.catalog.path)
    versioner = Versioner(config.versioner.hash_algorithm)
    crawler = Crawler(config.crawler, config.github_token, logger)
    updater = Updater(config, catalog, versioner, crawler, logger)

    if args.watch:
        try:
            updater.run_forever()
        except KeyboardInterrupt:
            logger.info("main.shutdown", extra={"reason": "keyboard interrupt"})
            return 0
    else:
        updater.run_once()
    return 0


if __name__ == "__main__":
    sys.exit(main())
