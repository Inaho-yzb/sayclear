// Model IDs are case sensitive and may be Windows device names. Append a stable
// case-sensitive fingerprint so portable files keep distinct, deterministic paths.
function fileId(id: string): string {
  let fingerprint = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(id))
    fingerprint = BigInt.asUintN(64, (fingerprint ^ BigInt(byte)) * 0x100000001b3n)
  return `${id.toLowerCase()}-${fingerprint.toString(16).padStart(16, '0')}`
}

export const exportBoardPath = (id: string) => `boards/${fileId(id)}`
export const exportHistoryPath = (boardId: string, versionId: string) =>
  `${exportBoardPath(boardId)}/history/${fileId(versionId)}.json`
