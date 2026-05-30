.PHONY: all dev validate-dev-env down clean convex-push convex-env seed-public-datasets ensure-admin-key install-deps

all: dev

install-deps:
	@cd frontend && npm install --silent
	@cd backend && npm install --silent

dev: validate-dev-env install-deps
	docker compose -f docker-compose.dev.yml up --build -d db convex convex-dashboard
	@echo "Waiting for Convex..."
	@for i in $$(seq 1 120); do \
		if curl -sf http://127.0.0.1:3210/version > /dev/null 2>&1; then break; fi; \
		if [ $$i -eq 120 ]; then echo "Error: Convex did not start within 120s"; exit 1; fi; \
		sleep 1; \
	done
	@echo "Convex is up."
	$(MAKE) ensure-admin-key
	$(MAKE) convex-env
	$(MAKE) convex-push
	docker compose -f docker-compose.dev.yml up --build -d
	@echo ""
	@echo "BigSet is ready!"
	@echo "  App:              http://localhost:3500"
	@echo "  Mastra Studio:    http://localhost:4111"
	@echo "  Convex Dashboard: http://localhost:6791"
	@echo ""
	docker compose -f docker-compose.dev.yml logs -f

validate-dev-env:
	@test -f .env || { echo "Error: .env not found. Run: cp .env.example .env"; exit 1; }
	@missing=""; \
	check_env() { \
		key="$$1"; placeholder="$$2"; \
		value="$$(grep "^$$key=" .env | cut -d= -f2-)"; \
		if [[ -z "$$value" || "$$value" == "$$placeholder" || "$$value" == *"..."* ]]; then \
			missing="$$missing $$key"; \
		fi; \
	}; \
	check_env NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY pk_test_...; \
	check_env CLERK_SECRET_KEY sk_test_...; \
	check_env CLERK_JWT_ISSUER_DOMAIN https://your-app.clerk.accounts.dev; \
	check_env OPENROUTER_API_KEY sk-or-...; \
	check_env TINYFISH_API_KEY ""; \
	if [[ -n "$$missing" ]]; then \
		echo ""; \
		echo "Missing environment variables in .env:"; \
		echo ""; \
		for key in $$missing; do \
			case $$key in \
				NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) \
					echo "  ✗ $$key"; \
					echo "    → Clerk dashboard → API Keys → Publishable Key"; \
					echo "    https://dashboard.clerk.com"; \
					echo "";; \
				CLERK_SECRET_KEY) \
					echo "  ✗ $$key"; \
					echo "    → Clerk dashboard → API Keys → Secret Key"; \
					echo "    https://dashboard.clerk.com"; \
					echo "";; \
				CLERK_JWT_ISSUER_DOMAIN) \
					echo "  ✗ $$key"; \
					echo "    → Clerk dashboard → Configure → JWT Templates → enable Convex template"; \
					echo "    → Then find Issuer URL under Settings (e.g. https://your-app.clerk.accounts.dev)"; \
					echo "    https://dashboard.clerk.com"; \
					echo "";; \
				OPENROUTER_API_KEY) \
					echo "  ✗ $$key"; \
					echo "    → Create account → Settings → Keys → Create Key"; \
					echo "    https://openrouter.ai/settings/keys"; \
					echo "";; \
				TINYFISH_API_KEY) \
					echo "  ✗ $$key"; \
					echo "    → Create account → API Keys → Create Key"; \
					echo "    https://agent.tinyfish.ai/api-keys"; \
					echo "";; \
			esac; \
		done; \
		echo "Paste your keys into .env, then run make dev again."; \
		echo ""; \
		exit 1; \
	fi

ensure-admin-key:
	@admin_key="$$(grep '^CONVEX_SELF_HOSTED_ADMIN_KEY=' .env | cut -d= -f2-)"; \
	needs_gen=false; \
	if [[ -z "$$admin_key" ]]; then \
		needs_gen=true; \
	else \
		echo "Validating Convex admin key..."; \
		if ! (cd frontend && node ../scripts/with-root-env.mjs npx convex env list \
			--url http://127.0.0.1:3210 --admin-key "$$admin_key") > /dev/null 2>&1; then \
			echo "Admin key is stale (volumes were probably wiped). Regenerating..."; \
			needs_gen=true; \
		fi; \
	fi; \
	if [[ "$$needs_gen" == "true" ]]; then \
		echo "Generating Convex admin key..."; \
		generated="$$(docker compose -f docker-compose.dev.yml exec -T convex ./generate_admin_key.sh 2>/dev/null \
			| grep '^convex-self-hosted|')"; \
		if [[ -z "$$generated" ]]; then \
			echo "Error: Failed to generate admin key."; exit 1; \
		fi; \
		if grep -q '^CONVEX_SELF_HOSTED_ADMIN_KEY=' .env; then \
			sed -i '' "s#^CONVEX_SELF_HOSTED_ADMIN_KEY=.*#CONVEX_SELF_HOSTED_ADMIN_KEY=$$generated#" .env; \
		else \
			echo "CONVEX_SELF_HOSTED_ADMIN_KEY=$$generated" >> .env; \
		fi; \
		echo "Admin key saved to .env"; \
	else \
		echo "Convex admin key is valid."; \
	fi

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
			echo "Run make dev to generate it automatically."; \
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
			echo "Run make dev to generate it automatically."; \
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
	@if [ -f .env ]; then \
		sed -i '' 's|^CONVEX_SELF_HOSTED_ADMIN_KEY=.*|CONVEX_SELF_HOSTED_ADMIN_KEY=|' .env; \
		echo "Cleared CONVEX_SELF_HOSTED_ADMIN_KEY from .env (volumes wiped)."; \
	fi
