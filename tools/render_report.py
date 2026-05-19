#!/usr/bin/env python3
"""Generate human-readable Markdown and HTML reports from catalog.json."""

from __future__ import annotations

import json
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

ROOT         = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "data" / "catalog.json"
MD_PATH      = ROOT / "data" / "REPORT.md"
HTML_PATH    = ROOT / "data" / "REPORT.html"

CANONICAL_FILES = {"openapi.yaml", "openapi.json", "swagger.yaml", "swagger.json"}

SOURCE_LABELS = {
    "openapi.yaml": ("OAS 3.x YAML", "#5eb3ff"),
    "openapi.json": ("OAS 3.x JSON", "#3dd68c"),
    "swagger.yaml": ("Swagger 2.x YAML", "#f5c542"),
    "swagger.json": ("Swagger 2.x JSON", "#f97316"),
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_catalog() -> dict:
    with CATALOG_PATH.open(encoding="utf-8") as fh:
        return json.load(fh)


def source_file(entry: dict) -> str:
    """Return the spec filename from the entry id, e.g. 'openapi.yaml'."""
    eid = entry.get("id", "")
    return eid.split("/")[-1].lower() if "/" in eid else eid.lower()


def oas_bucket(version: str) -> str:
    v = str(version or "")
    if v.startswith("2"):
        return "OAS 2.x"
    if v.startswith("3"):
        return "OAS 3.x"
    return "Other"


def top_by_paths(entries: list[dict], n: int = 10) -> list[dict]:
    return sorted(entries, key=lambda e: e.get("paths_count", 0), reverse=True)[:n]


def most_updated(entries: list[dict], n: int = 10) -> list[dict]:
    return sorted(entries, key=lambda e: len(e.get("history", [])), reverse=True)[:n]


def recently_updated(entries: list[dict], n: int = 10) -> list[dict]:
    return sorted(entries, key=lambda e: e.get("fetched_at", ""), reverse=True)[:n]


def ascii_bar(values: list[int], width: int = 40) -> list[str]:
    if not values:
        return ["_(no data)_"]
    buckets = [(0, 10), (11, 25), (26, 50), (51, 100), (101, 10_000)]
    labels  = ["    0-10", "   11-25", "   26-50", "  51-100", "    100+"]
    counts  = [sum(1 for v in values if lo <= v <= hi) for lo, hi in buckets]
    max_c   = max(counts) or 1
    return [
        f"{label} | {'#' * int((c / max_c) * width)} {c}"
        for label, c in zip(labels, counts)
    ]


def _esc(s: object) -> str:
    return (
        str(s or "")
        .replace("&", "&amp;").replace("<", "&lt;")
        .replace(">", "&gt;").replace('"', "&quot;")
    )


def _source_badge(sf: str) -> str:
    label, color = SOURCE_LABELS.get(sf, (sf or "unknown", "#8b9cb3"))
    return (
        f'<span class="badge" style="background:rgba(0,0,0,0.3);'
        f'color:{color};border:1px solid {color}40">{_esc(label)}</span>'
    )


# ---------------------------------------------------------------------------
# Markdown
# ---------------------------------------------------------------------------

def build_markdown(data: dict) -> str:
    entries = data.get("entries", [])
    active  = [e for e in entries if e.get("status") == "active"]
    gen     = datetime.now().astimezone().isoformat()

    oas_counts = Counter(oas_bucket(e.get("oas_version", "")) for e in active)
    src_counts = Counter(source_file(e) for e in active)
    paths      = [e.get("paths_count", 0) for e in active]

    lines = [
        "# OpenAPI Catalog Report", "",
        f"_Generated {gen}_", "",
        "## Overview", "",
        f"- **Total specs:** {len(entries)}",
        f"- **Active specs:** {len(active)}",
        f"- **Catalog generated_at:** {data.get('generated_at', 'n/a')}", "",
        "## Breakdown by source file", "",
        "| Source File | Count | Description |",
        "|-------------|------:|-------------|",
    ]
    for sf in ("openapi.yaml", "openapi.json", "swagger.yaml", "swagger.json"):
        label, _ = SOURCE_LABELS[sf]
        lines.append(f"| `{sf}` | {src_counts.get(sf, 0)} | {label} |")
    other = {k: v for k, v in src_counts.items() if k not in CANONICAL_FILES}
    if other:
        lines.append(f"| _(other)_ | {sum(other.values())} | non-canonical filenames |")

    lines.extend(["", "## Breakdown by OAS version", "", "| Version | Count |", "|---------|------:|"])
    for k in ("OAS 2.x", "OAS 3.x", "Other"):
        if oas_counts.get(k, 0):
            lines.append(f"| {k} | {oas_counts[k]} |")

    lines.extend([
        "", "## Top 10 active APIs by paths_count", "",
        "| Title | Source File | OAS | Paths | Version |",
        "|-------|-------------|-----|------:|---------|",
    ])
    for e in top_by_paths(active):
        lines.append(
            f"| {e.get('title','?')} | `{source_file(e)}` "
            f"| {e.get('oas_version','?')} "
            f"| {e.get('paths_count',0)} | {e.get('latest_version','?')} |"
        )

    lines.extend([
        "", "## Most recently fetched (active)", "",
        "| Title | Source File | Fetched at | Paths |",
        "|-------|-------------|------------|------:|",
    ])
    for e in recently_updated(active):
        lines.append(
            f"| {e.get('title','?')} | `{source_file(e)}` "
            f"| {e.get('fetched_at','?')} | {e.get('paths_count',0)} |"
        )

    lines.extend(["", "## paths_count distribution (active specs)", "", "```", *ascii_bar(paths), "```"])

    lines.extend([
        "", "## Most-updated specs (history length)", "",
        "| Title | Source File | History entries | Latest version |",
        "|-------|-------------|----------------:|----------------|",
    ])
    for e in most_updated(active):
        lines.append(
            f"| {e.get('title','?')} | `{source_file(e)}` "
            f"| {len(e.get('history',[]))} | {e.get('latest_version','?')} |"
        )
    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# HTML
# ---------------------------------------------------------------------------

def build_html(data: dict) -> str:
    entries = data.get("entries", [])
    active  = [e for e in entries if e.get("status") == "active"]
    gen     = datetime.now().astimezone().isoformat()

    oas_counts = Counter(oas_bucket(e.get("oas_version", "")) for e in active)
    src_counts = Counter(source_file(e) for e in active)
    hist_lines = "\n".join(ascii_bar([e.get("paths_count", 0) for e in active]))

    # --- stat tiles ----------------------------------------------------------
    def stat(label: str, value, color: str = "#5eb3ff") -> str:
        return (
            f'<div class="stat">'
            f'<div class="stat-label">{_esc(label)}</div>'
            f'<div class="stat-value" style="color:{color}">{_esc(value)}</div>'
            f'</div>'
        )

    stats_html = "".join([
        stat("Total specs",       len(entries)),
        stat("Active",            len(active),                    "#3dd68c"),
        stat("OAS 2.x (Swagger)", oas_counts.get("OAS 2.x", 0), "#f5c542"),
        stat("OAS 3.x",           oas_counts.get("OAS 3.x", 0), "#5eb3ff"),
    ])

    # --- source file breakdown tiles -----------------------------------------
    src_tiles = ""
    for sf, (label, color) in SOURCE_LABELS.items():
        count = src_counts.get(sf, 0)
        src_tiles += (
            f'<div class="src-tile" style="border-color:{color}40">'
            f'<div class="src-icon" style="color:{color}">&#128196;</div>'
            f'<div class="src-name" style="color:{color}">{_esc(sf)}</div>'
            f'<div class="src-label">{_esc(label)}</div>'
            f'<div class="src-count" style="color:{color}">{count}</div>'
            f'</div>'
        )

    # --- top 10 active by paths ----------------------------------------------
    def _row_top(e: dict) -> str:
        sf = source_file(e)
        return (
            f"<tr>"
            f"<td>{_esc(e.get('title'))}</td>"
            f"<td>{_source_badge(sf)}</td>"
            f"<td>{_esc(e.get('oas_version'))}</td>"
            f"<td data-sort='{e.get('paths_count',0)}'>{e.get('paths_count',0)}</td>"
            f"<td>{_esc(e.get('latest_version'))}</td>"
            f'<td><a href="{_esc(e.get("source_url",""))}" target="_blank" class="link">GitHub</a></td>'
            f"</tr>"
        )

    rows_top = "".join(_row_top(e) for e in top_by_paths(active))

    # --- recently fetched ----------------------------------------------------
    def _row_recent(e: dict) -> str:
        sf = source_file(e)
        return (
            f"<tr>"
            f"<td>{_esc(e.get('title'))}</td>"
            f"<td>{_source_badge(sf)}</td>"
            f"<td>{_esc(e.get('fetched_at','')[:19].replace('T',' '))}</td>"
            f"<td data-sort='{e.get('paths_count',0)}'>{e.get('paths_count',0)}</td>"
            f"</tr>"
        )

    rows_recent = "".join(_row_recent(e) for e in recently_updated(active))

    # --- versioner history ---------------------------------------------------
    def _row_hist(e: dict) -> str:
        sf = source_file(e)
        n  = len(e.get("history", []))
        return (
            f"<tr>"
            f"<td>{_esc(e.get('title'))}</td>"
            f"<td>{_source_badge(sf)}</td>"
            f"<td data-sort='{n}'>{n}</td>"
            f"<td>{_esc(e.get('latest_version'))}</td>"
            f"</tr>"
        )

    rows_hist = "".join(_row_hist(e) for e in most_updated(active))

    # --- full catalog (all active) -------------------------------------------
    all_sorted = sorted(active, key=lambda e: e.get("title", "").lower())

    def _row_all(e: dict) -> str:
        sf      = source_file(e)
        servers = ", ".join(_esc(s) for s in (e.get("servers") or [])[:2])
        tags    = ", ".join(_esc(t) for t in (e.get("tags") or [])[:4])
        return (
            f"<tr>"
            f"<td><strong>{_esc(e.get('title'))}</strong>"
            f'<br><span class="muted small">{_esc(e.get("description","")[:80])}{"…" if len(e.get("description",""))>80 else ""}</span></td>'
            f"<td>{_source_badge(sf)}</td>"
            f"<td>{_esc(e.get('oas_version'))}</td>"
            f"<td data-sort='{e.get('paths_count',0)}'>{e.get('paths_count',0)}</td>"
            f"<td>{_esc(e.get('latest_version'))}</td>"
            f'<td class="small muted">{servers}</td>'
            f'<td class="small muted">{tags}</td>'
            f'<td><a href="{_esc(e.get("source_url",""))}" target="_blank" class="link">GitHub</a></td>'
            f"</tr>"
        )

    rows_all = "".join(_row_all(e) for e in all_sorted)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>OpenAPI Catalog Report</title>
  <style>
    *, *::before, *::after {{ box-sizing: border-box; }}
    body {{ font-family: "Segoe UI", system-ui, sans-serif; background: #0d1117; color: #e7ecf3;
            margin: 0; padding: 2rem 2.5rem; line-height: 1.6; }}
    h1   {{ font-family: Consolas, monospace; color: #5eb3ff; margin: 0 0 0.25rem; font-size: 1.8rem; }}
    h2   {{ font-family: Consolas, monospace; color: #7ec8e3; margin: 0 0 1rem; font-size: 1.1rem;
            text-transform: uppercase; letter-spacing: 0.05em; }}
    .subtitle {{ color: #8b9cb3; font-size: 0.85rem; margin-bottom: 2rem; }}

    /* stat grid */
    .stats  {{ display: flex; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.5rem; }}
    .stat   {{ background: #161b22; border: 1px solid #2d3a4f; border-radius: 10px;
               padding: 1rem 1.4rem; min-width: 130px; flex: 1; }}
    .stat-label {{ color: #8b9cb3; font-size: 0.8rem; text-transform: uppercase;
                   letter-spacing: 0.06em; margin-bottom: 0.3rem; }}
    .stat-value {{ font-size: 2rem; font-weight: 700; color: #5eb3ff; }}

    /* source file tiles */
    .src-grid {{ display: grid; grid-template-columns: repeat(auto-fit,minmax(170px,1fr));
                 gap: 1rem; margin-bottom: 1.5rem; }}
    .src-tile {{ background: #161b22; border: 1px solid #2d3a4f; border-radius: 10px;
                 padding: 1rem; text-align: center; transition: border-color .2s; }}
    .src-tile:hover {{ border-color: #5eb3ff80; }}
    .src-icon  {{ font-size: 1.6rem; margin-bottom: 0.25rem; }}
    .src-name  {{ font-family: Consolas, monospace; font-size: 0.85rem; font-weight: 600;
                  margin-bottom: 0.15rem; }}
    .src-label {{ color: #8b9cb3; font-size: 0.75rem; margin-bottom: 0.5rem; }}
    .src-count {{ font-size: 1.8rem; font-weight: 700; }}

    /* sections */
    section {{ background: #161b22; border: 1px solid #2d3a4f; border-radius: 10px;
               padding: 1.4rem 1.6rem; margin-bottom: 1.5rem; overflow-x: auto; }}

    /* tables */
    table {{ width: 100%; border-collapse: collapse; font-size: 0.88rem; }}
    th, td {{ padding: 0.5rem 0.7rem; border-bottom: 1px solid #1e2a3a; text-align: left;
              vertical-align: top; }}
    th {{ color: #8b9cb3; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em;
          cursor: pointer; user-select: none; white-space: nowrap; }}
    th:hover {{ color: #e7ecf3; }}
    th.sorted-asc::after  {{ content: " ↑"; }}
    th.sorted-desc::after {{ content: " ↓"; }}
    tr:last-child td {{ border-bottom: none; }}
    tr:hover td {{ background: #1a2332; }}

    /* badges */
    .badge {{ padding: 0.18rem 0.55rem; border-radius: 5px; font-size: 0.72rem;
              font-weight: 600; white-space: nowrap; }}
    .badge-active {{ background: rgba(61,214,140,.15); color: #3dd68c; }}

    /* misc */
    pre.hist {{ font-family: Consolas, monospace; font-size: 0.82rem;
                background: #0d1117; padding: 1rem; border-radius: 6px;
                overflow-x: auto; margin: 0; }}
    .muted {{ color: #8b9cb3; }}
    .small {{ font-size: 0.78rem; }}
    .link  {{ color: #5eb3ff; text-decoration: none; }}
    .link:hover {{ text-decoration: underline; }}

    /* search box */
    .search-wrap {{ margin-bottom: 0.75rem; }}
    .search-box  {{ background: #0d1117; border: 1px solid #2d3a4f; color: #e7ecf3;
                    padding: 0.4rem 0.8rem; border-radius: 6px; font-size: 0.88rem;
                    width: 100%; max-width: 360px; outline: none; }}
    .search-box:focus {{ border-color: #5eb3ff; }}
  </style>
</head>
<body>

  <h1>&#128196; OpenAPI Catalog Report</h1>
  <p class="subtitle">Generated {_esc(gen)} &nbsp;|&nbsp; {len(active)} active specs</p>

  <!-- stat tiles -->
  <div class="stats">{stats_html}</div>

  <!-- source file breakdown -->
  <section>
    <h2>Specs by Source File Format</h2>
    <p class="muted small">Each tile shows how many active specs were discovered from that canonical filename via GitHub Code Search.</p>
    <div class="src-grid">{src_tiles}</div>
  </section>

  <!-- top 10 -->
  <section>
    <h2>Top 10 Active APIs by Path Count</h2>
    <table>
      <thead><tr>
        <th data-col="0">Title</th>
        <th data-col="1">Source File</th>
        <th data-col="2">OAS Version</th>
        <th data-col="3">Paths &#9660;</th>
        <th data-col="4">API Version</th>
        <th data-col="5">Link</th>
      </tr></thead>
      <tbody>{rows_top}</tbody>
    </table>
  </section>

  <!-- recently fetched -->
  <section>
    <h2>Most Recently Fetched (Active)</h2>
    <table>
      <thead><tr>
        <th data-col="0">Title</th>
        <th data-col="1">Source File</th>
        <th data-col="2">Fetched At</th>
        <th data-col="3">Paths</th>
      </tr></thead>
      <tbody>{rows_recent}</tbody>
    </table>
  </section>

  <!-- histogram -->
  <section>
    <h2>Path Count Distribution (Active Specs)</h2>
    <pre class="hist">{hist_lines}</pre>
  </section>

  <!-- version history -->
  <section>
    <h2>Most-Updated Specs (Longest Version History)</h2>
    <table>
      <thead><tr>
        <th data-col="0">Title</th>
        <th data-col="1">Source File</th>
        <th data-col="2">History Entries</th>
        <th data-col="3">Latest Version</th>
      </tr></thead>
      <tbody>{rows_hist}</tbody>
    </table>
  </section>

  <!-- full catalog -->
  <section>
    <h2>Full Catalog ({len(active)} Active Specs)</h2>
    <div class="search-wrap">
      <input class="search-box" id="catalog-search" type="text"
             placeholder="Filter by title, version, tags…" />
    </div>
    <table id="tbl-all">
      <thead><tr>
        <th data-col="0">Title / Description</th>
        <th data-col="1">Source File</th>
        <th data-col="2">OAS</th>
        <th data-col="3">Paths</th>
        <th data-col="4">Version</th>
        <th data-col="5">Servers</th>
        <th data-col="6">Tags</th>
        <th data-col="7">Link</th>
      </tr></thead>
      <tbody>{rows_all}</tbody>
    </table>
  </section>

  <script>
    // ── sortable tables ────────────────────────────────────────────────────
    document.querySelectorAll('th[data-col]').forEach(th => {{
      th.addEventListener('click', () => {{
        const col   = +th.dataset.col;
        const tbody = th.closest('table').querySelector('tbody');
        const rows  = [...tbody.querySelectorAll('tr')];
        const asc   = th.dataset.dir !== 'asc';
        th.closest('tr').querySelectorAll('th').forEach(h => {{
          delete h.dataset.dir;
          h.classList.remove('sorted-asc', 'sorted-desc');
        }});
        th.dataset.dir = asc ? 'asc' : 'desc';
        th.classList.add(asc ? 'sorted-asc' : 'sorted-desc');
        rows.sort((a, b) => {{
          const av = a.children[col].dataset.sort ?? a.children[col].textContent.trim();
          const bv = b.children[col].dataset.sort ?? b.children[col].textContent.trim();
          const an = +av, bn = +bv;
          const c  = (!isNaN(an) && !isNaN(bn)) ? an - bn : av.localeCompare(bv);
          return asc ? c : -c;
        }});
        rows.forEach(r => tbody.appendChild(r));
      }});
    }});

    // ── live search for full catalog ───────────────────────────────────────
    document.getElementById('catalog-search').addEventListener('input', function() {{
      const q    = this.value.toLowerCase();
      const rows = document.querySelectorAll('#tbl-all tbody tr');
      rows.forEach(r => {{
        r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none';
      }});
    }});
  </script>
</body>
</html>"""


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    if not CATALOG_PATH.exists():
        print(f"Catalog not found: {CATALOG_PATH}", file=sys.stderr)
        return 1
    data = load_catalog()
    MD_PATH.parent.mkdir(parents=True, exist_ok=True)
    MD_PATH.write_text(build_markdown(data), encoding="utf-8")
    HTML_PATH.write_text(build_html(data), encoding="utf-8")
    print(f"Wrote {MD_PATH}")
    print(f"Wrote {HTML_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
