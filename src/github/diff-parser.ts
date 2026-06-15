import type { DiffPositionMap, DiffChunk } from '../types.js'

/**
 * Parses unified diff text into per-file chunks and a position map.
 * GitHub inline comments need "position" = line offset within the diff,
 * not the actual file line number.
 */
export function parseDiff(diffText: string): {
  chunks: DiffChunk[]
  positionMap: DiffPositionMap
} {
  const chunks: DiffChunk[] = []
  const positionMap: DiffPositionMap = new Map()

  const fileBlocks = diffText.split(/^diff --git /m).filter(Boolean)

  for (const block of fileBlocks) {
    const lines = block.split('\n')
    const firstLine = lines[0] ?? ''

    // Extract filename from "a/path/to/file b/path/to/file"
    const fileMatch = firstLine.match(/^a\/.+ b\/(.+)$/)
    const filename = fileMatch?.[1] ?? firstLine.trim()

    if (!filename) continue

    // Build position map for this file
    const filePositionMap = new Map<number, number>()
    let diffPosition = 0
    let currentLine = 0

    const hunkLines: string[] = []
    let startLine = 1

    for (const line of lines) {
      // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (hunkMatch) {
        currentLine = parseInt(hunkMatch[1] ?? '1', 10) - 1
        startLine = currentLine + 1
        diffPosition++
        hunkLines.push(line)
        continue
      }

      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentLine++
        filePositionMap.set(currentLine, diffPosition)
        diffPosition++
        hunkLines.push(line)
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        diffPosition++
        hunkLines.push(line)
      } else if (line.startsWith(' ')) {
        currentLine++
        diffPosition++
        hunkLines.push(line)
      }
    }

    if (hunkLines.length > 0) {
      chunks.push({
        filename,
        content: hunkLines.join('\n'),
        startLine,
      })
    }

    if (filePositionMap.size > 0) {
      positionMap.set(filename, filePositionMap)
    }
  }

  return { chunks, positionMap }
}

/**
 * Splits large chunks into smaller ones to fit model context windows.
 */
export function splitChunks(chunks: DiffChunk[], maxChars: number): DiffChunk[] {
  const result: DiffChunk[] = []

  for (const chunk of chunks) {
    if (chunk.content.length <= maxChars) {
      result.push(chunk)
      continue
    }

    const lines = chunk.content.split('\n')
    let current: string[] = []
    let charCount = 0
    let partStart = chunk.startLine
    let currentLine = chunk.startLine

    for (const line of lines) {
      if (charCount + line.length > maxChars && current.length > 0) {
        result.push({ filename: chunk.filename, content: current.join('\n'), startLine: partStart })
        current = []
        charCount = 0
        partStart = currentLine
      }
      if (line.startsWith('+') || line.startsWith(' ')) {
        currentLine++
      }
      current.push(line)
      charCount += line.length
    }

    if (current.length > 0) {
      result.push({ filename: chunk.filename, content: current.join('\n'), startLine: partStart })
    }
  }

  return result
}

/**
 * Returns the diff position for a given filename + line number.
 * Falls back to null if the line isn't in the diff (can't post inline).
 */
export function getDiffPosition(
  positionMap: DiffPositionMap,
  filename: string,
  line: number
): number | null {
  return positionMap.get(filename)?.get(line) ?? null
}
