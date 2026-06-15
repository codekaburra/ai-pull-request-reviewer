import { reviewChunk } from './llm/client.js'
import { parseDiff, splitChunks } from './github/diff-parser.js'
import type { PRInfo, ModelReviewResult, ReviewFinding, DiffChunk } from './types.js'
import { config } from './config.js'

const CHARS_PER_TOKEN = 4

export type OnChunkReviewed = (
  model: string,
  chunk: DiffChunk,
  findings: ReviewFinding[],
  chunkIndex: number,
  totalChunks: number,
) => Promise<void>

export async function runModelReview(
  model: string,
  pr: PRInfo,
  modelIndex: number,
  totalModels: number,
  onChunkReviewed?: OnChunkReviewed,
): Promise<ModelReviewResult> {
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`🤖 [${modelIndex + 1}/${totalModels}] ${model} is reviewing...`)
  console.log(`${'─'.repeat(50)}`)

  const startTime = Date.now()
  const allFindings: ReviewFinding[] = []

  const { chunks } = parseDiff(pr.diffContent)

  const maxChars = config.review.maxTokensPerChunk * CHARS_PER_TOKEN
  const splitChunkList = splitChunks(chunks, maxChars)

  if (splitChunkList.length === 0) {
    console.log('  ℹ️  No diff content to review.')
  }

  for (let i = 0; i < splitChunkList.length; i++) {
    const chunk = splitChunkList[i]!
    console.log(`  📄 [${i + 1}/${splitChunkList.length}] ${chunk.filename}...`)

    const findings = await reviewChunk(model, chunk, pr.title, pr.description)

    if (findings.length > 0) {
      console.log(`     → ${findings.length} finding(s)`)
    }

    allFindings.push(...findings)

    if (onChunkReviewed) {
      await onChunkReviewed(model, chunk, findings, i, splitChunkList.length)
    }
  }

  const durationMs = Date.now() - startTime

  console.log(`\n  📊 ${model} found ${allFindings.length} total finding(s)`)
  console.log(`  ⏱️  Took ${(durationMs / 1000).toFixed(1)}s`)

  return { model, findings: allFindings, durationMs }
}
