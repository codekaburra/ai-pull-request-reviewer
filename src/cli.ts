import { fetchPR } from './github/fetcher.js'
import { postFileReview, postModelSummary, postCrossReviewComment, postCompletionComment } from './github/commenter.js'
import { parseDiff } from './github/diff-parser.js'
import { getLocalDiff } from './source/local-diff.js'
import { fetchRepoFiles } from './source/repo-scan.js'
import { printConsoleReport, printCrossReviewReport, printAggregatedReport } from './report/console.js'
import { checkAvailableModels, reviewFile } from './llm/client.js'
import { runModelReview } from './reviewer.js'
import type { OnChunkReviewed } from './reviewer.js'
import { runCrossReview } from './crossReview.js'
import { aggregate } from './aggregator.js'
import { createIssuesFromFindings } from './github/issues.js'
import { config } from './config.js'
import type { PRInfo, ModelReviewResult, ReviewFinding, CrossReviewResult } from './types.js'

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

  Repo scan (review entire repo & create GitHub issues):
    npm run review -- --scan owner/repo --branch main
    npm run review -- --scan https://github.com/owner/repo --branch feat/xyz

Examples:
  npm run review -- --local
  npm run review -- --local main
  npm run review -- https://github.com/facebook/react/pull/1234
  npm run review -- facebook/react#1234
  npm run review -- --scan myorg/myrepo --branch main
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

function parseScanTarget(target: string): { owner: string; repo: string } | null {
  const urlMatch = target.match(/github\.com\/([^/]+)\/([^/\s]+)/)
  if (urlMatch) {
    return { owner: urlMatch[1]!, repo: urlMatch[2]!.replace(/\.git$/, '') }
  }

  const slashMatch = target.match(/^([^/]+)\/([^/\s]+)$/)
  if (slashMatch) {
    return { owner: slashMatch[1]!, repo: slashMatch[2]!.replace(/\.git$/, '') }
  }

  return null
}

async function runRepoScan(
  models: { name: string }[],
  files: { path: string; content: string }[],
  owner: string,
  repo: string,
): Promise<ModelReviewResult[]> {
  const results: ModelReviewResult[] = []

  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi]!.name
    console.log(`\n${'─'.repeat(50)}`)
    console.log(`🤖 [${mi + 1}/${models.length}] ${model} scanning repo...`)
    console.log(`${'─'.repeat(50)}`)

    const startTime = Date.now()
    const allFindings: ReviewFinding[] = []
    let filesCompleted = 0
    let lastError: string | undefined

    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi]!
      console.log(`  📄 [${fi + 1}/${files.length}] ${file.path}...`)

      try {
        const findings = await reviewFile(model, file.path, file.content, config.review.timeoutMs)
        if (findings.length > 0) {
          console.log(`     → ${findings.length} finding(s)`)
        }
        allFindings.push(...findings)
        filesCompleted++
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const isTimeout = err instanceof DOMException && err.name === 'TimeoutError'
        const label = isTimeout
          ? `timed out after ${(config.review.timeoutMs / 1000).toFixed(0)}s`
          : `failed: ${message}`
        console.error(`  ❌ ${model} ${label} on ${file.path}`)
        lastError = label
        break
      }
    }

    const durationMs = Date.now() - startTime
    const status = filesCompleted === files.length
      ? 'completed'
      : filesCompleted > 0
        ? 'partial'
        : 'failed'

    const statusIcon = status === 'completed' ? '📊' : status === 'partial' ? '⚠️' : '❌'
    console.log(`\n  ${statusIcon} ${model}: ${status} (${filesCompleted}/${files.length} files, ${allFindings.length} finding(s))`)
    console.log(`  ⏱️  Took ${(durationMs / 1000).toFixed(1)}s`)

    results.push({
      model,
      findings: allFindings,
      durationMs,
      status,
      error: lastError,
      chunksTotal: files.length,
      chunksCompleted: filesCompleted,
    })
  }

  return results
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

    let crossResults: CrossReviewResult[] = []
    if (activeModels.length > 1) {
      crossResults = await runCrossReview(
        activeModels.map(m => m.name),
        results,
        pr.diffContent,
      )
      printCrossReviewReport(results, crossResults)
    }

    const report = aggregate(results, crossResults)
    printAggregatedReport(report)

    process.exit(0)
  }

  // ── Repo scan mode ──────────────────────────────────────────────
  if (args.includes('--scan')) {
    const scanIdx = args.indexOf('--scan')
    const scanTarget = args[scanIdx + 1]
    if (!scanTarget) {
      console.error('❌ --scan requires a repo (owner/repo or GitHub URL).')
      printUsage()
      process.exit(1)
    }

    const branchIdx = args.indexOf('--branch')
    const branch = branchIdx !== -1 ? args[branchIdx + 1] : undefined
    if (!branch) {
      console.error('❌ --scan requires --branch <branch-name>.')
      printUsage()
      process.exit(1)
    }

    const scanParsed = parseScanTarget(scanTarget)
    if (!scanParsed) {
      console.error('❌ Invalid scan target. Use owner/repo or a GitHub URL.')
      printUsage()
      process.exit(1)
    }

    const { owner, repo } = scanParsed
    console.log(`📌 Scanning: ${owner}/${repo} @ ${branch}`)

    const files = await fetchRepoFiles(owner, repo, branch)
    if (files.length === 0) {
      console.log('\n✅ No reviewable files found.')
      process.exit(0)
    }

    const results = await runRepoScan(activeModels, files, owner, repo)
    printConsoleReport(results)

    let crossResults: CrossReviewResult[] = []
    if (activeModels.length > 1) {
      const allDiff = files.map(f => `--- a/${f.path}\n+++ b/${f.path}\n${f.content}`).join('\n\n')
      crossResults = await runCrossReview(
        activeModels.map(m => m.name),
        results,
        allDiff,
      )
      printCrossReviewReport(results, crossResults)
    }

    const report = aggregate(results, crossResults)
    printAggregatedReport(report)

    console.log('\n📋 Creating GitHub issues...')
    const created = await createIssuesFromFindings(owner, repo, results)
    console.log(`\n✅ Scan complete — ${created} issue(s) created on ${owner}/${repo}`)

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

  let crossResults: CrossReviewResult[] = []
  if (activeModels.length > 1) {
    crossResults = await runCrossReview(
      activeModels.map(m => m.name),
      results,
      pr.diffContent,
    )
    await postCrossReviewComment(owner, repo, prNumber, results, crossResults)
  }

  const report = aggregate(results, crossResults)
  await postCompletionComment(owner, repo, prNumber, results, report)

  console.log(`\n${'═'.repeat(50)}`)
  console.log(`✅ Code review complete!`)
  console.log(`📌 ${owner}/${repo}#${prNumber}`)
  console.log(`${'═'.repeat(50)}\n`)
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
