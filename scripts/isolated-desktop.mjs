import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createServer } from 'node:net'

// Keep the test app independent of a running development app and other desktop tests.
export async function isolatedDesktop(root) {
  const config = JSON.parse(await readFile('src-tauri/tauri.e2e.conf.json', 'utf8'))
  config.identifier = `com.sayclear.${basename(root).toLowerCase()}`
  const configPath = join(root, 'tauri.e2e.conf.json')
  await writeFile(configPath, JSON.stringify(config))
  const port = await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
  return { configPath, env: { TAURI_WEBDRIVER_PORT: String(port) } }
}
