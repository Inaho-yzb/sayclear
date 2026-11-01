import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
// Compile the same pure domain modules used by React into an isolated test workspace.
export async function loadShared(directory) {
  await mkdir(directory, { recursive: true })
  for (const name of [
    'model',
    'validation',
    'diagram',
    'git',
    'component-catalog',
    'iteration',
    'diagram-references',
    'composition',
  ]) {
    let source = await readFile(`src/shared/${name}.ts`, 'utf8')
    if (name === 'component-catalog')
      source = source.replace(
        "import defaults from './default-component-catalog.json'",
        `const defaults = ${await readFile('src/shared/default-component-catalog.json', 'utf8')}`,
      )
    const output = ts
      .transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      })
      .outputText.replace(/from '(\.\/[^']+)'/g, "from '$1.mjs'")
    await writeFile(join(directory, `${name}.mjs`), output)
  }
  return Object.assign(
    {},
    ...(await Promise.all(
      ['model', 'diagram', 'iteration', 'diagram-references', 'composition'].map(
        (name) => import(pathToFileURL(join(directory, `${name}.mjs`)).href),
      ),
    )),
  )
}
