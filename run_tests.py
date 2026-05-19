"""
Professional test runner for OpenAPI Catalog.

Usage:
    python run_tests.py           # all tests, per-module progress bars
    python run_tests.py -v        # also print every individual test name
    python run_tests.py -q        # summary only
"""

from __future__ import annotations

# ── Windows: rewrap stdout/stderr as UTF-8 before rich opens them ─────────
import sys
if sys.platform == "win32":
    import io
    if hasattr(sys.stdout, "buffer"):
        sys.stdout = io.TextIOWrapper(
            sys.stdout.buffer, encoding="utf-8", errors="replace", line_buffering=True
        )
    if hasattr(sys.stderr, "buffer"):
        sys.stderr = io.TextIOWrapper(
            sys.stderr.buffer, encoding="utf-8", errors="replace", line_buffering=True
        )

import time
import unittest
from collections import defaultdict
from typing import List, Tuple

from rich import box
from rich.console import Console
from rich.panel import Panel
from rich.rule import Rule
from rich.table import Table

# force_terminal → always emit ANSI colours
# legacy_windows=False → write to our UTF-8 stream, not the Win32 console API
console = Console(
    highlight=False,
    force_terminal=True,
    legacy_windows=False,
)

# ── Symbols ────────────────────────────────────────────────────────────────
SYM_OK    = "✓"
SYM_FAIL  = "✗"
SYM_WARN  = "⚠"
SYM_SKIP  = "–"
BAR_FULL  = "█"
BAR_EMPTY = "░"


# ── Custom TestResult ──────────────────────────────────────────────────────

class _RichResult(unittest.TestResult):
    def __init__(self, verbose: bool = False) -> None:
        super().__init__()
        self.verbose = verbose
        # (status, module, test_name, elapsed_s, message)
        self._records: List[Tuple[str, str, str, float, str]] = []
        self._t0: float = 0.0

    # ── helpers ──────────────────────────────────────────────────────────

    def _mod(self, test: unittest.TestCase) -> str:
        return test.__class__.__module__.split(".")[-1]

    def _meth(self, test: unittest.TestCase) -> str:
        return test._testMethodName

    def _elapsed(self) -> float:
        return time.perf_counter() - self._t0

    # ── TestResult protocol ───────────────────────────────────────────────

    def startTest(self, test: unittest.TestCase) -> None:
        super().startTest(test)
        self._t0 = time.perf_counter()

    def addSuccess(self, test: unittest.TestCase) -> None:
        super().addSuccess(test)
        self._records.append(("pass", self._mod(test), self._meth(test), self._elapsed(), ""))
        if self.verbose:
            console.print(f"    [green]{SYM_OK}[/green]  {self._meth(test)}")

    def addFailure(self, test: unittest.TestCase, err) -> None:
        super().addFailure(test, err)
        msg = self._exc_info_to_string(err, test).strip().splitlines()[-1]
        self._records.append(("fail", self._mod(test), self._meth(test), self._elapsed(), msg))
        console.print(f"    [bold red]{SYM_FAIL}[/bold red]  {self._meth(test)}  [dim red]{msg}[/dim red]")

    def addError(self, test: unittest.TestCase, err) -> None:
        super().addError(test, err)
        msg = self._exc_info_to_string(err, test).strip().splitlines()[-1]
        self._records.append(("error", self._mod(test), self._meth(test), self._elapsed(), msg))
        console.print(f"    [bold red]{SYM_WARN}[/bold red]  {self._meth(test)}  [dim red]{msg}[/dim red]")

    def addSkip(self, test: unittest.TestCase, reason: str) -> None:
        super().addSkip(test, reason)
        self._records.append(("skip", self._mod(test), self._meth(test), self._elapsed(), reason))
        if self.verbose:
            console.print(f"    [yellow]{SYM_SKIP}[/yellow]  {self._meth(test)}  [dim]{reason}[/dim]")


# ── Custom TestRunner ──────────────────────────────────────────────────────

