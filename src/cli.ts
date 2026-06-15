import { fetchPR } from './github/fetcher.js'
import { postFileReview, postModelSummary, postCompletionComment } from './github/commenter.js'
import { parseDiff } from './github/diff-parser.js'
import { getLocalDiff } from './source/local-diff.js'
import { printConsoleReport } from './report/console.js'
import { checkAvailableModels } from './llm/client.js'
import { runModelReview } from './reviewer.js'
import type { OnChunkReviewed } from './reviewer.js'
import { config } from './config.js'
import type { PRInfo, ModelReviewResult } from './types.js'

function printUsage(): void {
  console.log(`
Usage:
  Local diff (default: uncommitted changes vs HEAD):
    npm run review -- --local
    npm run review -- --local <base-branch>     # e.g. --local main → main...HEAD

  GitHub PR:
    npm run review -- https://github.com/owner/repo/pull/123
    npm run review -- owner/repo#123
    npm run review -- owner/repo 123

Examples:
  npm run review -- --local
  npm run review -- --local main
  npm run review -- https://github.com/facebook/react/pull/1234
  npm run review -- facebook/react#1234
`)
}

function parsePrArgs(args: string[]): { owner: string; repo: string; prNumber: number } | null {
  const combined = args.join(' ').trim()

  // Full GitHub URL: https://github.com/owner/repo/pull/123
  const urlMatch = combined.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (urlMatch) {
    return { owner: urlMatch[1]!, repo: urlMatch[2]!, prNumber: parseInt(urlMatch[3]!, 10) }
  }

  // owner/repo#123
  const withHash = combined.match(/^([^/]+)\/([^#\s]+)#(\d+)$/)
  if (withHash) {
    return { owner: withHash[1]!, repo: withHash[2]!, prNumber: parseInt(withHash[3]!, 10) }
  }

  // owner/repo 123
  const separate = combined.match(/^([^/]+)\/(\S+)\s+(\d+)$/)
  if (separate) {
    return { owner: separate[1]!, repo: separate[2]!, prNumber: parseInt(separate[3]!, 10) }
  }

  return null
}

async function runAllModels(
  models: { name: string }[],
  pr: PRInfo,
  onChunkReviewed?: OnChunkReviewed,
): Promise<ModelReviewResult[]> {
  const results: ModelReviewResult[] = []
  for (let i = 0; i < models.length; i++) {
    results.push(await runModelReview(models[i]!.name, pr, i, models.length, onChunkReviewed))
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

  // ── Check which models are available in Ollama ───────────────────
  const { available, missing } = await checkAvailableModels(config.models.map(m => m.name))

  if (missing.length > 0) {
    console.log(`⚠️  Skipping models not found in Ollama: ${missing.join(', ')}`)
    console.log(`   Pull them with: ${missing.map(m => `ollama pull ${m}`).join(' && ')}`)
  }

  if (available.length === 0) {
    console.error('❌ No configured models are available in Ollama.')
    console.error(`   Pull at least one: ${config.models.map(m => `ollama pull ${m.name}`).join(' && ')}`)
    process.exit(1)
  }

  const activeModels = config.models.filter(m => available.includes(m.name))
  console.log(`🤖 Models: ${activeModels.map(m => m.name).join(' → ')}`)

  // ── Local diff mode ──────────────────────────────────────────────
  if (args.includes('--local')) {
    const localIdx = args.indexOf('--local')
    const base = args[localIdx + 1] // optional base branch; undefined → uncommitted vs HEAD

    const pr = getLocalDiff(base)
    if (pr.files.length === 0) {
      console.log('\n✅ No reviewable changes found.')
      process.exit(0)
    }

    const results = await runAllModels(activeModels, pr)
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

  const { positionMap } = parseDiff(pr.diffContent)

  const onChunkReviewed: OnChunkReviewed = async (model, chunk, findings, chunkIndex, totalChunks) => {
    await postFileReview(owner, repo, prNumber, model, findings, chunk.filename, chunkIndex, totalChunks, positionMap)
  }

  const results = await runAllModels(activeModels, pr, onChunkReviewed)

  for (const result of results) {
    await postModelSummary(owner, repo, prNumber, result)
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
