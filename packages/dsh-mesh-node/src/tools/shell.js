import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { isInsideRoots } from '../core/config.js'
import { clip, run, short } from '../core/util.js'
import { denied, invalidArg, ok } from '../core/result.js'

/**
 * Escape hatch: run a command on the peer machine.
 * Three locks must all be open: acl.allow lists `shell_run`, `shell.enabled` is true,
 * and cwd stays inside fsRoots ∪ shell.cwdRoots. No shell interpreter is involved.
 */
export function buildShell(ctx) {
  return [
    {
      name: 'shell_run',
      title: 'Run a command on the peer machine (opt-in)',
      description:
        'Execute a program on the peer machine without a shell. REFUSED unless the peer enabled it (config.shell.enabled + acl allow). Returns exit code, stdout, stderr and duration. Prefer the structured tools (fs_*, git_*) when they can do the job.',
      inputSchema: z.object({
        command: z.string().describe('Program to run, e.g. "node" or "git". Not a shell string.'),
        args: z.array(z.string()).optional().describe('Arguments passed verbatim to the program.'),
        cwd: z.string().optional().describe('Working directory (defaults to the first fsRoot).'),
        timeoutMs: z.number().int().min(100).max(600000).optional()
      }),
      handler: async ({ command, args, cwd, timeoutMs }, { signal } = {}) => {
        const config = ctx.getConfig()
        const shell = config.shell || {}
        if (shell.enabled !== true) {
          return denied('shell_run is disabled on this node (config.shell.enabled=false)')
        }
        const allowCommands = Array.isArray(shell.allowCommands) ? shell.allowCommands : []
        if (allowCommands.length > 0 && !allowCommands.includes(command)) {
          return denied(`command not in shell.allowCommands: ${command}`, { allowCommands })
        }
        const roots = [...(config.acl?.fsRoots || []), ...(shell.cwdRoots || [])]
        const workdir = resolve(cwd ?? config.acl?.fsRoots?.[0] ?? process.cwd())
        if (!isInsideRoots(workdir, roots)) {
          return denied(`cwd is outside the allowed roots: ${workdir}`)
        }
        if (!existsSync(workdir) || !statSync(workdir).isDirectory()) {
          return invalidArg(`cwd is not a directory: ${workdir}`)
        }
        const limit = Math.min(timeoutMs ?? shell.timeoutMs ?? 60000, 600000)
        const started = Date.now()
        const out = await run(command, args ?? [], { cwd: workdir, timeout: limit, signal })
        const stdout = clip(out.stdout, 262144)
        const stderr = clip(out.stderr, 65536)
        return ok({
          command,
          args: args ?? [],
          cwd: workdir,
          exitCode: out.code,
          timedOut: out.timedOut,
          aborted: Boolean(signal?.aborted),
          durationMs: Date.now() - started,
          stdout: stdout.text,
          stdoutTruncated: stdout.truncated,
          stderr: stderr.text,
          stderrTruncated: stderr.truncated,
          error: out.error ? short(out.error.message, 500) : null
        })
      }
    }
  ]
}