class RichTestRunner:
    def __init__(self, verbose: bool = False, quiet: bool = False) -> None:
        self.verbose = verbose
        self.quiet = quiet

    def run(self, suite: unittest.TestSuite) -> _RichResult:
        # ── header ───────────────────────────────────────────────────────
        console.print()
        console.print(Panel.fit(
            "[bold cyan]OpenAPI Catalog[/bold cyan]  [dim]—[/dim]  [bold white]Test Suite[/bold white]",
            border_style="cyan",
            padding=(0, 4),
        ))
        console.print()

        result = _RichResult(verbose=self.verbose)

        # ── group tests by module ─────────────────────────────────────────
        by_module: dict[str, list[unittest.TestCase]] = defaultdict(list)
        for test in _flatten(suite):
            by_module[test.__class__.__module__.split(".")[-1]].append(test)

        total_start = time.perf_counter()

        for mod, tests in by_module.items():
            count = len(tests)
            label = mod.replace("test_", "").replace("_", " ").title()

            # section heading
            console.print(
                f"  [bold white]{label}[/bold white]"
                f"  [dim]({count} test{'s' if count != 1 else ''})[/dim]"
            )

            # run each test in this module
            for test in tests:
                try:
                    test(result)
                except Exception:
                    pass

            # per-module progress bar
            mod_recs = [r for r in result._records if r[1] == mod]
            passed  = sum(1 for r in mod_recs if r[0] == "pass")
            failed  = sum(1 for r in mod_recs if r[0] in ("fail", "error"))
            elapsed = sum(r[3] for r in mod_recs)

            bar_len  = 30
            fill     = round(bar_len * passed / max(count, 1))
            bar      = BAR_FULL * fill + BAR_EMPTY * (bar_len - fill)
            ok       = failed == 0
            color    = "green" if ok else "red"
            status   = f"{SYM_OK} PASS" if ok else f"{SYM_FAIL} {failed} FAILED"

            console.print(
                f"  [{color}]{bar}[/{color}]"
                f"  [dim]{passed}/{count}[/dim]"
                f"  [{color}]{status}[/{color}]"
                f"  [dim]{elapsed * 1000:.0f} ms[/dim]"
            )
            console.print()

        total_elapsed = time.perf_counter() - total_start

        # ── summary ───────────────────────────────────────────────────────
        console.print(Rule(style="dim"))
        console.print()

        total   = result.testsRun
        n_pass  = total - len(result.failures) - len(result.errors) - len(result.skipped)
        n_fail  = len(result.failures)
        n_err   = len(result.errors)
        n_skip  = len(result.skipped)
        all_ok  = n_fail == 0 and n_err == 0

        tbl = Table(box=box.SIMPLE, show_header=False, padding=(0, 2))
        tbl.add_column("label")
        tbl.add_column("value", justify="right")
        tbl.add_row(f"[green]{SYM_OK}  Passed[/green]",   f"[bold green]{n_pass}[/bold green]")
        tbl.add_row(
            f"[red]{SYM_FAIL}  Failed[/red]" if n_fail else f"[dim]{SYM_FAIL}  Failed[/dim]",
            f"[bold red]{n_fail}[/bold red]" if n_fail else "[dim]0[/dim]",
        )
        tbl.add_row(
            f"[red]{SYM_WARN}  Errors[/red]" if n_err else f"[dim]{SYM_WARN}  Errors[/dim]",
            f"[bold red]{n_err}[/bold red]"  if n_err  else "[dim]0[/dim]",
        )
        if n_skip:
            tbl.add_row(f"[yellow]{SYM_SKIP}  Skipped[/yellow]", f"[yellow]{n_skip}[/yellow]")
        tbl.add_row("[dim]⏱  Time[/dim]", f"[dim]{total_elapsed * 1000:.0f} ms[/dim]")
        console.print(tbl)

        # ── result banner ─────────────────────────────────────────────────
        if all_ok:
            console.print(Panel.fit(
                f"[bold green]  {SYM_OK}  ALL {total} TESTS PASSED  [/bold green]",
                border_style="green",
                padding=(0, 4),
            ))
        else:
            console.print(Panel.fit(
                f"[bold red]  {SYM_FAIL}  {n_fail + n_err} TEST(S) FAILED  [/bold red]",
                border_style="red",
                padding=(0, 4),
            ))

        # ── failure details ───────────────────────────────────────────────
        if result.failures or result.errors:
            console.print()
            console.print(Rule("[bold red]Failure Details[/bold red]", style="red"))
            for test, tb in result.failures + result.errors:
                console.print(f"\n[bold red]{test}[/bold red]")
                console.print(f"[dim]{tb.strip()}[/dim]")

        console.print()
        return result


def _flatten(suite) -> List[unittest.TestCase]:
    """Recursively unwrap nested TestSuites into individual TestCases."""
    out = []
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            out.extend(_flatten(item))
        else:
            out.append(item)
    return out


# ── Entry point ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    args    = sys.argv[1:]
    verbose = "-v" in args
    quiet   = "-q" in args

    loader = unittest.TestLoader()
    suite  = loader.discover(start_dir="tests", pattern="test_*.py")

    runner = RichTestRunner(verbose=verbose, quiet=quiet)
    result = runner.run(suite)

    sys.exit(0 if result.wasSuccessful() else 1)
