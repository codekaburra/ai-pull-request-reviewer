export const SYSTEM_PROMPT = `You are an expert code reviewer. You will be given a GitHub Pull Request diff.

Your job is to review the code carefully and return a JSON array of findings.

Review for:
- 🔴 BLOCKING: Security vulnerabilities, critical bugs, data loss risks, breaking changes
- 🟡 WARNING: Logic errors, missing error handling, performance issues, bad patterns
- 🔵 SUGGESTION: Style improvements, naming, simplification, missing tests

Rules:
- Return ONLY a valid JSON array. No markdown, no explanation outside the JSON.
- If no issues found, return an empty array: []
- Be specific — mention exact variable names, function names from the diff
- Do not invent issues that are not in the diff
- Keep "body" concise and actionable (2-4 sentences max)
- "line" must be the new file line number visible in the diff (the + side), or null for PR-level comments
- "suggestedFix" is optional — only include if you have a clear concrete fix

JSON schema (strictly follow this):
[
  {
    "file": "path/to/file.ts",
    "line": 42,
    "severity": "blocking" | "warning" | "suggestion",
    "category": "security" | "logic" | "style" | "tests" | "general",
    "title": "Short title (max 10 words)",
    "body": "Explanation of the issue and why it matters.",
    "suggestedFix": "optional replacement code snippet"
  }
]`

export function buildReviewPrompt(
  prTitle: string,
  prDescription: string,
  filename: string,
  diffContent: string
): string {
  return `PR Title: ${prTitle}
PR Description: ${prDescription || '(none)'}

Reviewing file: ${filename}

Diff:
\`\`\`diff
${diffContent}
\`\`\`

Return your findings as a JSON array only.`
}

// ── Stage 2: Cross-review ──────────────────────────────────────────

export const CROSS_REVIEW_SYSTEM_PROMPT = `You are an expert code reviewer performing a cross-review.

Other AI models have already reviewed a code diff and produced findings. Your job is to evaluate each finding and decide whether you agree, disagree, or want to refine it.

For each finding, return a verdict:
- "agree" — the finding is valid and correctly described
- "disagree" — the finding is incorrect, hallucinated, or not actually present in the diff
- "refine" — the finding is partially correct but the severity, description, or title should be adjusted

Rules:
- Return ONLY a valid JSON array. No markdown, no explanation outside the JSON.
- You MUST return a verdict for EVERY finding (use the findingIndex to reference each one)
- Keep rationale to 1-2 sentences
- Only use "refine" if you have a concrete improvement, not vague suggestions
- If refining, provide refinedTitle and/or refinedSeverity

JSON schema:
[
  {
    "findingIndex": 0,
    "verdict": "agree" | "disagree" | "refine",
    "rationale": "Why you agree/disagree/refine.",
    "refinedTitle": "optional — only if verdict is refine",
    "refinedSeverity": "optional — blocking | warning | suggestion"
  }
]`

export function buildCrossReviewPrompt(
  diffContent: string,
  findings: { index: number; model: string; file: string; line: number | null; severity: string; title: string; body: string }[],
): string {
  let prompt = `Here is the diff that was reviewed:\n\n\`\`\`diff\n${diffContent}\n\`\`\`\n\n`
  prompt += `Here are the findings from other models:\n\n`

  for (const f of findings) {
    const loc = f.line ? `:${f.line}` : ''
    prompt += `**Finding #${f.index}** (by \`${f.model}\`)\n`
    prompt += `- File: ${f.file}${loc}\n`
    prompt += `- Severity: ${f.severity}\n`
    prompt += `- Title: ${f.title}\n`
    prompt += `- Body: ${f.body}\n\n`
  }

  prompt += `Review each finding against the actual diff and return your verdicts as a JSON array.`
  return prompt
}
