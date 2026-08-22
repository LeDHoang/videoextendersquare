SHELL := /bin/bash
PY := .venv/bin/python
PIP := .venv/bin/pip
UVICORN := .venv/bin/uvicorn

.PHONY: dev build start install streamlit clean

## dev: concurrently runs FastAPI (8000) + Vite dev (5173)
dev:
	@trap 'kill 0' INT TERM EXIT; \
	$(UVICORN) server.app:app --reload --port 8000 & \
	cd web && npm run dev & \
	wait

## build: builds React -> web/dist/ and stages it into server/static/
build:
	cd web && npm run build
	rm -rf server/static
	mkdir -p server/static
	cp -R web/dist/. server/static/

## start: uvicorn production mode serving API + static (needs `make build` first)
start:
	$(UVICORN) server.app:app --host 0.0.0.0 --port 8000

## install: backend deps + frontend deps
install:
	$(PIP) install -r requirements.txt
	cd web && npm install

## streamlit: legacy fallback on 8501 (app.py is untouched)
streamlit:
	.venv/bin/streamlit run app.py

## clean: remove build artifacts
clean:
	rm -rf web/dist server/static