import { execFileSync } from 'child_process'
import { shouldSkipFile } from '../github/fetcher.js'
import type { PRInfo, PRFile } from '../types.js'

function git(args: string[]): string {
  return execFileSync('git', args, {
    stdio: 'pipe',
    maxBuffer: 64 * 1024 * 1024,
  }).toString()
}

// git status letter -> our PRFile status
function mapStatus(letter: string): PRFile['status'] {
  switch (letter[0]) {
    case 'A': return 'added'
    case 'D': return 'removed'
    case 'R': return 'renamed'
    default:  return 'modified'
  }
}

/**
 * Builds a PRInfo from the local working tree using `git diff`.
 *
 * - No `base`  → uncommitted changes vs HEAD (what you're about to commit).
 * - With `base` → branch range `<base>...HEAD` (everything on this branch since base).
 */
export function getLocalDiff(base?: string): PRInfo {
  // The range argument shared by every git command below.
  const range = base ? [`${base}...HEAD`] : ['HEAD']

  let branch = 'working tree'
  try {
    branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim() || branch
  } catch {
    // not a git repo / detached — fall back to the default label
  }

  console.log(`\n📡 Reading local diff (${base ? `${base}...HEAD` : 'uncommitted vs HEAD'})...`)

  // --numstat: "<added>\t<deleted>\t<path>" per file
  const numstat = git(['diff', '--numstat', ...range]).trim()
  // --name-status: "<status>\t<path>" per file
  const nameStatus = git(['diff', '--name-status', ...range]).trim()

  const statusByFile = new Map<string, string>()
  if (nameStatus) {
    for (const line of nameStatus.split('\n')) {
      const [letter, ...rest] = line.split('\t')
      const filename = rest[rest.length - 1] // renames give "old\tnew" — take the new path
      if (filename) statusByFile.set(filename, letter ?? 'M')
    }
  }

  const files: PRFile[] = []
  if (numstat) {
    for (const line of numstat.split('\n')) {
      const parts = line.split('\t')
      if (parts.length < 3) continue
      const [add, del, ...pathParts] = parts
      const filename = pathParts[pathParts.length - 1]!
      if (shouldSkipFile(filename)) continue
      files.push({
        filename,
        status: mapStatus(statusByFile.get(filename) ?? 'M'),
        additions: add === '-' ? 0 : parseInt(add ?? '0', 10), // '-' = binary file
        deletions: del === '-' ? 0 : parseInt(del ?? '0', 10),
      })
    }
  }

  // Pull the actual diff text, scoped to the non-skipped files so the LLM never sees lockfiles etc.
  let diffContent = ''
  if (files.length > 0) {
    diffContent = git(['diff', ...range, '--', ...files.map(f => f.filename)])
  }

  console.log(`📋 Branch: "${branch}"`)
  console.log(`📁 ${files.length} file(s) to review`)

  return {
    owner: 'local',
    repo: branch,
    number: 0,
    title: `Local changes on ${branch}`,
    description: '',
    files,
    diffContent,
  }
}
