export type Severity = 'blocking' | 'warning' | 'suggestion'
export type Category = 'security' | 'logic' | 'style' | 'tests' | 'general'

export interface ReviewFinding {
  file: string
  line: number | null       // null = PR-level comment, not file-specific
  severity: Severity
  category: Category
  title: string
  body: string
  suggestedFix?: string
}

export interface ModelReviewResult {
  model: string
  findings: ReviewFinding[]
  durationMs: number
}

export interface PRInfo {
  owner: string
  repo: string
  number: number
  title: string
  description: string
  files: PRFile[]
  diffContent: string
}

export interface PRFile {
  filename: string
  status: 'added' | 'modified' | 'removed' | 'renamed'
  additions: number
  deletions: number
  patch?: string            // unified diff for this file
}

export interface DiffChunk {
  filename: string
  content: string           // the diff hunk text
  startLine: number         // original file start line
}

// Maps filename -> (line number -> diff position)
// GitHub inline comments need position (offset in diff), not raw line number
export type DiffPositionMap = Map<string, Map<number, number>>
