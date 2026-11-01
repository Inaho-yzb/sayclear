import { useEffect, useState } from 'react'
import { type Diagram, type GraphSnapshot } from '../../../shared/diagram'
import { storage } from './storage'

export function useHistorySnapshot(boardId: string, version?: Diagram['history'][number]) {
  const [attempt, setAttempt] = useState(0)
  const key = JSON.stringify([boardId, version?.id, version?.snapshotDigest, attempt])
  const [result, setResult] = useState<{ key: string; snapshot?: GraphSnapshot; error?: string }>()
  const id = version?.id
  const embedded = version?.snapshot
  useEffect(() => {
    if (!id || embedded) return
    let disposed = false
    void storage.loadHistory(boardId, id).then(
      (snapshot) => {
        if (!disposed) setResult({ key, snapshot })
      },
      (error: unknown) => {
        if (!disposed)
          setResult({
            key,
            error:
              error instanceof Error
                ? error.message
                : typeof error === 'string'
                  ? error
                  : '历史版本读取失败',
          })
      },
    )
    return () => {
      disposed = true
    }
  }, [boardId, id, embedded, key])
  const snapshot = embedded ?? (result?.key === key ? result.snapshot : undefined)
  const error = result?.key === key ? result.error : undefined
  return {
    snapshot,
    error,
    loading: !!id && !snapshot && !error,
    retry: () => setAttempt((n) => n + 1),
  }
}
