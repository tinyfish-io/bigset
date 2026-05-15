.PHONY: all dev down clean test

all: dev

test:
	@echo "No test target configured yet"

dev:
	docker compose -f docker-compose.dev.yml up --build

down:
	docker compose -f docker-compose.dev.yml down

clean:
	docker compose -f docker-compose.dev.yml down -v --rmi local
	@echo "Cleaned containers, volumes, and images"
