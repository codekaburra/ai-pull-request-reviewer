/**
 * Phase 1 smoke test — no git, no Ollama required.
 *
 * Exercises the local-review pipeline below the LLM call:
 *   raw diff → parseDiff → splitChunks → printConsoleReport
 *
 * Run with: npm test
 */
import * as fs from 'fs'
import * as path from 'path'
import { parseDiff, splitChunks, getDiffPosition } from '../src/github/diff-parser.js'
import { printConsoleReport, printCrossReviewReport, printAggregatedReport } from '../src/report/console.js'
import { aggregate } from '../src/aggregator.js'
import type { ModelReviewResult, CrossReviewResult } from '../src/types.js'

let failures = 0
function check(name: string, cond: boolean): void {
  console.log(`  ${cond ? '✅' : '❌'} ${name}`)
  if (!cond) failures++
}

const diff = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.diff'), 'utf8')

console.log('\n── parseDiff ──')
const { chunks, positionMap } = parseDiff(diff)
check('parses both files into chunks', chunks.length === 2)
check('first chunk is src/math.js', chunks[0]?.filename === 'src/math.js')
check('second chunk is src/util.js', chunks[1]?.filename === 'src/util.js')
check('math.js content includes the added div()', !!chunks[0]?.content.includes('function div'))

console.log('\n── positionMap (for inline comments) ──')
check('has a position map for src/math.js', positionMap.has('src/math.js'))
// the added `return a - b` is the first changed `+` line in the new file (line 2)
check('maps a changed line to a diff position', getDiffPosition(positionMap, 'src/math.js', 2) !== null)

console.log('\n── splitChunks ──')
const big = splitChunks(chunks, 100_000)
check('large limit keeps chunks intact', big.length === 2)
const small = splitChunks(chunks, 40) // force splitting
check('small limit splits oversized chunks', small.length > chunks.length)

console.log('\n── printConsoleReport (render sample findings) ──')
const fakeResults: ModelReviewResult[] = [
  {
    model: 'phi4',
    durationMs: 1200,
    status: 'completed',
    chunksTotal: 2,
    chunksCompleted: 2,
    findings: [
      {
        file: 'src/math.js', line: 2, severity: 'blocking', category: 'logic',
        title: 'add() subtracts instead of adding',
        body: 'The body returns `a - b`, contradicting the function name and contract.',
        suggestedFix: '  return a + b',
      },
      {
        file: 'src/math.js', line: 6, severity: 'warning', category: 'logic',
        title: 'div() has no divide-by-zero guard',
        body: 'Calling div(x, 0) yields Infinity/NaN with no error.',
      },
    ],
  },
  {
    model: 'mistral:7b',
    durationMs: 1500,
    status: 'completed',
    chunksTotal: 2,
    chunksCompleted: 2,
    findings: [],
  },
  {
    model: 'starcoder2:7b',
    durationMs: 300000,
    status: 'failed',
    error: 'timed out after 300s',
    chunksTotal: 2,
    chunksCompleted: 0,
    findings: [],
  },
]

let rendered = true
try {
  printConsoleReport(fakeResults)
} catch (err) {
  rendered = false
  console.error(err)
}
check('printConsoleReport renders without throwing', rendered)

console.log('\n── printCrossReviewReport ──')
const fakeCrossResults: CrossReviewResult[] = [
  {
    reviewerModel: 'mistral:7b',
    durationMs: 800,
    status: 'completed',
    verdicts: [
      {
        findingIndex: 0,
        originalModel: 'phi4',
        verdict: 'agree',
        rationale: 'The function name says add but the body returns a - b.',
      },
      {
        findingIndex: 1,
        originalModel: 'phi4',
        verdict: 'refine',
        rationale: 'Valid concern but should be blocking, not warning.',
        refinedSeverity: 'blocking',
      },
    ],
  },
  {
    reviewerModel: 'starcoder2:7b',
    durationMs: 300000,
    status: 'failed',
    error: 'timed out after 300s',
    verdicts: [],
  },
]

let crossRendered = true
try {
  printCrossReviewReport(fakeResults, fakeCrossResults)
} catch (err) {
  crossRendered = false
  console.error(err)
}
check('printCrossReviewReport renders without throwing', crossRendered)

console.log('\n── aggregate ──')

// Add a duplicate finding from mistral that should merge with phi4's
const resultsWithOverlap: ModelReviewResult[] = [
  {
    ...fakeResults[0]!,
  },
  {
    model: 'mistral:7b',
    durationMs: 1500,
    status: 'completed',
    chunksTotal: 2,
    chunksCompleted: 2,
    findings: [
      {
        file: 'src/math.js', line: 3, severity: 'blocking', category: 'logic',
        title: 'add() subtracts instead of adding',
        body: 'Function add uses subtraction operator.',
      },
    ],
  },
  fakeResults[2]!,
]

const report = aggregate(resultsWithOverlap, fakeCrossResults)
check('deduplicates similar findings', report.stats.deduplicated < report.stats.totalRaw)
check('merged finding has multiple reporters', report.findings.some(f => f.reportedBy.length > 1))
check('tracks agreement from cross-review', report.findings.some(f => f.agreedBy.length > 0))
check('calculates confidence scores', report.findings.every(f => f.score >= 0 && f.score <= 1))
check('sorts high confidence first', report.findings[0]!.confidence === 'high' || report.findings.length <= 1)

let aggRendered = true
try {
  printAggregatedReport(report)
} catch (err) {
  aggRendered = false
  console.error(err)
}
check('printAggregatedReport renders without throwing', aggRendered)

console.log(`\n${failures === 0 ? '✅ all checks passed' : `❌ ${failures} check(s) failed`}\n`)
process.exit(failures === 0 ? 0 : 1)
