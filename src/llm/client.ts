import OpenAI from 'openai'
import { config } from '../config.js'
import { SYSTEM_PROMPT, buildReviewPrompt, FILE_REVIEW_SYSTEM_PROMPT, buildFileReviewPrompt } from './prompts.js'
import type { ReviewFinding, DiffChunk } from '../types.js'

let cachedClient: OpenAI | null = null

function getClient(): OpenAI {
  if (!cachedClient) {
    cachedClient = new OpenAI({
      baseURL: `${config.ollama.baseUrl}/v1`,
      apiKey: 'ollama',
    })
  }
  return cachedClient
}

function parseFindings(raw: string, filename: string): ReviewFinding[] {
  // Strip markdown code fences if model wrapped the JSON
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()

  // Extract JSON array from the response (model may add extra text)
  const match = cleaned.match(/\[[\s\S]*\]/)
  if (!match) return []

  try {
    const parsed = JSON.parse(match[0]) as unknown[]
    if (!Array.isArray(parsed)) return []

    return parsed
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map(item => ({
        file: typeof item['file'] === 'string' ? item['file'] : filename,
        line: typeof item['line'] === 'number' ? item['line'] : null,
        severity: (['blocking', 'warning', 'suggestion'].includes(item['severity'] as string)
          ? item['severity'] as ReviewFinding['severity']
          : 'suggestion'),
        category: (['security', 'logic', 'style', 'tests', 'general'].includes(item['category'] as string)
          ? item['category'] as ReviewFinding['category']
          : 'general'),
        title: typeof item['title'] === 'string' ? item['title'] : 'Issue found',
        body: typeof item['body'] === 'string' ? item['body'] : '',
        suggestedFix: typeof item['suggestedFix'] === 'string' ? item['suggestedFix'] : undefined,
      }))
  } catch {
    console.warn(`  ⚠️  Could not parse JSON from model response for ${filename}`)
    return []
  }
}

export async function checkAvailableModels(models: string[]): Promise<{ available: string[]; missing: string[] }> {
  const resp = await fetch(`${config.ollama.baseUrl}/api/tags`)
  if (!resp.ok) {
    throw new Error(`Cannot reach Ollama at ${config.ollama.baseUrl} — is it running?`)
  }
  const data = await resp.json() as { models: { name: string }[] }
  const installed = new Set(data.models.map(m => m.name))

  const available: string[] = []
  const missing: string[] = []

  for (const model of models) {
    if (installed.has(model)) {
      available.push(model)
    } else {
      missing.push(model)
    }
  }

  return { available, missing }
}

export async function chatCompletion(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs: number,
): Promise<string> {
  const client = getClient()

  const response = await client.chat.completions.create(
    {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
      // @ts-expect-error — Ollama-specific extra param not in OpenAI types
      keep_alive: config.ollama.keepAlive,
    },
    { signal: AbortSignal.timeout(timeoutMs) },
  )

  return response.choices[0]?.message?.content ?? ''
}

export async function reviewFile(
  model: string,
  filename: string,
  content: string,
  timeoutMs: number,
): Promise<ReviewFinding[]> {
  const raw = await chatCompletion(
    model,
    FILE_REVIEW_SYSTEM_PROMPT,
    buildFileReviewPrompt(filename, content),
    timeoutMs,
  )
  return parseFindings(raw, filename)
}

export async function reviewChunk(
  model: string,
  chunk: DiffChunk,
  prTitle: string,
  prDescription: string,
  timeoutMs: number,
): Promise<ReviewFinding[]> {
  const client = getClient()

  const userPrompt = buildReviewPrompt(prTitle, prDescription, chunk.filename, chunk.content)

  const response = await client.chat.completions.create(
    {
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
      // @ts-expect-error — Ollama-specific extra param not in OpenAI types
      keep_alive: config.ollama.keepAlive,
    },
    { signal: AbortSignal.timeout(timeoutMs) },
  )

  const content = response.choices[0]?.message?.content ?? ''
  return parseFindings(content, chunk.filename)
}
