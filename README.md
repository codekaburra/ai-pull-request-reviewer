# AI Code Reviewer

Multi-model code reviewer powered by local Ollama LLMs. Runs multiple models (phi4, starcoder2, mistral) sequentially against your code changes and reports findings — fully local, no cloud APIs, nothing leaves your machine.

## Features

- **Multi-model review** — each model reviews independently, findings are labelled by model name
- **Two modes** — local `git diff` (print to terminal) or GitHub PR (post inline comments)
- **Sequential execution** — models run one at a time with automatic VRAM unloading (`keep_alive: 0`)
- **Unified diff parsing** — splits large diffs into chunks that fit model context windows
- **Skip patterns** — auto-skips lockfiles, build output, generated code

## Prerequisites

- [Ollama](https://ollama.com) running locally
- Models pulled:
  ```
  ollama pull phi4
  ollama pull starcoder2:7b
  ollama pull mistral
  ```
- For GitHub PR mode: [gh CLI](https://cli.github.com) logged in, or `GITHUB_TOKEN` in `.env`

## Install

```bash
npm install
```

## Usage

### Review local changes

```bash
# Uncommitted changes vs HEAD
npm run review -- --local

# Branch changes vs main
npm run review -- --local main
```

### Review a GitHub PR

```bash
# Full URL
npm run review -- https://github.com/owner/repo/pull/123

# Short format
npm run review -- owner/repo#123
```

PR mode posts inline comments and a summary table per model directly on the pull request.

## Configuration

Edit `src/config.ts` to change:

- **Models** — add/remove Ollama models in the `models` array
- **Ollama URL** — override with `OLLAMA_BASE_URL` env var (default: `http://localhost:11434`)
- **Skip patterns** — file globs to exclude from review

## How it works

```
CLI input (local diff or PR URL)
  → fetch/parse unified diff
  → split into per-file chunks
  → each Ollama model reviews each chunk sequentially
  → report: terminal output (local) or GitHub PR comments (PR mode)
```

Each model returns findings as structured JSON with severity (blocking/warning/suggestion), category, file, line, and optional suggested fix.

## Test

```bash
npm test
```

Runs a smoke test against a fixture diff — no git repo or Ollama needed.

## Roadmap

See [PLAN.md](PLAN.md) for the full build plan:

- **Phase 1** ✅ — Local diff + console, GitHub PR review
- **Phase 2** — Cross-review: models critique each other's findings
- **Phase 3** — Consolidation: dedupe + agreement scoring
- **Phase 4** — CI workflow, config polish, CLI flags
