.PHONY: all dev validate-dev-env down clean convex-push convex-env seed-public-datasets

all: dev

dev: validate-dev-env
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
	@echo "Ready!"
	@echo "  App:           http://localhost:3500"
	@echo "  Mastra Studio: http://localhost:4111"
	docker compose -f docker-compose.dev.yml logs -f

validate-dev-env:
	@test -f .env || { echo "Error: .env not found. Run: cp .env.example .env"; exit 1; }
	@check_env() { \
		key="$$1"; placeholder="$$2"; \
		value="$$(grep "^$$key=" .env | cut -d= -f2-)"; \
		if [[ -z "$$value" || "$$value" == "$$placeholder" || "$$value" == *"..."* ]]; then \
			echo "Error: $$key must be set in root .env"; \
			exit 1; \
		fi; \
	}; \
	check_env NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY pk_test_...; \
	check_env CLERK_SECRET_KEY sk_test_...; \
	check_env CLERK_JWT_ISSUER_DOMAIN https://your-app.clerk.accounts.dev; \
	check_env OPENROUTER_API_KEY sk-or-...

convex-env:
	@test -f .env || { echo "Error: .env not found. Run: cp .env.example .env"; exit 1; }
	@issuer="$$(grep '^CLERK_JWT_ISSUER_DOMAIN=' .env | cut -d= -f2-)"; \
		admin_key="$$(grep '^CONVEX_SELF_HOSTED_ADMIN_KEY=' .env | cut -d= -f2-)"; \
		if [[ -z "$$issuer" || "$$issuer" == "https://your-app.clerk.accounts.dev" ]]; then \
			echo "Error: CLERK_JWT_ISSUER_DOMAIN must be your Clerk issuer URL in root .env"; \
			exit 1; \
		fi; \
		if [[ -z "$$admin_key" ]]; then \
			echo "Error: CONVEX_SELF_HOSTED_ADMIN_KEY is missing in root .env"; \
			echo "Generate it after Convex starts with:"; \
			echo "  docker compose -f docker-compose.dev.yml exec convex ./generate_admin_key.sh"; \
			echo "Then paste it into root .env and rerun make dev."; \
			exit 1; \
		fi; \
		cd frontend && node ../scripts/with-root-env.mjs npx convex env set CLERK_JWT_ISSUER_DOMAIN "$$issuer" \
		--url http://127.0.0.1:3210 \
		--admin-key "$$admin_key"

convex-push:
	@test -f .env || { echo "Error: .env not found. Run: cp .env.example .env"; exit 1; }
	@admin_key="$$(grep '^CONVEX_SELF_HOSTED_ADMIN_KEY=' .env | cut -d= -f2-)"; \
		if [[ -z "$$admin_key" ]]; then \
			echo "Error: CONVEX_SELF_HOSTED_ADMIN_KEY is missing in root .env"; \
			echo "Generate it after Convex starts with:"; \
			echo "  docker compose -f docker-compose.dev.yml exec convex ./generate_admin_key.sh"; \
			echo "Then paste it into root .env and rerun make dev."; \
			exit 1; \
		fi; \
		cd frontend && node ../scripts/with-root-env.mjs npx convex deploy \
		--url http://127.0.0.1:3210 \
		--admin-key "$$admin_key"

seed-public-datasets:
	@test -f .env || { echo "Error: .env not found. Run: cp .env.example .env"; exit 1; }
	@cd frontend && node ../scripts/with-root-env.mjs npx convex run publicSeed:seedPublicDatasets

down:
	docker compose -f docker-compose.dev.yml down

clean:
	docker compose -f docker-compose.dev.yml down -v --rmi local
