#!/usr/bin/env node
// Portable git hook installer — works without sh/bash
import { copyFileSync, chmodSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const hooksDir = join(root, '.git', 'hooks')
const source = join(__dirname, 'pre-commit')
const target = join(hooksDir, 'pre-commit')

try {
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true })
  copyFileSync(source, target)
  chmodSync(target, 0o755)
  console.log('✅ pre-commit hook installed')
} catch (err) {
  console.warn('⚠️  pre-commit hook install skipped:', err.message)
}
