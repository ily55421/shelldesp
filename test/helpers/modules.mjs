import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

/**
 * 被测模块的编译产物目录。
 *
 * 由 scripts/run-tests.mjs 在测试前生成, 路径经环境变量传入。
 * 找不到时给出明确指引, 而不是抛一个难懂的模块解析错误。
 *
 * 注意: Windows 上的绝对路径不能直接喂给 import(), 会被当成 URL scheme
 * (Received protocol 'c:')。这里统一转成 file:// URL。
 */
const DIR = process.env.SHELLDESK_TEST_MODULES || ''

if (!DIR || !existsSync(DIR)) {
  console.error(
    [
      '',
      '找不到被测模块的编译产物。',
      '请通过 npm test 运行 (它会先编译 electron/main 下的被测模块)。',
      '',
      '若直接用 node --test, 需要先执行:',
      '  node scripts/run-tests.mjs',
      ''
    ].join('\n')
  )
  process.exit(1)
}

/** 拼出某个被测模块的 file:// URL, 可直接用于 import() */
export function moduleUrl(name) {
  return pathToFileURL(join(DIR, `${name}.js`)).href
}

export const MODULES_DIR = DIR