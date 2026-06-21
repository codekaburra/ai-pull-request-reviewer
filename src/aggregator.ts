import type {
  ModelReviewResult,
  CrossReviewResult,
  ReviewFinding,
  AggregatedFinding,
  AggregatedReport,
  Confidence,
  Severity,
} from './types.js'

interface TaggedFinding {
  model: string
  globalIndex: number
  finding: ReviewFinding
}

function normalizeKey(f: ReviewFinding): string {
  const title = f.title
    .replace(/`[^`]+`/g, '*')
    .replace(/\b[A-Z][a-zA-Z]+(?:\.[a-zA-Z]+)+/g, '*')
    .trim()
    .toLowerCase()

  const lineGroup = f.line !== null ? Math.floor(f.line / 5) : -1
  return `${f.file}:${lineGroup}:${f.category}:${title}`
}

const SEVERITY_RANK: Record<Severity, number> = { blocking: 0, warning: 1, suggestion: 2 }

function pickSeverity(severities: Severity[]): Severity {
  return severities.reduce((a, b) => SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b)
}

function computeConfidence(score: number): Confidence {
  if (score >= 0.7) return 'high'
  if (score >= 0.4) return 'medium'
  return 'low'
}

export function aggregate(
  stage1Results: ModelReviewResult[],
  crossResults: CrossReviewResult[],
): AggregatedReport {
  const activeModels = stage1Results.filter(r => r.status !== 'failed')
  const totalModels = activeModels.length

  const tagged: TaggedFinding[] = []
  for (const r of activeModels) {
    for (const f of r.findings) {
      tagged.push({ model: r.model, globalIndex: tagged.length, finding: f })
    }
  }

  const verdictMap = new Map<number, { agreed: string[]; disagreed: string[]; refined: string[]; refinedSeverity?: Severity }>()
  for (const cr of crossResults) {
    if (cr.status === 'failed') continue
    for (const v of cr.verdicts) {
      if (!verdictMap.has(v.findingIndex)) {
        verdictMap.set(v.findingIndex, { agreed: [], disagreed: [], refined: [] })
      }
      const entry = verdictMap.get(v.findingIndex)!
      if (v.verdict === 'agree') entry.agreed.push(cr.reviewerModel)
      else if (v.verdict === 'disagree') entry.disagreed.push(cr.reviewerModel)
      else if (v.verdict === 'refine') {
        entry.refined.push(cr.reviewerModel)
        if (v.refinedSeverity) entry.refinedSeverity = v.refinedSeverity
      }
    }
  }

  const groups = new Map<string, TaggedFinding[]>()
  for (const t of tagged) {
    const key = normalizeKey(t.finding)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(t)
  }

  const aggregated: AggregatedFinding[] = []

  for (const members of groups.values()) {
    const models = [...new Set(members.map(m => m.model))]
    const primary = members[0]!.finding

    const allAgreed = new Set<string>()
    const allDisagreed = new Set<string>()
    const allRefined = new Set<string>()
    let refinedSeverity: Severity | undefined

    for (const m of members) {
      const v = verdictMap.get(m.globalIndex)
      if (v) {
        v.agreed.forEach(a => allAgreed.add(a))
        v.disagreed.forEach(d => allDisagreed.add(d))
        v.refined.forEach(r => allRefined.add(r))
        if (v.refinedSeverity) refinedSeverity = v.refinedSeverity
      }
    }

    const reporters = models.length
    const supporters = reporters + allAgreed.size + allRefined.size
    const opposers = allDisagreed.size

    let score: number
    if (totalModels <= 1) {
      score = 0.5
    } else {
      score = (supporters - opposers * 0.5) / totalModels
      score = Math.max(0, Math.min(1, score))
    }

    const severity = refinedSeverity
      ?? pickSeverity(members.map(m => m.finding.severity))

    const bestBody = members.reduce((a, b) =>
      a.finding.body.length >= b.finding.body.length ? a : b,
    ).finding.body

    const suggestedFix = members.find(m => m.finding.suggestedFix)?.finding.suggestedFix

    aggregated.push({
      file: primary.file,
      line: primary.line,
      severity,
      category: primary.category,
      title: primary.title,
      body: bestBody,
      suggestedFix,
      reportedBy: models,
      agreedBy: [...allAgreed],
      disagreedBy: [...allDisagreed],
      refinedBy: [...allRefined],
      confidence: computeConfidence(score),
      score,
    })
  }

  aggregated.sort((a, b) => {
    if (a.confidence !== b.confidence) {
      const order: Record<Confidence, number> = { high: 0, medium: 1, low: 2 }
      return order[a.confidence] - order[b.confidence]
    }
    return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  })

  const highConfidence = aggregated.filter(f => f.confidence === 'high').length
  const filtered = tagged.length - aggregated.length

  return {
    findings: aggregated,
    totalModels,
    stats: {
      totalRaw: tagged.length,
      deduplicated: aggregated.length,
      highConfidence,
      filtered,
    },
  }
}
