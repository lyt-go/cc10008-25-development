import type { SnapshotBoard } from './types'

// 快照单独存在一个键里：业务行仍走 entries，冻结版本只在这里追加，发布后不再改写。
const SNAPSHOT_STORAGE_KEY = 'behavior-event-trace-hub:retention-snapshots'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function emptySnapshotBoard(): SnapshotBoard {
  return {
    revision: 0,
    policy: 'owner',
    snapshots: [],
    receipts: [],
    isolationTickets: [],
    reviewChecklists: [],
  }
}

function readStorage(): SnapshotBoard {
  const fallback = emptySnapshotBoard()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(SNAPSHOT_STORAGE_KEY)
  if (!raw) {
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SnapshotBoard>
    return {
      ...fallback,
      ...parsed,
      snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [],
      receipts: Array.isArray(parsed.receipts) ? parsed.receipts : [],
      isolationTickets: Array.isArray(parsed.isolationTickets) ? parsed.isolationTickets : [],
      reviewChecklists: Array.isArray(parsed.reviewChecklists) ? parsed.reviewChecklists : [],
    }
  } catch {
    return fallback
  }
}

let cache: SnapshotBoard | null = null

export function snapshotBoard(): SnapshotBoard {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function saveSnapshotBoard(board: SnapshotBoard): SnapshotBoard {
  const next = clone(board)
  next.revision = Number(next.revision || 0) + 1
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(next))
  }
  return next
}

export function resetSnapshotBoard(): SnapshotBoard {
  const next = emptySnapshotBoard()
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(SNAPSHOT_STORAGE_KEY)
  }
  return next
}

export function snapshotStorageKey(): string {
  return SNAPSHOT_STORAGE_KEY
}

export function nextSequenceCode(
  existing: { code: string }[],
  prefix: string,
): string {
  let max = 0
  for (const item of existing) {
    const matched = /-(\d+)$/.exec(item.code)
    if (matched) {
      max = Math.max(max, Number(matched[1]))
    }
  }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}
