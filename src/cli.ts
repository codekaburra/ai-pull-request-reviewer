import { fetchPR } from './github/fetcher.js'
import { postModelReview, postCompletionComment } from './github/commenter.js'
import { parseDiff } from './github/diff-parser.js'
import { getLocalDiff } from './source/local-diff.js'
import { printConsoleReport } from './report/console.js'
import { runModelReview } from './reviewer.js'
import { config } from './config.js'
import type { PRInfo, ModelReviewResult } from './types.js'

function printUsage(): void {
  console.log(`
Usage:
  Local diff (default: uncommitted changes vs HEAD):
    npm run review -- --local
    npm run review -- --local <base-branch>     # e.g. --local main → main...HEAD

  GitHub PR:
    npm run review <owner/repo> <pr-number>
    npm run review <owner/repo#pr-number>

Examples:
  npm run review -- --local
  npm run review -- --local main
  npm run review facebook/react 1234
  npm run review facebook/react#1234
`)
}

function parsePrArgs(args: string[]): { owner: string; repo: string; prNumber: number } | null {
  const combined = args.join(' ').trim()

  const withHash = combined.match(/^([^/]+)\/([^#\s]+)#(\d+)$/)
  if (withHash) {
    return { owner: withHash[1]!, repo: withHash[2]!, prNumber: parseInt(withHash[3]!, 10) }
  }

  const separate = combined.match(/^([^/]+)\/(\S+)\s+(\d+)$/)
  if (separate) {
    return { owner: separate[1]!, repo: separate[2]!, prNumber: parseInt(separate[3]!, 10) }
  }

  return null
}

/** Each model reviews the whole diff, one at a time. */
async function runAllModels(pr: PRInfo): Promise<ModelReviewResult[]> {
  const results: ModelReviewResult[] = []
  for (let i = 0; i < config.models.length; i++) {
    const modelConfig = config.models[i]!
    results.push(await runModelReview(modelConfig.name, pr, i, config.models.length))
  }
  return results
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage()
    process.exit(0)
  }

  console.log(`\n🚀 AI Code Reviewer`)
  console.log(`🤖 Models: ${config.models.map(m => m.name).join(' → ')}`)

  // ── Local diff mode ──────────────────────────────────────────────
  if (args.includes('--local')) {
    const localIdx = args.indexOf('--local')
    const base = args[localIdx + 1] // optional base branch; undefined → uncommitted vs HEAD

    const pr = getLocalDiff(base)
    if (pr.files.length === 0) {
      console.log('\n✅ No reviewable changes found.')
      process.exit(0)
    }

    const results = await runAllModels(pr)
    printConsoleReport(results)
    process.exit(0)
  }

  // ── GitHub PR mode ───────────────────────────────────────────────
  const parsed = parsePrArgs(args)
  if (!parsed) {
    console.error('❌ Invalid arguments.')
    printUsage()
    process.exit(1)
  }

  const { owner, repo, prNumber } = parsed
  console.log(`📌 Target: ${owner}/${repo}#${prNumber}`)

  const pr = await fetchPR(owner, repo, prNumber)
  if (pr.files.length === 0) {
    console.log('\n✅ No reviewable files in this PR (all skipped).')
    process.exit(0)
  }

  const results = await runAllModels(pr)

  // Post each model's review block, then the completion summary.
  const { positionMap } = parseDiff(pr.diffContent)
  for (const result of results) {
    await postModelReview(owner, repo, prNumber, result, positionMap)
  }
  await postCompletionComment(owner, repo, prNumber, results)

  console.log(`\n${'═'.repeat(50)}`)
  console.log(`✅ Code review complete!`)
  console.log(`📌 ${owner}/${repo}#${prNumber}`)
  console.log(`${'═'.repeat(50)}\n`)
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
