# AI Code Reviewer — Build Plan (local-only)

Multi-model PR reviewer that runs **multiple local Ollama models**, has them cross-review each
other, and produces one consolidated review. Fully local — no cloud, no API keys, nothing leaves
the machine.

## Goals

1. **Multiple local models via Ollama.** e.g. phi4, qwen2.5-coder, mistral. Free, private, offline.
2. **3-stage review pipeline** for signal over noise:
   - **Stage 1 — Independent.** Each model reviews the diff alone; output is labelled with the model
     name (`phi4: …`, `qwen2.5-coder: …`).
   - **Stage 2 — Cross-review.** Each model is shown the *other* models' findings and critiques them
     (agree / disagree / refine). Catches hallucinated findings; promotes ones only one model saw.
   - **Stage 3 — Consolidation.** Dedupe overlapping findings and attach an agreement score
     ("flagged by 3/3 models"). One clean final result.
3. **Run modes**, one shared core:
   - **Local `git diff`** (primary) — review uncommitted/unpushed changes, print to terminal.
   - **GitHub PR by number** — review a pushed PR, post comments (LLM still local).
   - **CI** — optional; only practical where the runner has Ollama available.

## Current state (reuse as-is)

- `src/github/fetcher.ts` — fetch PR files + skip patterns.
- `src/github/diff-parser.ts` — unified diff → per-file chunks + inline-comment position map.
- `src/github/commenter.ts` — post inline + summary review blocks (already labels by model name).
- `src/github/auth.ts` — token via `gh` CLI or `GITHUB_TOKEN`.
- `src/llm/client.ts` — Ollama via the OpenAI-compatible API + JSON findings parser. **Stays Ollama-only.**
- `src/reviewer.ts` / `src/cli.ts` — orchestration: each model reviews the whole diff.

No provider abstraction needed — there is one backend (Ollama). If a second *local* OpenAI-compatible
server (LM Studio, llama.cpp, vLLM) is ever wanted, it's a baseURL change in `config.ts`, nothing more.

## Target architecture

```
cli.ts
  ├─ source: local git diff ──┐
  └─ source: GitHub PR #     ──┴─► diff chunks (reuse diff-parser.ts)
                                   │
                        reviewer.ts (orchestrator)
                                   │  Stage 1: each Ollama model reviews (sequential — 1 model in VRAM)
                          ModelReviewResult[]
                                   │
                        crossReview.ts (NEW)   ── Stage 2: each model critiques the others' findings
                                   │
                        aggregator.ts (NEW)    ── Stage 3: dedupe + agreement score
                                   ▼
            report/console.ts (local)   |   github/commenter.ts (PR)
```

## Work breakdown

### Phase 1 — Local-diff mode + console output  ✅ DONE
Delivers a usable end-to-end review tool with two modes: local git diff and GitHub PR.
- `src/source/local-diff.ts` — reads uncommitted changes (`--local`) or branch range (`--local main`)
  via `git diff`, filters skip-patterns, returns a `PRInfo`-shaped object.
- `src/report/console.ts` — terminal reporter that groups findings by file, shows severity/category,
  suggested fixes, and a per-model summary table.
- `src/reviewer.ts` — decoupled from posting; returns `ModelReviewResult[]` so the caller decides
  output (console for local, GitHub comments for PR).
- `src/cli.ts` — unified CLI: `--local [base]` for local review, `owner/repo#123` for GitHub PR.
- Models run sequentially with `keep_alive: 0` so only one sits in VRAM at a time.

### Phase 2 — Cross-review (Stage 2)
Each model critiques the other models' findings to filter noise and surface missed issues.
- `src/crossReview.ts` — takes the Stage 1 `ModelReviewResult[]`, builds a prompt per model
  containing the merged findings from the *other* models, and asks it to agree/disagree/refine
  each finding with a short rationale.
- Output: annotated findings with cross-review verdicts (e.g. "phi4 agrees, mistral disagrees").
- Depends on Phase 1 — uses the same `reviewChunk` LLM client and diff infrastructure.
- Key risk: prompt size — if Stage 1 produces many findings, the cross-review prompt may exceed
  smaller models' context windows. May need to batch or summarize findings before sending.

### Phase 3 — Consolidation / aggregator (Stage 3)
Merges Stage 1 + Stage 2 into one deduplicated, scored report.
- `src/aggregator.ts` — groups findings by file + line + title similarity (fuzzy match), collapses
  duplicates, and computes an agreement score ("flagged by 3/3 models").
- Final severity = max severity across agreeing models, optionally bumped when agreement is unanimous.
- Console reporter and GitHub commenter both get a single consolidated `ConsolidatedResult` instead
  of per-model results — cleaner output, less comment noise on PRs.
- Depends on Phase 2 — cross-review verdicts feed into the agreement scoring.

### Phase 4 — CI, config, and polish
Makes the tool easy to configure, run in CI, and extend with new models.
- GitHub Actions workflow — only practical where the runner has Ollama (self-hosted or GPU runner).
  Triggers on PR open/update, posts consolidated review as PR comments.
- `config.ts` improvements — support model list from env var or config file, document recommended
  local coding models (qwen2.5-coder, deepseek-coder-v2, codellama, etc.) with VRAM requirements.
- CLI quality-of-life — `--models` flag to override default list, `--verbose` for debug output,
  `--json` to emit machine-readable results.
- Error handling polish — timeout per model, retry on Ollama connection failure, graceful skip
  if a model isn't pulled yet.

## Review-quality notes
- Ask each model to **report every finding with confidence + severity**; let Stage 3 filter — better
  coverage than each model self-censoring to "high severity only".
- Run Ollama models **sequentially** (config already sets `keep_alive: 0` to unload between models),
  so a modest machine can run several models without holding them all in VRAM at once.

## Build order

| Phase | Status | What it delivers | Depends on |
|-------|--------|-----------------|------------|
| 1. Local-diff + console | ✅ Done | Usable multi-model reviewer for local changes and GitHub PRs | — |
| 2. Cross-review | Not started | Models critique each other's findings, filtering hallucinations | Phase 1 |
| 3. Aggregator | Not started | Deduplicated, agreement-scored consolidated report | Phase 2 |
| 4. CI + polish | Not started | GitHub Actions workflow, CLI flags, config improvements | Phase 1 (Phase 2-3 optional) |

Phase 4 can start after Phase 1 alone (CI just runs the existing sequential review), but benefits
from Phase 2-3 being done first so CI posts the consolidated output rather than per-model blocks.
