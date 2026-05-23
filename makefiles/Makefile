.PHONY: all dev validate-dev-env down clean convex-push convex-env verify-self-healing

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
	@test -f frontend/.env.local || { echo "Error: frontend/.env.local not found. Run: cp frontend/.env.example frontend/.env.local"; exit 1; }
	@check_env() { \
			file="$$1"; key="$$2"; placeholder="$$3"; \
			value="$$(grep "^$$key=" "$$file" | cut -d= -f2-)"; \
			if [[ -z "$$value" || "$$value" == "$$placeholder" || "$$value" == *"..."* ]]; then \
				echo "Error: $$key must be set in $$file"; \
				exit 1; \
			fi; \
		}; \
		check_env .env NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY pk_test_...; \
		check_env .env CLERK_SECRET_KEY sk_test_...; \
		check_env .env OPENROUTER_API_KEY sk-or-...; \
		check_env .env TINYFISH_API_KEY ""; \
		check_env frontend/.env.local NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY pk_test_...; \
		check_env frontend/.env.local CLERK_SECRET_KEY sk_test_...; \
		check_env frontend/.env.local CLERK_JWT_ISSUER_DOMAIN https://your-app.clerk.accounts.dev

convex-env:
	@test -f frontend/.env.local || { echo "Error: frontend/.env.local not found"; exit 1; }
	@issuer="$$(grep '^CLERK_JWT_ISSUER_DOMAIN=' frontend/.env.local | cut -d= -f2-)"; \
		if [[ -z "$$issuer" || "$$issuer" == "https://your-app.clerk.accounts.dev" ]]; then \
			echo "Error: CLERK_JWT_ISSUER_DOMAIN must be your Clerk issuer URL in frontend/.env.local"; \
			exit 1; \
		fi
	@admin_key="$$(grep '^CONVEX_SELF_HOSTED_ADMIN_KEY=' frontend/.env.local | cut -d= -f2-)"; \
		if [[ -z "$$admin_key" || "$$admin_key" == \<run:* ]]; then \
			echo "Error: CONVEX_SELF_HOSTED_ADMIN_KEY is missing in frontend/.env.local"; \
			echo "Generate it after Convex starts with:"; \
			echo "  docker compose -f docker-compose.dev.yml exec convex ./generate_admin_key.sh"; \
			echo "Then paste it into both .env and frontend/.env.local and rerun make dev."; \
			exit 1; \
		fi
	@cd frontend && npx convex env set CLERK_JWT_ISSUER_DOMAIN "$$(grep '^CLERK_JWT_ISSUER_DOMAIN=' .env.local | cut -d= -f2-)" \
		--url http://127.0.0.1:3210 \
		--admin-key "$$(grep '^CONVEX_SELF_HOSTED_ADMIN_KEY=' .env.local | cut -d= -f2-)"

convex-push:
	@test -f frontend/.env.local || { echo "Error: frontend/.env.local not found"; exit 1; }
	@admin_key="$$(grep '^CONVEX_SELF_HOSTED_ADMIN_KEY=' frontend/.env.local | cut -d= -f2-)"; \
		if [[ -z "$$admin_key" || "$$admin_key" == \<run:* ]]; then \
			echo "Error: CONVEX_SELF_HOSTED_ADMIN_KEY is missing in frontend/.env.local"; \
			echo "Generate it after Convex starts with:"; \
			echo "  docker compose -f docker-compose.dev.yml exec convex ./generate_admin_key.sh"; \
			echo "Then paste it into both .env and frontend/.env.local and rerun make dev."; \
			exit 1; \
		fi
	@cd frontend && npx convex deploy \
		--url http://127.0.0.1:3210 \
		--admin-key "$$(grep '^CONVEX_SELF_HOSTED_ADMIN_KEY=' .env.local | cut -d= -f2-)"

verify-self-healing:
	bash scripts/verify-self-healing-stack.sh

down:
	docker compose -f docker-compose.dev.yml down

clean:
	docker compose -f docker-compose.dev.yml down -v --rmi local
