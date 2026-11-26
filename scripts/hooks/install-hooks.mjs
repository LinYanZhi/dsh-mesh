#!/usr/bin/env node
// @generated 2026-11-26: install portable .githooks (core.hooksPath).
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true }).trim()
if (!existsSync(join(root, '.githooks'))) {
  console.error('✗ .githooks 不存在')
  process.exit(1)
}
execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'inherit', windowsHide: true })
console.log('✓ core.hooksPath=.githooks')
console.log('  回滚：git config --local --unset core.hooksPath')
