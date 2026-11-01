import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const [tool, ...args] = process.argv.slice(2)
const env = {
  ...process.env,
  PATH: [join(homedir(), '.cargo', 'bin'), process.env.PATH].join(delimiter),
}
const child =
  tool === 'tauri'
    ? spawn(process.execPath, [require.resolve('@tauri-apps/cli/tauri.js'), ...args], {
        stdio: 'inherit',
        env,
      })
    : spawn('cargo', args, { stdio: 'inherit', env })
child.on('error', (error) => {
  console.error('无法启动原生工具链，请安装 Rust： https://rustup.rs', error.message)
  process.exitCode = 1
})
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
