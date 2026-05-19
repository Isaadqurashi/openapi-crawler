"""
Demo tamper script — simulates a spec update for the Loom demo.

What it does:
  1. Picks the first active entry from catalog.json
  2. Zeros its last history hash  (forces versioner to see hash_changed=True)
  3. Removes its ETag from http_cache.json (forces a fresh 200 re-fetch)

After running this, `python -m src.main` will show that spec as UPDATED
with a new history entry and a real paths_delta diff.

Usage:
    python tamper.py
"""
from __future__ import annotations

import json
from pathlib import Path

CATALOG_PATH   = Path("data/catalog.json")
CACHE_PATH     = Path("data/http_cache.json")


def tamper() -> None:
    # ── load catalog ─────────────────────────────────────────────────────
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    entries = catalog.get("entries", [])
    if not entries:
        print("[tamper] catalog is empty — run the initial crawl first.")
        return

    # Pick first active entry that already has at least one history entry.
    target = next(
        (e for e in entries if e.get("status") == "active" and e.get("history")),
        entries[0],
    )

    spec_id     = target["id"]
    source_url  = target.get("source_url", "")
    history     = target.get("history", [])

    old_hash = history[-1].get("hash", "n/a") if history else "n/a"
    zeroed   = "sha256:" + "0" * 64

    if history:
        history[-1]["hash"] = zeroed

    CATALOG_PATH.write_text(
        json.dumps(catalog, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"[tamper] spec      : {spec_id}")
    print(f"[tamper] old hash  : {old_hash[:30]}...")
    print(f"[tamper] new hash  : {zeroed[:30]}...  (zeroed)")

    # ── clear ETag from http cache so the next run does a fresh fetch ────
    # (Without this the server returns 304 Not Modified and the versioner
    #  is never called, so the zeroed hash would never be detected.)
    raw_url = source_url.replace(
        "https://github.com/", "https://raw.githubusercontent.com/"
    ).replace("/blob/", "/")

    cache = json.loads(CACHE_PATH.read_text(encoding="utf-8")) if CACHE_PATH.exists() else {}

    # Derive owner/repo and file path from spec_id.
    # spec_id format: "github:owner/repo/path/to/file.yaml"
    spec_path  = spec_id.split(":", 1)[-1]         # "owner/repo/path/to/file.yaml"
    parts      = spec_path.split("/", 2)            # ["owner", "repo", "path/to/file.yaml"]
    owner_repo = f"{parts[0]}/{parts[1]}" if len(parts) >= 2 else spec_path
    file_path  = parts[2] if len(parts) == 3 else ""

    removed_url = None
    for url in list(cache.keys()):
        # The raw URL contains a ref between owner/repo and path, so match both segments.
        if (
            "raw.githubusercontent.com" in url
            and owner_repo.lower() in url.lower()
            and (not file_path or file_path.lower() in url.lower())
        ):
            del cache[url]
            removed_url = url
            break

    if removed_url:
        CACHE_PATH.write_text(
            json.dumps(cache, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        print(f"[tamper] cache     : removed ETag for {removed_url[:60]}...")
    else:
        print("[tamper] cache     : no matching ETag found (will still re-fetch on next run)")

    print()
    print("[tamper] Done — now run:  python -m src.main")
    print("         The spec above will appear as UPDATED with a new history entry.")


if __name__ == "__main__":
    tamper()
