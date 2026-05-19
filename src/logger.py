"""
Structured JSON logger.

Every log record is a single JSON object containing the run_id so traces
from a particular execution can be filtered downstream. The logger writes
to both stdout and a configured log file.
"""

from __future__ import annotations

import json
import logging
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict


class JsonFormatter(logging.Formatter):
    """Render each LogRecord as a single-line JSON document."""

    def __init__(self, run_id: str) -> None:
        super().__init__()
        self.run_id = run_id

    def format(self, record: logging.LogRecord) -> str:
        payload: Dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "run_id": self.run_id,
            "logger": record.name,
            "message": record.getMessage(),
        }

        # Attach any structured "extra" fields the caller passed in.
        for key, value in record.__dict__.items():
            if key in (
                "name", "msg", "args", "levelname", "levelno", "pathname",
                "filename", "module", "exc_info", "exc_text", "stack_info",
                "lineno", "funcName", "created", "msecs", "relativeCreated",
                "thread", "threadName", "processName", "process", "message",
                "taskName",
            ):
                continue
            payload[key] = value

        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)

        return json.dumps(payload, default=str)


def configure_logger(name: str, log_file: str, level: str, run_id: str | None = None) -> logging.Logger:
    """Create a logger that writes structured JSON to stdout and a file."""
    run_id = run_id or uuid.uuid4().hex[:12]

    logger = logging.getLogger(name)
    logger.setLevel(getattr(logging, level.upper(), logging.INFO))
    # Prevent duplicate handlers when re-initialising.
    logger.handlers.clear()
    logger.propagate = False

    formatter = JsonFormatter(run_id=run_id)

    stdout_handler = logging.StreamHandler(sys.stdout)
    stdout_handler.setFormatter(formatter)
    logger.addHandler(stdout_handler)

    log_path = Path(log_file)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    file_handler = logging.FileHandler(log_path, encoding="utf-8")
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)

    # Stash the run_id on the logger so callers can read it back.
    logger.run_id = run_id  # type: ignore[attr-defined]
    return logger
