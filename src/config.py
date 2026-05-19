"""
Configuration loader.

Loads the YAML configuration file and overlays environment variables.
Nothing operational is hardcoded inside this module — every value
ultimately comes from config.yaml or the environment.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List

import yaml


@dataclass
class CrawlerConfig:
    search_filenames: List[str]
    api_name_filenames: List[str]
    bootstrap_repos: List[str]
    max_specs_per_run: int
    github_results_per_query: int
    github_api_base: str
    user_agent: str


@dataclass
class VersionerConfig:
    hash_algorithm: str


@dataclass
class CatalogConfig:
    path: str
    http_cache_path: str


@dataclass
class UpdaterConfig:
    polling_interval_seconds: int
    max_retries: int
    backoff_initial_seconds: float
    backoff_multiplier: float
    backoff_max_seconds: float
    request_timeout_seconds: int


@dataclass
class LoggingConfig:
    log_file: str
    level: str


@dataclass
class AppConfig:
    crawler: CrawlerConfig
    versioner: VersionerConfig
    catalog: CatalogConfig
    updater: UpdaterConfig
    logging: LoggingConfig
    github_token: str = ""

    @classmethod
    def load(cls, config_path: str | None = None) -> "AppConfig":
        path = Path(config_path or os.environ.get("CONFIG_PATH", "config.yaml"))
        if not path.exists():
            raise FileNotFoundError(f"Configuration file not found: {path}")

        with path.open("r", encoding="utf-8") as fh:
            raw: Dict[str, Any] = yaml.safe_load(fh) or {}

        try:
            return cls(
                crawler=CrawlerConfig(**raw["crawler"]),
                versioner=VersionerConfig(**raw["versioner"]),
                catalog=CatalogConfig(**raw["catalog"]),
                updater=UpdaterConfig(**raw["updater"]),
                logging=LoggingConfig(**raw["logging"]),
                github_token=os.environ.get("GITHUB_TOKEN", "").strip(),
            )
        except KeyError as exc:
            raise ValueError(f"Missing required config section/key: {exc}") from exc
