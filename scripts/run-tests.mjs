#!/usr/bin/env node
/**
 * 测试入口: 编译被测模块 → 运行 node --test → 清理临时产物。
 *
 * 为什么需要编译这一步:
 * 测试要 import electron/main 下的真实实现 (而不是复制一份逻辑 ——
 * 复制品在源码改动后依然全绿, 等于没测)。但 node 加载 .ts 需要
 * --experimental-strip-types (Node 22.6+) 或 --experimental-transform-types,
 * 前者在 Node 22.0~22.5 上不存在, 会让 CI 的测试步骤直接失败。
 * 这里用项目已有的 esbuild 编译到系统临时目录, 不依赖任何实验性 flag。
 *
 * 用法: npm test
 */

import { build } from 'esbuild'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const testDir = join(root, 'test')
const outDir = mkdtempSync(join(tmpdir(), 'shelldesk-test-'))

/** 需要被测的模块: 刻意不依赖 electron/fs, 便于在 node 中直接运行 */
const ENTRY_POINTS = [
  join(root, 'electron/main/knownHostKey.ts'),
  join(root, 'electron/main/remoteOs.ts'),
  join(root, 'electron/main/sshErrors.ts'),
  join(root, 'electron/main/systemStatus.ts')
]

function fail(message, detail) {
  console.error(`\n[测试准备] ${message}`)
  if (detail) console.error(detail)
  rmSync(outDir, { recursive: true, force: true })
  process.exit(1)
}

try {
  await build({
    entryPoints: ENTRY_POINTS,
    outdir: outDir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'warning'
  })
} catch (error) {
  fail('无法编译被测模块', error?.message || String(error))
}

/** 收集 test/ 下的测试文件 (*.test.js 与 *.test.mjs) */
function collectTests(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      // helpers/ 不是测试, 只收测试文件
      if (entry.name !== 'helpers') found.push(...collectTests(full))
    } else if (/\.test\.(js|mjs)$/.test(entry.name)) {
      found.push(full)
    }
  }
  return found.sort()
}

const testFiles = collectTests(testDir)
if (testFiles.length === 0) fail('test/ 下没有找到任何测试文件')

// 只跑端到端时跳过单元测试 (e2e 脚本自己会编译需要的模块)
if (process.argv.includes('--e2e-only')) {
  rmSync(outDir, { recursive: true, force: true })
  runE2E()
} else {
  const child = spawn(process.execPath, ['--test', ...testFiles], {
    stdio: 'inherit',
    env: { ...process.env, SHELLDESK_TEST_MODULES: outDir }
  })

  child.on('exit', (code, signal) => {
    rmSync(outDir, { recursive: true, force: true })
    if (signal) process.kill(process.pid, signal)
    else if (code !== 0) process.exit(code ?? 1)
    else runE2E()
  })
}

/**
 * 单元测试通过后再跑端到端。
 * 这两步用真实的 ssh2 服务端 (scripts/lib/test-ssh-server.mjs) 做完整握手,
 * 不需要外部 sshd, 也不占用固定端口, 因此可以纳入常规测试。
 */
function runE2E() {
  // 前两个用 ssh2 的 JS 服务端 (到处都能跑);
  // 后两个对真实 OpenSSH, 环境不具备时会自行跳过 (返回 0);
  // 最后一个是渲染层 UI 验证, 需要构建产物 + Electron, 缺一即跳过
  const scripts = [
    'scripts/e2e-ssh-check.mjs',
    'scripts/e2e-error-mapping.mjs',
    'scripts/e2e-openssh-check.mjs',
    'scripts/e2e-system-status.mjs',
    'scripts/e2e-ui-check.mjs'
  ]
  if (process.argv.includes('--unit-only')) process.exit(0)
  let failed = 0
  const runNext = (index) => {
    if (index >= scripts.length) {
      if (failed > 0) {
        console.error(`\n端到端验证失败: ${failed} 个脚本未通过`)
        process.exit(1)
      }
      process.exit(0)
    }
    const script = scripts[index]
    console.log(`\n──── ${script} ────`)
    const e2e = spawn(process.execPath, [script], { stdio: 'inherit' })
    e2e.on('exit', (code) => {
      if (code !== 0) failed++
      runNext(index + 1)
    })
  }
  runNext(0)
}