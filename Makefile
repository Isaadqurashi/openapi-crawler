.PHONY: build crawl update catalog test clean install

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

test:
	npx jest --coverage

clean:
	rm -rf dist coverage
