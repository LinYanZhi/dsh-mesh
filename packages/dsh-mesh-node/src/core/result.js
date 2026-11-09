/** Uniform tool result helpers: text content only (M1 keeps no outputSchema, so no structuredContent). */
export function ok(data) {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
}

export function fail(code, message, extra = {}) {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ code, message, retryable: false, ...extra }, null, 2)
      }
    ]
  }
}

export function denied(message, extra) {
  return fail('E_DENIED', message, extra)
}
export function invalidArg(message, extra) {
  return fail('E_INVALID_ARG', message, extra)
}
export function notFound(message, extra) {
  return fail('E_NOT_FOUND', message, extra)
}
export function internal(message, extra) {
  return fail('E_INTERNAL', message, { retryable: true, ...extra })
}
