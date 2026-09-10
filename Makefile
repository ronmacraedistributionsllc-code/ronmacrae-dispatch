.PHONY: help install db:prepare dev preview seed test lint typecheck e2e up down

help:
	@echo "Targets:"
	@echo "  install      install all workspace dependencies"
	@echo "  db:prepare   generate prisma client + push schema (DEV_DB aware)"
	@echo "  dev          run api + web in development mode"
	@echo "  seed         seed demo users/zones/orders (dev DB)"
	@echo "  preview      build web, run api serving it on :3000"
	@echo "  test         run all unit tests"
	@echo "  lint         eslint"
	@echo "  typecheck    tsc across workspaces"
	@echo "  e2e          playwright end-to-end suite"
	@echo "  up           docker compose up (production-like local, needs Docker)"
	@echo "  down         docker compose down"

install:
	npm install

db:prepare:
	npm run db:prepare

dev:
	npm run dev

seed:
	npm run seed

preview:
	npm run build --workspace @ronmacrae/web && WEB_DIST=$$(pwd)/apps/web/dist npm run preview:api

test:
	npm run test

lint:
	npm run lint

typecheck:
	npm run typecheck

e2e:
	npx playwright install chromium
	npm run e2e

up:
	docker compose up -d --build

down:
	docker compose down
