import { Octokit } from '@octokit/rest'
import { getGithubToken } from './auth.js'
import { getDiffPosition } from './diff-parser.js'
import type { ReviewFinding, ModelReviewResult, CrossReviewResult, AggregatedReport } from '../types.js'
import type { DiffPositionMap } from '../types.js'

const SEVERITY_EMOJI: Record<string, string> = {
  blocking:   '🔴',
  warning:    '🟡',
  suggestion: '🔵',
}

const CATEGORY_LABEL: Record<string, string> = {
  security: 'Security',
  logic:    'Logic',
  style:    'Style',
  tests:    'Tests',
  general:  'General',
}

function formatFindingsTable(findings: ReviewFinding[]): string {
  let table = `\n\n| | Line | Title | Detail |\n|---|---|---|---|\n`
  for (const f of findings) {
    const emoji = SEVERITY_EMOJI[f.severity] ?? '⚪'
    const cat = CATEGORY_LABEL[f.category] ?? f.category
    const line = f.line ?? '—'
    const detail = f.body.replace(/\|/g, '\\|').replace(/\n/g, ' ')
    table += `| ${emoji} ${cat} | ${line} | **${f.title}** | ${detail} |\n`
  }
  return table
}

function formatInlineComment(finding: ReviewFinding, model: string): string {
  const severityEmoji = SEVERITY_EMOJI[finding.severity] ?? '⚪'
  const categoryLabel = CATEGORY_LABEL[finding.category] ?? finding.category

  let comment = `🤖 **\`${model}\`**\n\n`
  comment += `${severityEmoji} **[${categoryLabel}] ${finding.title}**\n\n`
  comment += `${finding.body}`

  if (finding.suggestedFix) {
    comment += `\n\n**Suggested fix:**\n\`\`\`suggestion\n${finding.suggestedFix}\n\`\`\``
  }

  return comment
}

function formatSummaryComment(result: ModelReviewResult): string {
  const { model, findings, durationMs, status, error, chunksTotal, chunksCompleted } = result
  const seconds = (durationMs / 1000).toFixed(1)

  const statusIcon = status === 'completed' ? '🤖' : status === 'partial' ? '⚠️' : '❌'
  let comment = `## ${statusIcon} Code Review by \`${model}\`\n\n`

  if (status === 'failed') {
    comment += `**Review failed:** ${error}\n\n`
    comment += `No files were reviewed. This model may be unavailable or unresponsive.\n\n`
    comment += `---\n⏱️ Failed after ${seconds}s`
    return comment
  }

  if (status === 'partial') {
    comment += `> ⚠️ **Partial review** — completed ${chunksCompleted}/${chunksTotal} chunks before failure: ${error}\n\n`
  }

  const counts = {
    blocking:   findings.filter(f => f.severity === 'blocking').length,
    warning:    findings.filter(f => f.severity === 'warning').length,
    suggestion: findings.filter(f => f.severity === 'suggestion').length,
  }

  if (findings.length === 0) {
    comment += `✅ No issues found. Looks good!\n\n`
  } else {
    comment += `Found **${findings.length}** finding(s):\n\n`
    comment += `| Severity | Count |\n|---|---|\n`
    if (counts.blocking > 0)   comment += `| 🔴 Blocking   | ${counts.blocking} |\n`
    if (counts.warning > 0)    comment += `| 🟡 Warning    | ${counts.warning} |\n`
    if (counts.suggestion > 0) comment += `| 🔵 Suggestion | ${counts.suggestion} |\n`
    comment += `\n`

    const byFile = new Map<string, ReviewFinding[]>()
    for (const f of findings) {
      const key = f.file ?? 'PR Level'
      if (!byFile.has(key)) byFile.set(key, [])
      byFile.get(key)!.push(f)
    }

    comment += `### Findings\n\n`
    for (const [file, fileFindings] of byFile) {
      comment += `**\`${file}\`**\n`
      for (const f of fileFindings) {
        const emoji = SEVERITY_EMOJI[f.severity] ?? '⚪'
        const line = f.line ? ` (line ${f.line})` : ''
        comment += `- ${emoji} **${f.title}**${line}\n`
      }
      comment += `\n`
    }
  }

  comment += `---\n⏱️ Reviewed in ${seconds}s`
  return comment
}

