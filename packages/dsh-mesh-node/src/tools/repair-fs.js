import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { assertInside } from '../core/repair.js'
import { fail, ok } from '../core/result.js'
import {
  backupRoot,
  repairGate,
  requireProfile,
  resolveProfileTarget,
  sha256,
  timestamp
} from './repair.js'

const confirmSchema = z
  .boolean()
  .optional()
  .describe('Must be true. Repair operations rewrite a DSH profile on this machine.')

const instanceSchema = z
  .string()
  .optional()
  .describe('Host instance id whose profile is targeted (default: first enabled instance).')

/**
 * M7 step 3 (fs_write): write ONE file inside a DSH profile, with a backup, a
 * sha256 verification of the written bytes, and a rollback on any failure.
 * Lives in its own module so the repair toolkit stays readable (and under the
 * 400-line-per-file rule); the shared helpers come from ./repair.js.
 */
export function buildRepairFs(ctx) {
  return [
    {
      name: 'fs_write',
      title: 'Write one UTF-8 file inside a DSH profile (backup + verify + rollback)',
      description:
        'Writes one file inside the target DSH profile. The old content is copied to the backup dir, the new content is re-read and verified by sha256, and any failure rolls the file back. Confined to `hosts[].profileDir` (relative paths, or absolute paths inside that profile) — use it to repair a config/patch/plugin file on an instance you cannot reach otherwise. Requires config.repair.enabled=true and confirm:true.',
      inputSchema: z.object({
        path: z
          .string()
          .describe('Target file: relative to the profile root (forward slashes) or absolute inside it. Parent dirs are created when missing.'),
        content: z.string().describe('Full new UTF-8 file content.'),
        instance: instanceSchema,
        profileDir: z.string().optional().describe('Explicit profile dir; must equal one of hosts[].profileDir.'),
        createDirs: z.boolean().optional().describe('Create missing parent directories (default true).'),
        confirm: confirmSchema
      }),
      handler: async (args) => {
        const config = ctx.getConfig()
        const gate = repairGate(config)
        if (gate) return gate
        if (args?.confirm !== true) {
          return fail('E_INVALID_ARG', 'pass confirm:true to write a file inside a DSH profile')
        }
        const repair = config.repair || {}
        const maxFileBytes = repair.maxFileBytes ?? 262144
        const raw = String(args?.path || '').trim()
        if (!raw) return fail('E_INVALID_ARG', 'path is required')
        const content = args?.content
        if (typeof content !== 'string') return fail('E_INVALID_ARG', 'content must be a string')
        const bytes = Buffer.byteLength(content, 'utf8')
        if (bytes > maxFileBytes) {
          return fail('E_INVALID_ARG', `content is ${bytes} bytes > limit ${maxFileBytes}`)
        }

        let profileDir
        let instanceId = ''
        try {
          const target = resolveProfileTarget(config, args)
          profileDir = target.profileDir
          instanceId = target.instanceId
          requireProfile(profileDir)
        } catch (error) {
          return fail(error.code || 'E_INVALID_ARG', error.message)
        }

        let absolute
        try {
          const normalized = raw.replace(/\\/g, '/')
          absolute =
            /^[a-z]:/i.test(normalized) || normalized.startsWith('/')
              ? assertInside(profileDir, normalized)
              : assertInside(profileDir, join(profileDir, ...normalized.split('/').filter((part) => part.length > 0)))
        } catch (error) {
          return fail(error.code || 'E_INVALID_ARG', error.message)
        }

        const existed = existsSync(absolute)
        const backupDir = backupRoot(config, ctx.home)
        let backup = null
        let previous = null
        if (existed) {
          previous = readFileSync(absolute)
          backup = join(backupDir, `fs-${timestamp()}-${absolute.split(/[\\/]/).pop().replace(/[^\w.-]/g, '_')}`)
          mkdirSync(backupDir, { recursive: true })
          writeFileSync(backup, previous)
        }
        try {
          if (args?.createDirs !== false) mkdirSync(dirname(absolute), { recursive: true })
          writeFileSync(absolute, content, 'utf8')
          const written = readFileSync(absolute)
          const expected = sha256(Buffer.from(content, 'utf8'))
          if (sha256(written) !== expected) throw new Error('sha256 mismatch after write')
          return ok({
            path: absolute,
            instance: instanceId || undefined,
            bytes,
            sha256: expected,
            created: !existed,
            verified: true,
            backup
          })
        } catch (error) {
          // rollback: restore the previous bytes (or remove the file we just created)
          try {
            if (existed && previous !== null) writeFileSync(absolute, previous)
            else rmSync(absolute, { force: true })
          } catch {
            /* best effort */
          }
          return fail('E_WRITE_FAILED', `fs_write failed and was rolled back: ${error.message}`, {
            retryable: false,
            path: absolute,
            backup
          })
        }
      }
    }
  ]
}
