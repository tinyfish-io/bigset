SHELL := /usr/bin/env bash

.PHONY: all dev down clean convex-push convex-env

include $(wildcard makefiles/*)

.PHONY: check-trufflehog
check-trufflehog:
	@if ! which trufflehog > /dev/null 2>&1; then \
		echo "TruffleHog is not installed."; \
		echo "MacOS users can install it with:"; \
		echo "  brew install trufflehog"; \
		echo ""; \
		echo "Linux users can install it with:"; \
		echo "  curl -sSfL https://raw.githubusercontent.com/trufflesecurity/trufflehog/main/scripts/install.sh | sh -s -- -b /usr/local/bin"; \
		echo ""; \
		echo "For more details, go to https://github.com/trufflesecurity/trufflehog"; \
		exit 1; \
	fi

.PHONY: setup-pre-commit
setup-pre-commit:
	@if [ ! -f .pre-commit-config.yaml ]; then \
		echo ".pre-commit-config.yaml not found. Copying template..."; \
		cp .github/config/.pre-commit-config-template.yaml .pre-commit-config.yaml; \
		echo ".pre-commit-config.yaml created from template."; \
	else \
		echo ".pre-commit-config.yaml already exists."; \
	fi

.PHONY: init
init: setup-pre-commit check-trufflehog
	pip install pre-commit
	pre-commit install

all: dev

dev:
	docker compose -f docker-compose.dev.yml up --build -d
	@echo "Waiting for Convex to be healthy..."
	@for i in $$(seq 1 120); do \
		if curl -sf http://127.0.0.1:3210/version > /dev/null 2>&1; then break; fi; \
		if [ $$i -eq 120 ]; then echo "Convex did not become healthy within 120s"; exit 1; fi; \
		sleep 1; \
	done
	$(MAKE) convex-env
	$(MAKE) convex-push
	@echo ""
	@echo "Ready! Open http://localhost:3500"
	docker compose -f docker-compose.dev.yml logs -f

convex-env:
	@cd frontend && npx convex env set CLERK_JWT_ISSUER_DOMAIN "$$(grep CLERK_JWT_ISSUER_DOMAIN .env.local | cut -d= -f2-)" \
		--url http://127.0.0.1:3210 \
		--admin-key "$$(grep CONVEX_SELF_HOSTED_ADMIN_KEY .env.local | cut -d= -f2-)"

convex-push:
	cd frontend && npx convex deploy \
		--url http://127.0.0.1:3210 \
		--admin-key "$$(grep CONVEX_SELF_HOSTED_ADMIN_KEY .env.local | cut -d= -f2-)"

down:
	docker compose -f docker-compose.dev.yml down

clean:
	docker compose -f docker-compose.dev.yml down -v --rmi local
