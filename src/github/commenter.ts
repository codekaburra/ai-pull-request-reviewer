import { Octokit } from '@octokit/rest'
import { getGithubToken } from './auth.js'
import { getDiffPosition } from './diff-parser.js'
import type { ReviewFinding, ModelReviewResult } from '../types.js'
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
  const { model, findings, durationMs } = result
  const seconds = (durationMs / 1000).toFixed(1)

  const counts = {
    blocking:   findings.filter(f => f.severity === 'blocking').length,
    warning:    findings.filter(f => f.severity === 'warning').length,
    suggestion: findings.filter(f => f.severity === 'suggestion').length,
  }

  let comment = `## 🤖 Code Review by \`${model}\`\n\n`

  if (findings.length === 0) {
    comment += `✅ No issues found. Looks good!\n\n`
  } else {
    comment += `Found **${findings.length}** finding(s):\n\n`
    comment += `| Severity | Count |\n|---|---|\n`
    if (counts.blocking > 0)   comment += `| 🔴 Blocking   | ${counts.blocking} |\n`
    if (counts.warning > 0)    comment += `| 🟡 Warning    | ${counts.warning} |\n`
    if (counts.suggestion > 0) comment += `| 🔵 Suggestion | ${counts.suggestion} |\n`
    comment += `\n`

    // Group findings by file
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

export async function postModelReview(
  owner: string,
  repo: string,
  prNumber: number,
  result: ModelReviewResult,
  positionMap: DiffPositionMap
): Promise<void> {
  const octokit = new Octokit({ auth: getGithubToken() })
  const { model, findings } = result

  // Build inline comments — only for findings with a file + line in the diff
  const inlineComments: { path: string; position: number; body: string }[] = []

  for (const finding of findings) {
    if (!finding.file || finding.line === null) continue

    const position = getDiffPosition(positionMap, finding.file, finding.line)
    if (position === null) continue   // line not in diff, skip inline

    inlineComments.push({
      path: finding.file,
      position,
      body: formatInlineComment(finding, model),
    })
  }

  // Post as a single review (atomic — one block per model in the PR timeline)
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    event: 'COMMENT',
    body: formatSummaryComment(result),
    comments: inlineComments,
  })

  console.log(
    `✅ ${model} posted ${inlineComments.length} inline comment(s) + summary`
  )
}

export async function postCompletionComment(
  owner: string,
  repo: string,
  prNumber: number,
  results: ModelReviewResult[]
): Promise<void> {
  const octokit = new Octokit({ auth: getGithubToken() })

  const totalFindings = results.reduce((sum, r) => sum + r.findings.length, 0)
  const totalBlocking = results.reduce(
    (sum, r) => sum + r.findings.filter(f => f.severity === 'blocking').length,
    0
  )

  let body = `## ✅ Code Review Complete\n\n`
  body += `All models have finished reviewing PR #${prNumber}.\n\n`
  body += `| Model | 🔴 Blocking | 🟡 Warning | 🔵 Suggestion | Total |\n`
  body += `|---|---|---|---|---|\n`

  for (const r of results) {
    const blocking   = r.findings.filter(f => f.severity === 'blocking').length
    const warning    = r.findings.filter(f => f.severity === 'warning').length
    const suggestion = r.findings.filter(f => f.severity === 'suggestion').length
    body += `| 🤖 \`${r.model}\` | ${blocking} | ${warning} | ${suggestion} | ${r.findings.length} |\n`
  }

  body += `\n**${results.length} models reviewed this PR — ${totalFindings} total finding(s)**`

  if (totalBlocking > 0) {
    body += `\n\n> ⚠️ **${totalBlocking} blocking issue(s) found.** Please address before merging.`
  }

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  })

  console.log(`\n🏁 Final completion comment posted.`)
}
