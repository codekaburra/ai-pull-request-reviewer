import { Octokit } from '@octokit/rest'
import { getGithubToken } from '../github/auth.js'
import { shouldSkipFile } from '../github/fetcher.js'

export interface RepoFile {
  path: string
  content: string
  size: number
}

const MAX_FILE_SIZE = 100_000

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.zip', '.tar', '.gz', '.br',
  '.pdf', '.doc', '.docx',
  '.mp3', '.mp4', '.wav', '.ogg',
  '.exe', '.dll', '.so', '.dylib',
  '.class', '.jar', '.pyc',
])

function isBinaryFile(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return false
  return BINARY_EXTENSIONS.has(path.slice(dot).toLowerCase())
}

export async function fetchRepoFiles(
  owner: string,
  repo: string,
  branch: string,
): Promise<RepoFile[]> {
  const octokit = new Octokit({ auth: getGithubToken() })

  console.log(`\n📡 Fetching file tree from ${owner}/${repo} @ ${branch}...`)

  const { data: tree } = await octokit.git.getTree({
    owner,
    repo,
    tree_sha: branch,
    recursive: 'true',
  })

  const candidates = tree.tree.filter(item =>
    item.type === 'blob' &&
    item.path &&
    item.size &&
    item.size <= MAX_FILE_SIZE &&
    !isBinaryFile(item.path) &&
    !shouldSkipFile(item.path),
  )

  console.log(`📁 ${candidates.length} file(s) to review (${tree.tree.length} total in tree)`)

  const files: RepoFile[] = []

  for (const item of candidates) {
    try {
      const { data } = await octokit.repos.getContent({
        owner,
        repo,
        path: item.path!,
        ref: branch,
      })

      if ('content' in data && data.encoding === 'base64') {
        const content = Buffer.from(data.content, 'base64').toString('utf8')
        files.push({ path: item.path!, content, size: item.size! })
      }
    } catch {
      console.warn(`  ⚠️  Could not fetch ${item.path}`)
    }
  }

  console.log(`📋 Fetched ${files.length} file(s)`)
  return files
}
