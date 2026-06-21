import { Octokit } from '@octokit/rest'
import { getGithubToken } from './auth.js'
import type { ReviewFinding, ModelReviewResult } from '../types.js'

const SEVERITY_EMOJI: Record<string, string> = {
  blocking:   '🔴',
  warning:    '🟡',
  suggestion: '🔵',
}

const SEVERITY_LABEL: Record<string, string> = {
  blocking:   'blocking',
  warning:    'warning',
  suggestion: 'suggestion',
}

function buildIssueBody(file: string, findings: { model: string; finding: ReviewFinding }[]): string {
  let body = `## 🤖 AI Code Review Findings\n\n`
  body += `**File:** \`${file}\`\n\n`

  for (const { model, finding } of findings) {
    const emoji = SEVERITY_EMOJI[finding.severity] ?? '⚪'
    const loc = finding.line ? ` (line ${finding.line})` : ''
    body += `### ${emoji} ${finding.title}${loc}\n\n`
    body += `**Model:** \`${model}\` · **Severity:** ${finding.severity} · **Category:** ${finding.category}\n\n`
    body += `${finding.body}\n\n`

    if (finding.suggestedFix) {
      body += `**Suggested fix:**\n\`\`\`\n${finding.suggestedFix}\n\`\`\`\n\n`
    }

    body += `---\n\n`
  }

  return body
}

export async function createIssuesFromFindings(
  owner: string,
  repo: string,
  results: ModelReviewResult[],
): Promise<number> {
  const octokit = new Octokit({ auth: getGithubToken() })

  const allFindings: { model: string; finding: ReviewFinding }[] = []
  for (const r of results) {
    if (r.status === 'failed') continue
    for (const f of r.findings) {
      allFindings.push({ model: r.model, finding: f })
    }
  }

  if (allFindings.length === 0) {
    console.log('\n✅ No issues to create — all models found no problems.')
    return 0
  }

  const byFile = new Map<string, { model: string; finding: ReviewFinding }[]>()
  for (const f of allFindings) {
    const key = f.finding.file || '(repo level)'
    if (!byFile.has(key)) byFile.set(key, [])
    byFile.get(key)!.push(f)
  }

  let created = 0

  for (const [file, findings] of byFile) {
    const maxSeverity = findings.some(f => f.finding.severity === 'blocking') ? 'blocking'
      : findings.some(f => f.finding.severity === 'warning') ? 'warning'
      : 'suggestion'

    const title = `[AI Review] ${SEVERITY_EMOJI[maxSeverity]} ${file} — ${findings.length} finding(s)`

    const labels: string[] = [`ai-review`, `severity:${SEVERITY_LABEL[maxSeverity] ?? 'unknown'}`]

    try {
      for (const label of labels) {
        await octokit.issues.createLabel({
          owner, repo, name: label, color: 'ededed',
        }).catch(() => {})
      }

      const { data: issue } = await octokit.issues.create({
        owner,
        repo,
        title,
        body: buildIssueBody(file, findings),
        labels,
      })

      console.log(`  📋 #${issue.number} — ${title}`)
      created++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`  ❌ Failed to create issue for ${file}: ${message}`)
    }
  }

  return created
}
