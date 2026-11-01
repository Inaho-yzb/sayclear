import { describe, expect, it } from 'vitest'
import { exportZip, type ExportBundleFiles } from '../src/shared/export-zip'

function readZip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = bytes.length - 22
  expect(view.getUint32(end, true)).toBe(0x06054b50)
  const count = view.getUint16(end + 10, true)
  const directorySize = view.getUint32(end + 12, true)
  let cursor = view.getUint32(end + 16, true)
  expect(cursor + directorySize).toBe(end)
  const decoder = new TextDecoder()
  const entries = new Map<string, { content: string; crc: number }>()
  for (let index = 0; index < count; index++) {
    expect(view.getUint32(cursor, true)).toBe(0x02014b50)
    expect(view.getUint16(cursor + 8, true)).toBe(0x0800)
    expect(view.getUint16(cursor + 10, true)).toBe(0)
    const nameLength = view.getUint16(cursor + 28, true)
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    const offset = view.getUint32(cursor + 42, true)
    expect(view.getUint32(offset, true)).toBe(0x04034b50)
    const size = view.getUint32(cursor + 24, true)
    expect(view.getUint32(offset + 22, true)).toBe(size)
    expect(view.getUint32(offset + 14, true)).toBe(view.getUint32(cursor + 16, true))
    const start = offset + 30 + view.getUint16(offset + 26, true)
    expect(decoder.decode(bytes.subarray(offset + 30, start))).toBe(name)
    entries.set(name, {
      content: decoder.decode(bytes.subarray(start, start + size)),
      crc: view.getUint32(cursor + 16, true),
    })
    cursor += 46 + nameLength
  }
  expect(cursor).toBe(end)
  return entries
}

const bundle = (): ExportBundleFiles => ({
  name: 'say-clear-test',
  files: [
    { path: 'README.md', content: '导出说明\n完整内容 😀' },
    { path: 'boards/stable-id/graph.json', content: '{"name":"中文图"}' },
    { path: 'empty.md', content: '' },
    { path: 'crc.txt', content: '123456789' },
  ],
})

describe('UTF-8 ZIP 交付包', () => {
  it('保留文件层级和 UTF-8 内容，生成一致的本地记录、目录与 CRC', () => {
    const source = bundle()
    const output = exportZip(source)
    const entries = readZip(output)
    expect(entries.size).toBe(source.files.length)
    for (const file of source.files) {
      expect(entries.get(`${source.name}/${file.path}`)?.content).toBe(file.content)
    }
    expect(entries.get('say-clear-test/crc.txt')?.crc).toBe(0xcbf43926)
    expect(entries.get('say-clear-test/empty.md')?.crc).toBe(0)
    expect(exportZip(source)).toEqual(output)
  })

  it.each([
    '../escape.md',
    '/absolute.md',
    'C:/absolute.md',
    'boards\\escape.md',
    'a//b',
    'a/./b',
    'a/../b',
    'a/NUL.txt',
    'a/COM1',
    'a/trailing.',
    'a/汉字.md',
    'readme.MD',
    'boards',
  ])('拒绝危险路径、同名文件和文件目录冲突：%s', (path) => {
    const source = bundle()
    source.files.push({ path, content: '' })
    expect(() => exportZip(source)).toThrow()
  })

  it('允许所有合法稳定 ID，限制包名称和文件数量', () => {
    const source = bundle()
    source.files.push({ path: 'boards/_stable-id/graph.json', content: '{}' })
    expect(() => exportZip(source)).not.toThrow()
    expect(() => exportZip({ ...source, name: '../escape' })).toThrow('名称')
    expect(() => exportZip({ ...source, files: [] })).toThrow('10000')
    expect(() => exportZip({ ...source, files: Array(10001).fill(source.files[0]) })).toThrow(
      '10000',
    )
  })
})
