import { Octokit } from '@octokit/rest'
import { getGithubToken } from './auth.js'
import type { PRInfo, PRFile } from '../types.js'
import { config } from '../config.js'
import * as path from 'path'

export function shouldSkipFile(filename: string): boolean {
  return config.review.skipPaths.some(pattern => {
    // simple glob: support *.ext and dir/**
    if (pattern.includes('**')) {
      const dir = pattern.replace('/**', '')
      return filename.startsWith(dir + '/')
    }
    if (pattern.startsWith('*.')) {
      const ext = pattern.slice(1)
      return filename.endsWith(ext)
    }
    return filename === pattern || path.basename(filename) === pattern
  })
}

export async function fetchPR(owner: string, repo: string, prNumber: number): Promise<PRInfo> {
  const token = getGithubToken()
  const octokit = new Octokit({ auth: token })

  console.log(`\n📡 Fetching PR #${prNumber} from ${owner}/${repo}...`)

  // Fetch PR metadata
  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: prNumber })

  // Fetch all changed files (paginated)
  const filesData = await octokit.paginate(octokit.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  })

  const files: PRFile[] = filesData
    .filter(f => !shouldSkipFile(f.filename))
    .map(f => ({
      filename: f.filename,
      status: f.status as PRFile['status'],
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
    }))

  const skipped = filesData.length - files.length
  if (skipped > 0) {
    console.log(`⏭️  Skipped ${skipped} file(s) matching skip patterns`)
  }

  // Build combined diff from file patches
  const diffContent = files
    .filter(f => f.patch)
    .map(f => `diff --git a/${f.filename} b/${f.filename}\n${f.patch}`)
    .join('\n\n')

  console.log(`📋 PR: "${pr.title}"`)
  console.log(`📁 ${files.length} file(s) to review`)

  return {
    owner,
    repo,
    number: prNumber,
    title: pr.title,
    description: pr.body ?? '',
    files,
    diffContent,
  }
}
