import type { ModelReviewResult, ReviewFinding } from '../types.js'

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

function printFinding(f: ReviewFinding): void {
  const emoji = SEVERITY_EMOJI[f.severity] ?? '⚪'
  const cat = CATEGORY_LABEL[f.category] ?? f.category
  const loc = f.line ? `:${f.line}` : ''
  console.log(`  ${emoji} [${cat}] ${f.file}${loc} — ${f.title}`)
  if (f.body) console.log(`     ${f.body.replace(/\n/g, '\n     ')}`)
  if (f.suggestedFix) {
    console.log(`     ↳ suggested fix:`)
    console.log(`       ${f.suggestedFix.replace(/\n/g, '\n       ')}`)
  }
}

/**
 * Prints each model's findings to the terminal, grouped by file, then a summary table.
 * Used for local-diff mode (no GitHub posting).
 */
export function printConsoleReport(results: ModelReviewResult[]): void {
  for (const r of results) {
    const statusIcon = r.status === 'completed' ? '🤖' : r.status === 'partial' ? '⚠️' : '❌'
    console.log(`\n${'─'.repeat(60)}`)
    console.log(`${statusIcon} ${r.model}`)
    console.log(`${'─'.repeat(60)}`)

    if (r.status === 'failed') {
      console.log(`  ❌ Review failed: ${r.error}`)
      continue
    }

    if (r.status === 'partial') {
      console.log(`  ⚠️  Partial review (${r.chunksCompleted}/${r.chunksTotal} chunks): ${r.error}`)
    }

    if (r.findings.length === 0) {
      console.log('  ✅ No issues found.')
      continue
    }

    const byFile = new Map<string, ReviewFinding[]>()
    for (const f of r.findings) {
      const key = f.file || '(PR level)'
      if (!byFile.has(key)) byFile.set(key, [])
      byFile.get(key)!.push(f)
    }
    for (const [, fileFindings] of byFile) {
      for (const f of fileFindings) printFinding(f)
    }
  }

  console.log(`\n${'═'.repeat(60)}`)
  console.log('📊 Summary')
  console.log(`${'═'.repeat(60)}`)
  for (const r of results) {
    const blocking   = r.findings.filter(f => f.severity === 'blocking').length
    const warning    = r.findings.filter(f => f.severity === 'warning').length
    const suggestion = r.findings.filter(f => f.severity === 'suggestion').length
    const status = r.status === 'completed' ? '' : r.status === 'partial' ? ' [PARTIAL]' : ' [FAILED]'
    console.log(
      `  ${r.model.padEnd(24)} ${blocking} blocking · ${warning} warning · ${suggestion} suggestion${status}`
    )
  }
  console.log('')
}
