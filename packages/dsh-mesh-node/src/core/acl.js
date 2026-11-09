// ACL editing helpers. Pure functions so the CLI and the self-test share one truth:
// an upgraded config keeps its (possibly customised) allow list — new default allows
// are NOT merged in automatically, which is why `acl reset|allow|deny` exists.
import { DEFAULT_ALLOW } from './config.js'

function unique(list) {
  return [...new Set(list.filter(name => typeof name === 'string' && name.trim()).map(name => name.trim()))]
}

function validate(names, known) {
  if (!known) return names
  const catalog = new Set(known)
  const unknown = names.filter(name => !catalog.has(name))
  if (unknown.length > 0) {
    throw Object.assign(new Error(`unknown tool(s): ${unknown.join(', ')}`), { code: 'E_INVALID_ARG' })
  }
  return names
}

/**
 * Compute the next ACL from the current one.
 * @param {{allow?: string[], deny?: string[]}} current
 * @param {{allow?: string[], deny?: string[], reset?: boolean, known?: string[]}} change
 * @returns {{allow: string[], deny: string[], changed: boolean, notes: string[]}}
 */
export function resolveAclUpdate(current, change = {}) {
  const notes = []
  let allow = [...(current?.allow || [])]
  let deny = [...(current?.deny || [])]

  if (change.reset) {
    allow = [...DEFAULT_ALLOW]
    deny = []
    notes.push('reset to DEFAULT_ALLOW')
  }

  const toAllow = validate(unique(change.allow || []), change.known)
  const toDeny = validate(unique(change.deny || []), change.known)

  for (const name of toAllow) {
    if (!allow.includes(name)) {
      allow.push(name)
      notes.push(`allow ${name}`)
    }
    if (deny.includes(name)) {
      deny = deny.filter(n => n !== name)
      notes.push(`un-deny ${name}`)
    }
  }
  for (const name of toDeny) {
    if (!deny.includes(name)) {
      deny.push(name)
      notes.push(`deny ${name}`)
    }
    if (allow.includes(name)) {
      allow = allow.filter(n => n !== name)
      notes.push(`un-allow ${name}`)
    }
  }

  const changed =
    allow.length !== (current?.allow || []).length ||
    deny.length !== (current?.deny || []).length ||
    allow.some(n => !(current?.allow || []).includes(n))

  return { allow, deny, changed, notes }
}

/** Effective view: every tool with the flag that `mesh_self` reports. */
export function describeAcl(config, names = []) {
  const allow = config?.acl?.allow || []
  const deny = config?.acl?.deny || []
  return {
    allow,
    deny,
    tools: names.map(name => {
      const denied = deny.includes(name)
      return { name, allowed: denied ? false : allow.includes(name) }
    })
  }
}
