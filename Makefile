# Canvas ADE — task runner
#
# A thin, worktree-aware wrapper over the pnpm scripts + the .claude/tools helpers.
# Every recipe is a single, shell-agnostic command (pnpm / pwsh / git), so `make`
# behaves identically whether its recipe shell resolves to cmd.exe, sh, or pwsh.
#
# WORKTREES: this file lives in the repo, so a worktree created by
# `.claude/tools/new-worktree.ps1` (nested under .worktrees/<name>, with main's
# node_modules junctioned in) gets its OWN copy. Run any target from inside a
# worktree dir and it acts on THAT worktree — `make dev` there spawns that
# worktree's dev server (auto-titled with the worktree folder name), and Vite
# auto-increments the port so several worktree dev servers run side by side.
#
# Run `make` or `make help` for the target list.

# Pin the recipe shell deterministically. Without this, GNU Make picks cmd.exe OR a
# stray sh.exe depending on the invoking terminal's PATH — and sh chokes on the
# parentheses/semicolons in the help text. Local dev is Windows-only (CLAUDE.md), so
# force cmd.exe there; leave the POSIX default elsewhere. All functional recipes
# (pnpm/pwsh/git) are identical under cmd and sh, so only this pin needs OS awareness.
ifeq ($(OS),Windows_NT)
SHELL := cmd.exe
.SHELLFLAGS := /c
endif

.DEFAULT_GOAL := help
.PHONY: help dev dev-pr build start \
        typecheck lint format format-check \
        test test-unit test-integration test-watch \
        e2e e2e-smoke e2e-linux e2e-matrix \
        gate check rebuild \
        worktree worktree-rm worktrees signal-merge

## ---- Dev / build -----------------------------------------------------------

help:
	@echo Canvas ADE make targets:
	@echo   --- Dev / build ---
	@echo     make dev                 electron-vite dev (HMR); run from any worktree dir
	@echo     make dev-pr PR=263       dev, window title stamped PR#263 (CANVAS_DEV_TITLE)
	@echo     make build               bundle main/preload/renderer to out/
	@echo     make start               electron-vite preview (run the built app)
	@echo     make rebuild             electron-rebuild node-pty (native)
	@echo   --- Quality gate ---
	@echo     make typecheck           tsc across node + preload + web
	@echo     make lint                eslint .
	@echo     make format-check        prettier --check .
	@echo     make gate                cheap gate: typecheck + lint + format-check + unit/integration
	@echo     make check               FULL pre-merge gate: gate + e2e matrix (both legs)
	@echo   --- Tests ---
	@echo     make test                all vitest (unit + integration)
	@echo     make test-unit           vitest unit projects
	@echo     make test-integration    vitest integration projects
	@echo     make test-watch          vitest watch mode
	@echo     make e2e                 Playwright e2e, Windows leg (builds first)
	@echo     make e2e-smoke           e2e @core smoke subset
	@echo     make e2e-linux           e2e Linux leg (Docker)
	@echo     make e2e-matrix          e2e FULL matrix (Windows + Linux)
	@echo   --- Worktrees ---
	@echo     make worktree NAME=foo ZONE=src/main/foo.ts     create a coordinated worktree
	@echo     make worktree-rm NAME=foo                       tear one down safely
	@echo     make worktrees                                  list worktrees
	@echo     make signal-merge PR=263 SUBJECT=...            announce a main advance

dev:
	pnpm dev

# Stamp the dev window title so you can tell WHICH PR's build you are inspecting
# (CLAUDE.md > Manual dev check). Usage: make dev-pr PR=263  [FEATURE="my feature"]
dev-pr: export CANVAS_DEV_TITLE := PR#$(PR) $(FEATURE)
dev-pr:
	pnpm dev

build:
	pnpm build

start:
	pnpm start

rebuild:
	pnpm rebuild

## ---- Quality gate ----------------------------------------------------------

typecheck:
	pnpm typecheck

lint:
	pnpm lint

format:
	pnpm format

format-check:
	pnpm format:check

# Cheap gate = the pre-commit trio (typecheck/lint/format:check) + the unit/integration
# suites. Mirrors what CI's `check` job runs; does NOT run e2e (see `make check`).
gate: typecheck lint format-check test

# Full pre-merge gate. Run this before merging a feature branch to main:
# the cheap gate plus the FULL e2e matrix (Windows + Linux), as required by
# CLAUDE.md > Parallel sessions.
check: gate e2e-matrix

## ---- Tests -----------------------------------------------------------------

test:
	pnpm test

test-unit:
	pnpm test:unit

test-integration:
	pnpm test:integration

test-watch:
	pnpm test:watch

# Windows-native Playwright leg. `pnpm test:e2e` runs `pretest:e2e` (electron-vite build) first.
e2e:
	pnpm test:e2e

e2e-smoke:
	pnpm test:e2e:smoke

# Linux leg via Docker (needs the Docker daemon running).
e2e-linux:
	pnpm test:e2e:linux

# FULL matrix = both legs. Mandatory once per PR at the pre-merge gate.
e2e-matrix:
	pnpm test:e2e:matrix

## ---- Worktrees -------------------------------------------------------------

# Create a coordinated worktree: isolated dir + branch under .worktrees/<NAME>,
# node_modules junction, shared settings, and a coordination-board row.
# Usage: make worktree NAME=mcp-resize ZONE="src/main/mcp/resize.ts" [BASE=main]
worktree:
	pwsh .claude/tools/new-worktree.ps1 -Name "$(NAME)" -Zone "$(ZONE)" -Base "$(if $(BASE),$(BASE),main)"

# Tear a worktree down safely (drops the junction first; refuses if dirty).
# Usage: make worktree-rm NAME=mcp-resize
worktree-rm:
	pwsh .claude/tools/remove-worktree.ps1 -Name "$(NAME)"

worktrees:
	git worktree list

# Announce a main advance to every parallel session (run after pushing to origin/main).
# Usage: make signal-merge PR=263 SUBJECT="packaging crash fix"  [LOCKFILE=1]
signal-merge:
	pwsh .claude/tools/signal-merge.ps1 -Pr "$(PR)" -Subject "$(SUBJECT)" $(if $(LOCKFILE),-Lockfile,)
