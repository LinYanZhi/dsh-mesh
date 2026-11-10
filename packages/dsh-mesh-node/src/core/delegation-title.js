/**
 * Delegation conversation titles.
 *
 * A delegation must be identifiable in the DSH sidebar even when the peer's
 * model auto-titles the session from the prompt. We set the title ourselves as
 * a user-owned rename before the first prompt; DSH's session-title service pins
 * a user title (automatic revisions stop).
 *
 * Format: `[委托]<goal first line>` — e.g. `[委托]修复登录页`.
 */

const MAX_TITLE = 48
const MAX_SNIPPET = 36

/** Strip control characters DSH's title validation refuses. */
function clean(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Build the title for one delegation.
 * @param goal - full delegation goal (may be multi-line / markdown).
 * @param explicit - caller-supplied title; used verbatim (but normalized).
 * @returns a non-empty title at most ~48 characters.
 */
export function delegationTitle(goal, explicit) {
  const wanted = clean(explicit)
  if (wanted) return wanted.slice(0, MAX_TITLE)
  const firstLine = String(goal || '')
    .split(/\r?\n/u)
    .map((line) => clean(line))
    .find((line) => line.length > 0) || ''
  const stripped = firstLine
    .replace(/^[【\[]?\s*任务\s*[】\]]?\s*[:：]?\s*/u, '')
    .replace(/^[】\]]+/u, '')
    .replace(/[】\]]+$/u, '')
    .replace(/^[-*#>\s]+/u, '')
    .trim()
  const snippet = stripped.length > MAX_SNIPPET ? `${stripped.slice(0, MAX_SNIPPET)}…` : stripped
  return clean(`[委托]${snippet || '任务'}`).slice(0, MAX_TITLE)
}
