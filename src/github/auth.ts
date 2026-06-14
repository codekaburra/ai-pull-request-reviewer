import { execFileSync } from 'child_process'

let cached: string | null = null

export function getGithubToken(): string {
  if (cached) return cached

  try {
    const token = execFileSync('gh', ['auth', 'token'], { stdio: 'pipe' })
      .toString()
      .trim()
    if (token) {
      console.log('🔑 Using token from gh CLI')
      cached = token
      return token
    }
  } catch {
    // gh not installed or not authenticated
  }

  const envToken = process.env['GITHUB_TOKEN']
  if (envToken) {
    console.log('🔑 Using GITHUB_TOKEN from environment')
    cached = envToken
    return envToken
  }

  throw new Error(
    '\n❌ No GitHub token found.\n' +
    'Fix with one of:\n' +
    '  Option 1: gh auth login\n' +
    '  Option 2: set GITHUB_TOKEN=your_token in .env\n'
  )
}