export async function postFileReview(
  owner: string,
  repo: string,
  prNumber: number,
  model: string,
  findings: ReviewFinding[],
  filename: string,
  chunkIndex: number,
  totalChunks: number,
  positionMap: DiffPositionMap,
): Promise<void> {
  if (findings.length === 0) return

  const octokit = new Octokit({ auth: getGithubToken() })

  const inlineComments: { path: string; position: number; body: string }[] = []
  const orphanFindings: ReviewFinding[] = []

  for (const finding of findings) {
    if (!finding.file || finding.line === null) {
      orphanFindings.push(finding)
      continue
    }

    const position = getDiffPosition(positionMap, finding.file, finding.line)
    if (position === null) {
      orphanFindings.push(finding)
      continue
    }

    inlineComments.push({
      path: finding.file,
      position,
      body: formatInlineComment(finding, model),
    })
  }

  const progress = `[${chunkIndex + 1}/${totalChunks}]`

  if (inlineComments.length > 0) {
    let body = `🤖 **\`${model}\`** ${progress} — **\`${filename}\`** — ${findings.length} finding(s)`

    if (orphanFindings.length > 0) {
      body += formatFindingsTable(orphanFindings)
    }

    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      event: 'COMMENT',
      body,
      comments: inlineComments,
    })
  } else {
    let body = `🤖 **\`${model}\`** ${progress} — **\`${filename}\`** — ${findings.length} finding(s)\n\n`
    body += formatFindingsTable(findings)

    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    })
  }

  console.log(`  💬 ${model} posted ${findings.length} finding(s) for ${filename}`)
}

export async function postModelSummary(
  owner: string,
  repo: string,
  prNumber: number,
  result: ModelReviewResult,
): Promise<void> {
  const octokit = new Octokit({ auth: getGithubToken() })

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: formatSummaryComment(result),
  })

  console.log(`✅ ${result.model} summary posted`)
}

export async function postCrossReviewComment(
  owner: string,
  repo: string,
  prNumber: number,
  stage1Results: ModelReviewResult[],
  crossResults: CrossReviewResult[],
): Promise<void> {
  if (crossResults.length === 0) return

  const octokit = new Octokit({ auth: getGithubToken() })

  const allFindings: { model: string; finding: ReviewFinding }[] = []
  for (const r of stage1Results) {
    if (r.status === 'failed') continue
    for (const f of r.findings) {
      allFindings.push({ model: r.model, finding: f })
    }
  }

  let body = `## 🔄 Cross-Review Results\n\n`
  body += `Each model evaluated the other models' findings.\n\n`

  for (const cr of crossResults) {
    if (cr.status === 'failed') {
      body += `### ❌ \`${cr.reviewerModel}\` — failed\n${cr.error}\n\n`
      continue
    }

    const agrees = cr.verdicts.filter(v => v.verdict === 'agree').length
    const disagrees = cr.verdicts.filter(v => v.verdict === 'disagree').length
    const refines = cr.verdicts.filter(v => v.verdict === 'refine').length

    body += `### 🤖 \`${cr.reviewerModel}\` — ✅ ${agrees} agree · ❌ ${disagrees} disagree · ✏️ ${refines} refine\n\n`

    if (cr.verdicts.length > 0) {
      body += `| # | Original Model | Finding | Verdict | Rationale |\n`
      body += `|---|---|---|---|---|\n`

      for (const v of cr.verdicts) {
        const f = allFindings[v.findingIndex]
        const title = f ? f.finding.title : `(finding #${v.findingIndex})`
        const verdictEmoji = v.verdict === 'agree' ? '✅' : v.verdict === 'disagree' ? '❌' : '✏️'
        const rationale = v.rationale.replace(/\|/g, '\\|').replace(/\n/g, ' ')
        body += `| ${v.findingIndex} | \`${v.originalModel}\` | ${title} | ${verdictEmoji} ${v.verdict} | ${rationale} |\n`
      }
      body += `\n`
    }
  }

  body += `---\n⏱️ Cross-review completed`

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  })

  console.log(`🔄 Cross-review comment posted`)
}

