/**
 * Delegation conversation titles.
 *
 * The delegating AI names its own task; dsh-mesh only adds the visual prefix
 * `[委托] ` so delegated conversations are easy to spot in the DSH sidebar.
 * The title is pinned as a user-owned rename before the first prompt, so DSH's
 * automatic titling never overwrites the caller's name.
 */

const PREFIX = '[委托] '
const MAX_TITLE = 64
const MAX_FALLBACK = 48
const PREFIX_RE = /^\[委托\]\s*/u

/** Strip control characters DSH's title validation refuses. */
function clean(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** Add exactly one `[委托] ` prefix (never duplicate it). */
function withPrefix(value) {
  const cleaned = clean(value)
  if (!cleaned) return PREFIX.trim()
  const body = cleaned.replace(PREFIX_RE, '').trim() || '任务'
  return `${PREFIX}${body}`
}

/**
 * Build the title for one delegation.
 * @param goal - full delegation goal; only used as a fallback when the caller
 *   did not name the session.
 * @param explicit - the delegating AI's chosen name, used verbatim inside the prefix.
 * @returns a non-empty title at most ~64 characters.
 */
export function delegationTitle(goal, explicit) {
  const wanted = clean(explicit)
  if (wanted) return withPrefix(wanted).slice(0, MAX_TITLE)
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
  const snippet = stripped.length > MAX_FALLBACK ? `${stripped.slice(0, MAX_FALLBACK)}…` : stripped
  return withPrefix(snippet || '任务').slice(0, MAX_TITLE)
}
