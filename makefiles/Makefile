.PHONY: all dev down clean convex-push convex-env

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
