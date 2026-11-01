import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const read = async (path) => JSON.parse(await readFile(path, 'utf8'))
export async function diskBoard(directory, systemId, boardId) {
  const base = join(directory, 'systems', systemId, 'boards', boardId)
  const index = await read(join(base, 'index.json'))
  if (!index.diagram) return index.content
  const baseline = await read(join(base, 'current.json'))
  const draft = index.diagram.iterationId
    ? await read(join(base, 'iterations', `${index.diagram.iterationId}.json`))
    : null
  return {
    ...index.content,
    diagram: {
      ...(draft?.draft ?? baseline),
      ...(draft
        ? {
            iteration: {
              id: draft.id,
              name: draft.name,
              startedAt: draft.startedAt,
              baseline,
              ...(draft.git ? { git: draft.git } : {}),
            },
          }
        : {}),
      history: index.diagram.history,
    },
  }
}

export async function historicalSnapshot(browser, workspace, id) {
  const board = workspace.systems
    .flatMap((s) => s.contents)
    .find((c) => c.diagram?.history.some((h) => h.id === id))
  if (!board) throw new Error('找不到历史版本所属画板')
  return browser.execute(
    ({ boardId, versionId }) =>
      window.__TAURI__.core.invoke('load_history', { boardId, versionId }),
    { boardId: board.id, versionId: id },
  )
}
