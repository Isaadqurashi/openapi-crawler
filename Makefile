.PHONY: build crawl update catalog watch test clean install validate

install:
	npm install

build:
	npx tsc

crawl: build
	node dist/index.js crawl

update: build
	node dist/index.js update

catalog: build
	node dist/index.js catalog

watch: build
	node dist/index.js watch

test:
	npx jest --coverage

validate: build
	node scripts/validate-catalog.mjs

clean:
	rm -rf dist coverage
