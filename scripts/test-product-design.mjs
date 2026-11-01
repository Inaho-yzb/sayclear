import { isolatedDesktop } from './isolated-desktop.mjs'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

function run(args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolveRun() : reject(new Error(`验证命令退出：${code}`)),
    )
  })
}
await mkdir(resolve('artifacts'), { recursive: true })
const root = await mkdtemp(resolve('artifacts/product-design-'))
const isolated = await isolatedDesktop(root)
const env = {
  ...process.env,
  ...isolated.env,
  VITE_E2E: '1',
  SAY_CLEAR_DATA_DIR: join(root, 'workspace'),
  SAY_CLEAR_LEGACY_DIR: join(root, 'empty-legacy'),
  SAY_CLEAR_PRODUCT_ARTIFACTS: root,
}
console.log(`产品设计测试工作区：${root}`)
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
    isolated.configPath,
  ],
  env,
)
for (const phase of ['create', 'restore']) {
  await run(
    [
      'node_modules/@wdio/cli/bin/wdio.js',
      'run',
      'wdio.conf.mjs',
      '--spec',
      './tests/product-design.e2e.mjs',
    ],
    { ...env, SAY_CLEAR_PRODUCT_PHASE: phase },
  )
}
await writeFile(
  join(root, 'test-result.json'),
  JSON.stringify(
    {
      passed: true,
      scenario: '产品设计',
      templates: 6,
      metadataFields: 18,
      components: 6,
      connections: 6,
      checks: [
        '通过设置页创建组件集',
        '默认值及必填项',
        '受限组件菜单',
        '合法连线与图导入',
        '场景外组件拦截',
        '数字及布尔属性类型校验',
        '未定义属性拦截',
        '不兼容场景切换拦截',
        '使用中模板删除保护',
        '本地文件保存',
        '跨进程重启恢复',
      ],
    },
    null,
    2,
  ),
)
console.log(`产品设计场景验证通过。工作区、组件集、系统图和截图保留在：${root}`)
