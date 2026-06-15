import * as dotenv from 'dotenv'
import * as path from 'path'

dotenv.config({ path: path.resolve(process.cwd(), '.env') })

export interface ModelConfig {
  name: string
  displayName: string
}

export interface Config {
  ollama: {
    baseUrl: string
    keepAlive: number    // seconds to keep model in memory (0 = unload immediately)
  }
  models: ModelConfig[]
  review: {
    maxTokensPerChunk: number
    skipPaths: string[]
  }
}

export const config: Config = {
  ollama: {
    baseUrl: process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
    keepAlive: 0,          // unload model from memory right after response
  },
  models: [
    { name: 'phi4:latest',         displayName: 'phi4' },
    { name: 'starcoder2:7b',       displayName: 'starcoder2:7b' },
    { name: 'mistral:latest',      displayName: 'mistral' },
  ],
  review: {
    maxTokensPerChunk: 6000,
    skipPaths: [
      '*.lock',
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'dist/**',
      'build/**',
      '*.min.js',
      '*.min.css',
      '*.generated.*',
      '*.pb.go',
      '*.pb.ts',
    ],
  },
}
