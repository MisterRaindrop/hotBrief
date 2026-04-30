# Copyright 2026 hotBrief contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0

.PHONY: setup doctor up start stop restart logs test test-foreign build pull clean help

help:
	@echo "hotBrief — useful targets:"
	@echo "  make setup        copy .env.example -> .env and config.example.yml -> config.yml"
	@echo "  make doctor       check .env / config.yml are filled in (run before make start)"
	@echo "  make up           one-shot deploy: doctor + build + start + tail logs"
	@echo "  make start        docker compose up -d"
	@echo "  make stop         docker compose down"
	@echo "  make restart      docker compose restart aggregator"
	@echo "  make logs         tail aggregator logs"
	@echo "  make test         send a one-shot digest push for verification"
	@echo "  make test-foreign send a one-shot foreign-source full-text push"
	@echo "  make build        rebuild the aggregator image"
	@echo "  make pull         pull latest dailyhotapi image"
	@echo "  make clean        stop containers and remove the data volume directory"

setup:
	@if [ ! -f .env ]; then cp .env.example .env; echo "created .env from .env.example"; else echo ".env already exists, leaving it alone"; fi
	@if [ ! -f config.yml ]; then cp config.example.yml config.yml; echo "created config.yml from config.example.yml"; else echo "config.yml already exists, leaving it alone"; fi
	@echo ""
	@echo "Next steps:"
	@echo "  1. Edit .env and fill in SERVERCHAN_SCT_KEY, LLM_API_KEY, LLM_BASE_URL"
	@echo "  2. Edit config.yml to enable/disable sources as you like"
	@echo "  3. Run: make up"

# Validate that the user has filled in real values for required keys.
# Run this before `make start` to fail fast with a clear hint, instead
# of letting the aggregator container crash at startup.
doctor:
	@test -f .env       || (echo "✗ .env missing (run 'make setup' first)" && exit 1)
	@test -f config.yml || (echo "✗ config.yml missing (run 'make setup' first)" && exit 1)
	@grep -q '^SERVERCHAN_SCT_KEY=SCT' .env && ! grep -q 'SCT_REPLACE_ME' .env || (echo "✗ .env: SERVERCHAN_SCT_KEY is missing or still a placeholder" && exit 1)
	@grep -q '^LLM_API_KEY=sk' .env && ! grep -q 'sk-REPLACE_ME' .env || (echo "✗ .env: LLM_API_KEY is missing or still a placeholder" && exit 1)
	@grep -q '^LLM_BASE_URL=https://' .env || (echo "✗ .env: LLM_BASE_URL is missing or invalid" && exit 1)
	@docker info >/dev/null 2>&1 || (echo "✗ docker daemon not reachable; start Docker Desktop / dockerd first" && exit 1)
	@echo "✓ .env and config.yml look good; docker daemon is up"

# One-shot deploy: validate, build, start, then tail aggregator logs.
up: doctor
	docker compose build aggregator
	docker compose up -d
	@echo ""
	@echo "✓ deployed. Tailing aggregator logs (Ctrl+C to detach — containers keep running)."
	@docker compose logs -f aggregator

start:
	docker compose up -d

stop:
	docker compose down

restart:
	docker compose restart aggregator

logs:
	docker compose logs -f aggregator

test:
	docker compose exec aggregator node src/push.js --digest

test-foreign:
	docker compose exec aggregator node src/push.js --foreign-fulltext

build:
	docker compose build aggregator

pull:
	docker compose pull dailyhotapi

clean:
	docker compose down
	@echo "to wipe SQLite state, run: rm -rf data/"
