import { chatCompletion } from './llm/client.js'
import { CROSS_REVIEW_SYSTEM_PROMPT, buildCrossReviewPrompt } from './llm/prompts.js'
import { config } from './config.js'
import type {
  ModelReviewResult,
  CrossReviewVerdict,
  CrossReviewResult,
  ReviewFinding,
  Verdict,
  Severity,
} from './types.js'

interface IndexedFinding {
  index: number
  model: string
  finding: ReviewFinding
}

function collectFindings(results: ModelReviewResult[]): IndexedFinding[] {
  const indexed: IndexedFinding[] = []
  for (const r of results) {
    if (r.status === 'failed') continue
    for (const f of r.findings) {
      indexed.push({ index: indexed.length, model: r.model, finding: f })
    }
  }
  return indexed
}

function parseVerdicts(raw: string, indexed: IndexedFinding[]): CrossReviewVerdict[] {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()

  const match = cleaned.match(/\[[\s\S]*\]/)
  if (!match) return []

  try {
    const parsed = JSON.parse(match[0]) as unknown[]
    if (!Array.isArray(parsed)) return []

    return parsed
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .filter(item => {
        const idx = item['findingIndex']
        return typeof idx === 'number' && idx >= 0 && idx < indexed.length
      })
      .map(item => {
        const idx = item['findingIndex'] as number
        const validVerdicts: Verdict[] = ['agree', 'disagree', 'refine']
        const validSeverities: Severity[] = ['blocking', 'warning', 'suggestion']

        return {
          findingIndex: idx,
          originalModel: indexed[idx]!.model,
          verdict: validVerdicts.includes(item['verdict'] as Verdict)
            ? (item['verdict'] as Verdict)
            : 'agree',
          rationale: typeof item['rationale'] === 'string' ? item['rationale'] : '',
          refinedTitle: typeof item['refinedTitle'] === 'string' ? item['refinedTitle'] : undefined,
          refinedSeverity: validSeverities.includes(item['refinedSeverity'] as Severity)
            ? (item['refinedSeverity'] as Severity)
            : undefined,
        }
      })
  } catch {
    return []
  }
}

export async function runCrossReview(
  models: string[],
  stage1Results: ModelReviewResult[],
  diffContent: string,
): Promise<CrossReviewResult[]> {
  const indexed = collectFindings(stage1Results)

  if (indexed.length === 0) {
    console.log('\n  ℹ️  No findings to cross-review.')
    return []
  }

  console.log(`\n${'═'.repeat(50)}`)
  console.log(`🔄 Stage 2: Cross-review (${indexed.length} findings across ${models.length} models)`)
  console.log(`${'═'.repeat(50)}`)

  const promptFindings = indexed.map(f => ({
    index: f.index,
    model: f.model,
    file: f.finding.file,
    line: f.finding.line,
    severity: f.finding.severity,
    title: f.finding.title,
    body: f.finding.body,
  }))

  const crossResults: CrossReviewResult[] = []

  for (let i = 0; i < models.length; i++) {
    const model = models[i]!
    const otherFindings = promptFindings.filter(f => f.model !== model)

    if (otherFindings.length === 0) {
      console.log(`\n  ⏭️  ${model} — no findings from other models to review`)
      continue
    }

    console.log(`\n  🔄 [${i + 1}/${models.length}] ${model} cross-reviewing ${otherFindings.length} findings...`)

    const startTime = Date.now()

    try {
      const userPrompt = buildCrossReviewPrompt(diffContent, otherFindings)
      const raw = await chatCompletion(model, CROSS_REVIEW_SYSTEM_PROMPT, userPrompt, config.review.timeoutMs)
      const verdicts = parseVerdicts(raw, indexed)

      const durationMs = Date.now() - startTime
      const agrees = verdicts.filter(v => v.verdict === 'agree').length
      const disagrees = verdicts.filter(v => v.verdict === 'disagree').length
      const refines = verdicts.filter(v => v.verdict === 'refine').length

      console.log(`     ✅ ${agrees} agree · ❌ ${disagrees} disagree · ✏️ ${refines} refine (${(durationMs / 1000).toFixed(1)}s)`)

      crossResults.push({
        reviewerModel: model,
        verdicts,
        durationMs,
        status: 'completed',
      })
    } catch (err) {
      const durationMs = Date.now() - startTime
      const message = err instanceof Error ? err.message : String(err)
      const isTimeout = err instanceof DOMException && err.name === 'TimeoutError'
      const label = isTimeout
        ? `timed out after ${(config.review.timeoutMs / 1000).toFixed(0)}s`
        : `failed: ${message}`

      console.error(`  ❌ ${model} cross-review ${label}`)

      crossResults.push({
        reviewerModel: model,
        verdicts: [],
        durationMs,
        status: 'failed',
        error: label,
      })
    }
  }

  return crossResults
}
