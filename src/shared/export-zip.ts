export type ExportBundleFiles = {
  name: string
  files: { path: string; content: string }[]
}

const encoder = new TextEncoder()
const maximumFileBytes = 64 * 1024 * 1024
const maximumBundleBytes = 256 * 1024 * 1024

function safeSegment(segment: string): boolean {
  return (
    /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(segment) &&
    !segment.endsWith('.') &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
  )
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1))
  return value >>> 0
})

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** UTF-8, uncompressed ZIP; every entry lives below the bundle's own directory. */
export function exportZip(bundle: ExportBundleFiles): Uint8Array<ArrayBuffer> {
  if (!safeSegment(bundle.name) || bundle.name.length > 120)
    throw new Error('导出包名称必须是 1 至 120 位安全 ASCII 字符')
  if (!bundle.files.length || bundle.files.length > 10000)
    throw new Error('导出包必须包含 1 至 10000 个文件')
  const paths = new Set<string>()
  let totalBytes = 0
  const entries = bundle.files.map((file) => {
    if (
      file.path.length > 240 ||
      !file.path.split('/').every(safeSegment) ||
      paths.has(file.path.toLowerCase())
    )
      throw new Error(`导出文件路径无效或重复：${file.path}`)
    paths.add(file.path.toLowerCase())
    const name = encoder.encode(`${bundle.name}/${file.path}`)
    const content = encoder.encode(file.content)
    totalBytes += content.length
    if (content.length > maximumFileBytes || totalBytes > maximumBundleBytes)
      throw new Error('导出文件超过 64 MiB 或导出包超过 256 MiB')
    return { name, content, crc: crc32(content), offset: 0 }
  })
  for (const path of paths) {
    const segments = path.split('/')
    segments.pop()
    while (segments.length) {
      if (paths.has(segments.join('/'))) throw new Error('导出文件与目录路径冲突')
      segments.pop()
    }
  }
  const bodySize = entries.reduce(
    (size, entry) => size + 30 + entry.name.length + entry.content.length,
    0,
  )
  const directorySize = entries.reduce((size, entry) => size + 46 + entry.name.length, 0)
  const output = new Uint8Array(bodySize + directorySize + 22)
  const view = new DataView(output.buffer)
  let cursor = 0
  const u16 = (value: number) => {
    view.setUint16(cursor, value, true)
    cursor += 2
  }
  const u32 = (value: number) => {
    view.setUint32(cursor, value, true)
    cursor += 4
  }
  const bytes = (value: Uint8Array) => {
    output.set(value, cursor)
    cursor += value.length
  }
  for (const entry of entries) {
    entry.offset = cursor
    u32(0x04034b50)
    u16(20)
    u16(0x0800)
    u16(0)
    u16(0)
    u16(0x0021)
    u32(entry.crc)
    u32(entry.content.length)
    u32(entry.content.length)
    u16(entry.name.length)
    u16(0)
    bytes(entry.name)
    bytes(entry.content)
  }
  for (const entry of entries) {
    u32(0x02014b50)
    u16(20)
    u16(20)
    u16(0x0800)
    u16(0)
    u16(0)
    u16(0x0021)
    u32(entry.crc)
    u32(entry.content.length)
    u32(entry.content.length)
    u16(entry.name.length)
    u16(0)
    u16(0)
    u16(0)
    u16(0)
    u32(0)
    u32(entry.offset)
    bytes(entry.name)
  }
  u32(0x06054b50)
  u16(0)
  u16(0)
  u16(entries.length)
  u16(entries.length)
  u32(directorySize)
  u32(bodySize)
  u16(0)
  return output
}
