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

interface GroupedFinding {
  pattern: string
  severity: string
  category: string
  locations: { file: string; line: number | null; model: string; body: string; suggestedFix?: string }[]
}

function normalizeTitle(title: string): string {
  return title
    .replace(/`[^`]+`/g, '*')
    .replace(/\b[A-Z][a-zA-Z]+(?:\.[a-zA-Z]+)+/g, '*')
    .replace(/\b(line|row|col)\s*\d+/gi, '')
    .trim()
    .toLowerCase()
}

function groupSimilarFindings(
  allFindings: { model: string; finding: ReviewFinding }[],
): GroupedFinding[] {
  const groups = new Map<string, GroupedFinding>()

  for (const { model, finding } of allFindings) {
    const key = `${finding.severity}:${finding.category}:${normalizeTitle(finding.title)}`

    if (!groups.has(key)) {
      groups.set(key, {
        pattern: finding.title,
        severity: finding.severity,
        category: finding.category,
        locations: [],
      })
    }

    groups.get(key)!.locations.push({
      file: finding.file,
      line: finding.line,
      model,
      body: finding.body,
      suggestedFix: finding.suggestedFix,
    })
  }

  return [...groups.values()].sort((a, b) => {
    const order: Record<string, number> = { blocking: 0, warning: 1, suggestion: 2 }
    return (order[a.severity] ?? 3) - (order[b.severity] ?? 3)
  })
}

function buildGroupedIssueBody(group: GroupedFinding): string {
  const emoji = SEVERITY_EMOJI[group.severity] ?? '⚪'
  let body = `## ${emoji} ${group.pattern}\n\n`
  body += `**Severity:** ${group.severity} · **Category:** ${group.category} · **Occurrences:** ${group.locations.length}\n\n`

  body += `| File | Line | Model |\n|---|---|---|\n`
  for (const loc of group.locations) {
    const line = loc.line ?? '—'
    body += `| \`${loc.file}\` | ${line} | \`${loc.model}\` |\n`
  }
  body += `\n`

  const unique = new Map<string, string>()
  for (const loc of group.locations) {
    if (!unique.has(loc.body)) unique.set(loc.body, loc.model)
  }
  if (unique.size === 1) {
    body += `### Detail\n${[...unique.keys()][0]}\n\n`
  } else {
    body += `### Details\n`
    for (const [detail, model] of unique) {
      body += `- **\`${model}\`:** ${detail}\n`
    }
    body += `\n`
  }

  const fix = group.locations.find(l => l.suggestedFix)
  if (fix) {
    body += `### Suggested fix\n\`\`\`\n${fix.suggestedFix}\n\`\`\`\n\n`
  }

  body += `---\n*Found by AI code review*`
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

  const groups = groupSimilarFindings(allFindings)
  console.log(`  📊 ${allFindings.length} findings consolidated into ${groups.length} issue(s)`)

  let created = 0

  for (const group of groups) {
    const emoji = SEVERITY_EMOJI[group.severity] ?? '⚪'
    const fileCount = new Set(group.locations.map(l => l.file)).size
    const suffix = group.locations.length > 1
      ? ` (${group.locations.length}× across ${fileCount} file${fileCount > 1 ? 's' : ''})`
      : ''

    const title = `[AI Review] ${emoji} ${group.pattern}${suffix}`
    const labels: string[] = [`ai-review`, `severity:${SEVERITY_LABEL[group.severity] ?? 'unknown'}`]

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
        body: buildGroupedIssueBody(group),
        labels,
      })

      console.log(`  📋 #${issue.number} — ${title}`)
      created++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`  ❌ Failed to create issue: ${message}`)
    }
  }

  return created
}
