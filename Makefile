# Copyright 2026 hotBrief contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0

.PHONY: setup start stop restart logs test build pull clean help

help:
	@echo "hotBrief — useful targets:"
	@echo "  make setup     copy .env.example -> .env and config.example.yml -> config.yml"
	@echo "  make start     docker compose up -d"
	@echo "  make stop      docker compose down"
	@echo "  make restart   docker compose restart aggregator"
	@echo "  make logs      tail aggregator logs"
	@echo "  make test      send a one-shot digest push for verification"
	@echo "  make build     rebuild the aggregator image"
	@echo "  make pull      pull latest dailyhotapi image"
	@echo "  make clean     stop containers and remove the data volume directory"

setup:
	@if [ ! -f .env ]; then cp .env.example .env; echo "created .env from .env.example"; else echo ".env already exists, leaving it alone"; fi
	@if [ ! -f config.yml ]; then cp config.example.yml config.yml; echo "created config.yml from config.example.yml"; else echo "config.yml already exists, leaving it alone"; fi
	@echo ""
	@echo "Next steps:"
	@echo "  1. Edit .env and fill in SERVERCHAN_SCT_KEY, LLM_API_KEY, LLM_BASE_URL"
	@echo "  2. Edit config.yml to enable/disable sources as you like"
	@echo "  3. Run: make start"

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

build:
	docker compose build aggregator

pull:
	docker compose pull dailyhotapi

clean:
	docker compose down
	@echo "to wipe SQLite state, run: rm -rf data/"
