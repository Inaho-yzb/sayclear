import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, basename } from 'node:path'
import { createServer } from 'node:net'

function run(args, env) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? done() : reject(new Error(`验证失败：${code}`))))
  })
}
await mkdir(resolve('artifacts'), { recursive: true })
const root = await mkdtemp(resolve('artifacts/validation-'))
// Isolate both the single-instance socket and WebDriver from an open daily workspace.
const testConfig = JSON.parse(await readFile('src-tauri/tauri.e2e.conf.json', 'utf8'))
testConfig.identifier = `com.sayclear.${basename(root).toLowerCase()}`
const configPath = join(root, 'tauri.e2e.conf.json')
await writeFile(configPath, JSON.stringify(testConfig))
const port = await new Promise((done, reject) => {
  const server = createServer()
  server.on('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    server.close(() => done(port))
  })
})
const env = {
  ...process.env,
  VITE_E2E: '1',
  SAY_CLEAR_DATA_DIR: join(root, 'workspace'),
  SAY_CLEAR_LEGACY_DIR: join(root, 'empty-legacy'),
  SAY_CLEAR_VALIDATION_ARTIFACTS: root,
  TAURI_WEBDRIVER_PORT: String(port),
}
console.log(`校验节点测试工作区：${root}`)
await run(
  [
    'scripts/native.mjs',
    'tauri',
    'build',
    '--debug',
    '--no-bundle',
    '--features',
    'e2e',
    '--config',
    configPath,
  ],
  env,
)
for (const phase of ['edit', 'restore'])
  await run(
    [
      'node_modules/@wdio/cli/bin/wdio.js',
      'run',
      'wdio.conf.mjs',
      '--spec',
      './tests/validation.e2e.mjs',
    ],
    { ...env, SAY_CLEAR_VALIDATION_PHASE: phase },
  )
await writeFile(
  join(root, 'test-result.json'),
  JSON.stringify(
    {
      passed: true,
      checks: [
        '规则编辑与排序',
        'AND / OR 与提前结束',
        '通过与不通过出口',
        'JSON 导入保护',
        '撤销重做',
        '迭代与历史',
        '跨进程恢复',
      ],
    },
    null,
    2,
  ),
)
console.log(`验证完成：${root}`)
