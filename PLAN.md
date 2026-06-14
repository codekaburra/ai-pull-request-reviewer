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

### Phase 1 — Local-diff mode + console output  ◄── IN PROGRESS
- `src/source/local-diff.ts` — `git diff` (default uncommitted vs HEAD; `--local <base>` for branch
  range). Filter skip-patterns. Return a `PRInfo`-shaped object (branch name as title).
- `src/report/console.ts` — print grouped findings + per-model summary to the terminal.
- Decouple posting from review: `reviewer.ts` returns results; the *caller* prints (local) or posts (PR).
- `cli.ts` — add `--local [base]` alongside the existing `owner/repo#123` mode.

### Phase 2 — Cross-review (Stage 2)
- `src/crossReview.ts` — feed each model the merged findings of the others; collect agree/refute/refine.

### Phase 3 — Consolidation (Stage 3)
- `src/aggregator.ts` — group by file + line + title similarity; collapse duplicates; compute
  "agreed by N/M". Severity = max across agreeing models, optionally bumped by agreement count.

### Phase 4 — Polish
- Optional CI workflow (only where a runner has Ollama).
- `config.ts` — easy model-list editing; document recommended local coding models.

## Review-quality notes
- Ask each model to **report every finding with confidence + severity**; let Stage 3 filter — better
  coverage than each model self-censoring to "high severity only".
- Run Ollama models **sequentially** (config already sets `keep_alive: 0` to unload between models),
  so a modest machine can run several models without holding them all in VRAM at once.

## Build order
1. Phase 1 — local-diff + console (usable immediately).
2. Phase 2 — cross-review.
3. Phase 3 — aggregator.
4. Phase 4 — CI + config polish.
