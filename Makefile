MARKED_VERSION    := 13.0.3
HLJS_VERSION      := 11.11.1
HLJS_THEME        := atom-one-dark
HLJS_THEME_LOCAL  := one-dark
HLJS_LANGUAGES    := python javascript typescript bash json css xml markdown rust go ruby java c cpp

VENDOR_DIR        := public/vendor
HLJS_DIR          := $(VENDOR_DIR)/hljs
HLJS_LANG_DIR     := $(HLJS_DIR)/languages

MARKED_URL        := https://cdn.jsdelivr.net/npm/marked@$(MARKED_VERSION)/marked.min.js
HLJS_BASE         := https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@$(HLJS_VERSION)

CURL              := curl -fsSL

TS_SOURCES        := $(shell find src -name '*.ts' 2>/dev/null)
JS_SOURCES        := $(shell find public test -name '*.mjs' -not -path './public/vendor/*' 2>/dev/null)

.PHONY: build lint test test-sandbox precommit start install update vendor vendor-clean pack publish clean

.DEFAULT_GOAL := build

build: node_modules
	@npm run build

node_modules: package.json package-lock.json
	@npm install
	@touch node_modules

lint: node_modules
	@echo "==> lint"
	@npx tsc --noEmit
	@for f in $(JS_SOURCES); do node --check $$f || exit 1; done

test: build
	@echo "==> test"
	@node --test test/*.test.mjs

# 真實 Gondolin VM 整合測試。預設不跑 (要 QEMU + 約 150MB asset 下載)。
# 透過 SANDBOX_VM=1 切換 opt-in 標記。
test-sandbox: build
	@echo "==> test-sandbox (opt-in real VM)"
	@SANDBOX_VM=1 node --test test/sandbox.test.mjs test/sandbox-vm.test.mjs

precommit: lint test

start: build
	@npm start

install:
	@npm install -g .

pack: build
	@mkdir -p build
	@npm pack --pack-destination build

publish: build
	@npm publish --access public

update:
	@npm update
	@touch node_modules

clean:
	@rm -rf dist build


vendor: vendor-clean
	@mkdir -p $(HLJS_LANG_DIR)
	@echo "fetching marked $(MARKED_VERSION)"
	@$(CURL) $(MARKED_URL) -o $(VENDOR_DIR)/marked.min.js
	@echo "fetching highlight.js $(HLJS_VERSION)"
	@$(CURL) $(HLJS_BASE)/highlight.min.js -o $(HLJS_DIR)/highlight.min.js
	@$(CURL) $(HLJS_BASE)/styles/$(HLJS_THEME).min.css -o $(HLJS_DIR)/$(HLJS_THEME_LOCAL).min.css
	@for lang in $(HLJS_LANGUAGES); do \
		echo "fetching hljs language $$lang"; \
		$(CURL) $(HLJS_BASE)/languages/$$lang.min.js -o $(HLJS_LANG_DIR)/$$lang.min.js || exit 1; \
	done

vendor-clean:
	@rm -rf $(VENDOR_DIR)
