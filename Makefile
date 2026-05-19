.PHONY: install run watch test report verify clean help

# Cross-platform Python detection.
# Override with: make PYTHON=python3 test  (Linux/Mac)
#                make PYTHON=python  test   (Windows)
PYTHON ?= $(shell python3 --version 2>/dev/null && echo python3 || echo python)
PIP    ?= $(PYTHON) -m pip

help:
	@echo ""
	@echo "OpenAPI Catalog — available targets:"
	@echo "  make install   Install Python dependencies"
	@echo "  make run       Execute a single update cycle"
	@echo "  make watch     Run the updater continuously (24h polling)"
	@echo "  make test      Run the full unit test suite (53 tests)"
	@echo "  make report    Generate data/REPORT.md and data/REPORT.html"
	@echo "  make verify    Run verify.py requirement checklist"
	@echo "  make clean     Remove __pycache__ and .pyc files"
	@echo ""

install:
	$(PIP) install -r requirements.txt

run:
	$(PYTHON) -m src.main

watch:
	$(PYTHON) -m src.main --watch

test:
	$(PYTHON) run_tests.py

report:
	$(PYTHON) -m tools.render_report

verify:
	$(PYTHON) verify.py

clean:
	find . -type d -name "__pycache__" -prune -exec rm -rf {} + 2>/dev/null || \
	  for /r . %%d in (__pycache__) do @if exist "%%d" rd /s /q "%%d"
	find . -name "*.pyc" -delete 2>/dev/null || del /s /q *.pyc 2>nul
