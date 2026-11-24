.DEFAULT_GOAL := help

ifneq (,$(wildcard .env))
  include .env
  export
endif

.PHONY: help
help:
	@grep -E '^[a-zA-Z_/-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

.PHONY: install
install: ## Install site npm deps
	docker compose run --rm node npm install

.PHONY: dev
dev: ## Astro dev server → http://localhost:4321
	docker compose run --rm --service-ports node npm run dev -- --host

.PHONY: build
build: install ## Build the static site into site/dist/
	docker compose run --rm node npm run build

.PHONY: infra-init
infra-init: ## Create the Pulumi stack (first time only; CI also upserts it)
	docker compose build pulumi
	docker compose run --rm --entrypoint pulumi pulumi stack init flexo333/prod

.PHONY: infra-preview
infra-preview: ## Preview infra changes
	docker compose build pulumi
	docker compose run --rm pulumi preview

.PHONY: infra-up
infra-up: ## Apply infra changes
	docker compose build pulumi
	docker compose run --rm pulumi up --yes

.PHONY: infra-outputs
infra-outputs: ## Show stack outputs
	docker compose run --rm pulumi stack output
