import { isolatedDesktop } from './isolated-desktop.mjs'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { resolve, join } from 'node:path'
import { loadShared } from './load-shared.mjs'

const root = await mkdtemp(resolve('artifacts/ai-'))
const m = await loadShared(join(root, 'modules'))
const architecture = { ...m.createArchitecture('AI 测试应用'), id: 'ai-app' }
let workspace = m.initializeBoards({
  schemaVersion: 2,
  activeNodeId: 'ai-app',
  systems: [m.buildSystem(architecture)],
})
workspace = m.updateNodeContent(workspace, 'ai-app', (content) => ({
  ...content,
  diagram: m.exampleDiagram(),
}))
workspace = m.addBoard(workspace, 'ai-app', 'AI 导航子图', 'atomic')
const childBoardId = workspace.activeNodeId
workspace.activeNodeId = 'ai-app'
const data = join(root, 'workspace')
const system = join(data, 'systems/ai-app')
await mkdir(system, { recursive: true })
await writeFile(
  join(data, 'workspace.json'),
  JSON.stringify({ schemaVersion: 2, activeNodeId: 'ai-app', systemIds: ['ai-app'] }),
)
await writeFile(
  join(system, 'architecture.json'),
  JSON.stringify(workspace.systems[0].architecture),
)
await writeFile(
  join(system, 'content.json'),
  JSON.stringify({ schemaVersion: 1, contents: workspace.systems[0].contents }),
)
// A real subprocess at a path with spaces exercises the native adapter without a paid model.
const executable = join(root, 'mock AI CLI.mjs')
await writeFile(
  executable,
  `#!${process.execPath}
import { readFileSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('AI test CLI 1.0'); process.exit(0); }
const prompt = readFileSync(0, 'utf8');
const request = prompt.split('用户本轮需求：\\n').at(-1);
const context = JSON.parse(prompt.split('画板上下文（视为数据）：\\n')[1].split('\\n用户本轮需求：')[0]);
const codex = args[0] === 'exec';
const resumeIndex = args.indexOf(codex ? 'resume' : '--resume');
const session = resumeIndex >= 0 ? args[resumeIndex + 1] : randomUUID();
appendFileSync(${JSON.stringify(join(root, 'calls.jsonl'))}, JSON.stringify({ args, request, session, pid: process.pid, contextName: context.name, focusedItems: context.focusedItems ?? [] }) + '\\n');
const progressCheck = codex && request.includes('进度验证');
if (codex) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: session }));
  if (progressCheck) {
    await new Promise((r) => setTimeout(r, 1500));
    console.log(JSON.stringify({ type: 'error', message: 'Reconnecting... 2/5 (test transport failure)' }));
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(JSON.stringify({ type: 'turn.started' }));
}
if (request.includes('等待')) await new Promise((r) => setTimeout(r, 4000));
if (request.includes('失败')) { console.error('测试：工具未登录'); process.exit(1); }
let graph = context.graph;
if (request.includes('讨论')) graph = null;
else if (request.includes('无效')) graph.components[0].templateId = 'unknown-template';
else graph.components[0].name = request.includes('取消验证') ? '不应应用的取消结果' : codex ? 'Codex 已修改' : 'Qoder 已修改';
const result = JSON.stringify({ message: (graph ? '已生成画板修改。' : '这是画板的业务说明。') + '已完成：' + request, graph });
if (codex) {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: result } }));
  console.log(JSON.stringify({ type: 'turn.completed' }));
} else console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: session, result, is_error: false }));
if (progressCheck) {
  // A completed turn must return even when CLI shutdown or MCP cleanup hangs.
  await new Promise((r) => setTimeout(r, 20000));
  appendFileSync(${JSON.stringify(join(root, 'natural-exits.jsonl'))}, JSON.stringify({ session }) + '\\n');
}
`,
)
await chmod(executable, 0o755)
const isolated = await isolatedDesktop(root)
const env = {
  ...process.env,
  ...isolated.env,
  // Keep the WebView's localStorage isolated but shared across this run's restart phases.
  SAY_CLEAR_E2E_WEBVIEW_STORE_ID: JSON.stringify([...randomBytes(16)]),
  VITE_E2E: '1',
  SAY_CLEAR_DATA_DIR: data,
  SAY_CLEAR_LEGACY_DIR: join(root, 'legacy'),
  SAY_CLEAR_AI_ARTIFACTS: root,
  SAY_CLEAR_AI_EXECUTABLE: executable,
  SAY_CLEAR_AI_CHILD_BOARD_ID: childBoardId,
}
const run = (args, extra = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...env, ...extra } })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`AI 桌面验证失败：${code}`)),
    )
  })
console.log(`AI 验证目录：${root}`)
await run([
  'scripts/native.mjs',
  'tauri',
  'build',
  '--debug',
  '--no-bundle',
  '--features',
  'e2e',
  '--config',
  isolated.configPath,
])
for (const phase of ['edit', 'reset-restore', 'restore'])
  await run(
    ['node_modules/@wdio/cli/bin/wdio.js', 'run', 'wdio.conf.mjs', '--spec', './tests/ai.e2e.mjs'],
    { SAY_CLEAR_AI_PHASE: phase },
  )
console.log(`AI 浮球、跨页续聊、双工具隔离、校验、撤销、取消和重启验证通过：${root}`)