const CONFIDENCE_EMOJI: Record<string, string> = {
  high:   '🟢',
  medium: '🟡',
  low:    '⚪',
}

export async function postCompletionComment(
  owner: string,
  repo: string,
  prNumber: number,
  results: ModelReviewResult[],
  report?: AggregatedReport,
): Promise<void> {
  const octokit = new Octokit({ auth: getGithubToken() })

  const allCompleted = results.every(r => r.status === 'completed')
  const anyFailed = results.some(r => r.status === 'failed' || r.status === 'partial')

  let body = allCompleted
    ? `## ✅ Code Review Complete\n\n`
    : `## ⚠️ Code Review Complete (with failures)\n\n`

  // ── Model summary table ───────────────────────────────────────
  body += `### Per-Model Results\n\n`
  body += `| Model | Status | 🔴 | 🟡 | 🔵 | Total |\n`
  body += `|---|---|---|---|---|---|\n`

  for (const r of results) {
    const blocking   = r.findings.filter(f => f.severity === 'blocking').length
    const warning    = r.findings.filter(f => f.severity === 'warning').length
    const suggestion = r.findings.filter(f => f.severity === 'suggestion').length
    const statusLabel = r.status === 'completed' ? '✅'
      : r.status === 'partial' ? `⚠️ ${r.chunksCompleted}/${r.chunksTotal}`
      : '❌ failed'
    body += `| \`${r.model}\` | ${statusLabel} | ${blocking} | ${warning} | ${suggestion} | ${r.findings.length} |\n`
  }

  if (anyFailed) {
    const failedModels = results.filter(r => r.status !== 'completed')
    body += `\n> ⚠️ **${failedModels.length} model(s) did not complete:** ${failedModels.map(r => `\`${r.model}\` (${r.error})`).join(', ')}\n`
  }

  // ── Aggregated findings ───────────────────────────────────────
  if (report && report.findings.length > 0) {
    const { stats } = report
    body += `\n### 📋 Consolidated Findings\n\n`
    body += `> ${stats.totalRaw} raw findings → **${stats.deduplicated} unique** (${stats.filtered} duplicates merged) · ${stats.highConfidence} high-confidence\n\n`

    body += `| Conf. | Sev. | File | Line | Finding | Reported By | Score |\n`
    body += `|---|---|---|---|---|---|---|\n`

    for (const f of report.findings) {
      const conf = CONFIDENCE_EMOJI[f.confidence] ?? '⚪'
      const sev = SEVERITY_EMOJI[f.severity] ?? '⚪'
      const line = f.line ?? '—'
      const models = f.reportedBy.map(m => `\`${m}\``).join(', ')
      const title = f.title.replace(/\|/g, '\\|')
      body += `| ${conf} ${f.confidence} | ${sev} | \`${f.file}\` | ${line} | ${title} | ${models} | ${f.score.toFixed(2)} |\n`
    }

    const blocking = report.findings.filter(f => f.severity === 'blocking').length
    if (blocking > 0) {
      body += `\n> ⚠️ **${blocking} blocking issue(s) found.** Please address before merging.\n`
    }
  } else if (report) {
    body += `\n### 📋 Consolidated Findings\n\n✅ No issues survived aggregation — all models agree the code looks good.\n`
  }

  body += `\n---\n*Reviewed by ${results.length} model(s)*`

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  })

  console.log(`\n🏁 Final completion comment posted.`)
}
