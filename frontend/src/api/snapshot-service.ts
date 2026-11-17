import { MODULE_BY_KEY } from '@/data/modules'
import { listRows } from '@/data/local-store'
import {
  nextSequenceCode,
  resetSnapshotBoard,
  saveSnapshotBoard,
  snapshotBoard,
} from '@/data/snapshot-store'
import type {
  ArbitrationPolicy,
  DataViewManifestResult,
  DataViewManifestRow,
  EntryRow,
  PublishRequest,
  PublishResult,
  RetentionCurvePoint,
  RetentionSnapshot,
  SnapshotBoard,
  SnapshotConflictReceipt,
  SnapshotIsolationTicket,
  SnapshotPattern,
  SnapshotReviewChecklist,
  SnapshotSourceRef,
} from '@/data/types'

// 回访分析视图数据快照：把回访模式与分析视图的业务数据按同一业务版本聚合成只读曲线。
// 数据视图清单只从这个冻结版本读回访曲线，不再直接读实时业务行。
const RETENTION_MODULE = 'retention'
const DATAVIEW_MODULE = 'dataview'
const AGGREGATE_VIEW_CODE = 'DATA-ALL'
const SNAPSHOT_PREFIX = 'RVS'
const RECEIPT_PREFIX = 'CONF'
const TICKET_PREFIX = 'ISOL'
const CHECKLIST_PREFIX = 'CHKL'
const CURVE_HORIZON_DAYS = 14
const DEFAULT_OPERATOR = '值班管理员'

// 历史样例数据用 RETE 前缀，任务里把回访模式写成 RETN-0002；两种前缀指向同一条业务记录。
const RETENTION_CODE_ALIASES: Record<string, string> = { RETN: 'RETE' }

function nowIso(): string {
  return new Date().toISOString()
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function hash32(input: string): number {
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function numeric(value: unknown): number | null {
  const text = String(value ?? '').trim()
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    return null
  }
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

export function normalizeRetentionCode(code: string): string {
  const trimmed = code.trim().toUpperCase()
  const matched = /^([A-Z]+)-(\d+)$/.exec(trimmed)
  if (!matched) {
    return trimmed
  }
  const prefix = RETENTION_CODE_ALIASES[matched[1]] ?? matched[1]
  return `${prefix}-${matched[2]}`
}

function retentionRows(): EntryRow[] {
  return listRows(RETENTION_MODULE)
}

function dataviewRows(): EntryRow[] {
  return listRows(DATAVIEW_MODULE)
}

function rowCode(row: EntryRow): string {
  return String(row['模式编号'] ?? '')
}

function viewCode(row: EntryRow): string {
  return String(row['视图编号'] ?? '')
}

export function findRetentionRow(code: string): EntryRow | null {
  const normalized = normalizeRetentionCode(code)
  return (
    retentionRows().find((row) => rowCode(row).toUpperCase() === normalized) ??
    retentionRows().find((row) => String(row.id) === code.trim()) ??
    null
  )
}

export function findDataViewRow(code: string): EntryRow | null {
  const trimmed = code.trim().toUpperCase()
  return (
    dataviewRows().find((row) => viewCode(row).toUpperCase() === trimmed) ??
    dataviewRows().find((row) => String(row.id) === code.trim()) ??
    null
  )
}

// 业务版本：回访模式和分析视图的字段 + 状态一起算哈希，字段没变版本就不变，复核才对得上。
export function computeBusinessVersion(
  retentions: EntryRow[],
  views: EntryRow[],
): string {
  const retentionMeta = MODULE_BY_KEY.get(RETENTION_MODULE)
  const dataviewMeta = MODULE_BY_KEY.get(DATAVIEW_MODULE)
  const payload = {
    retention: retentions.map((row) => ({
      id: row.id,
      status: row.status,
      fields: (retentionMeta?.fields ?? []).map((field) => [field, row[field] ?? '']),
    })),
    dataview: views.map((row) => ({
      id: row.id,
      status: row.status,
      fields: (dataviewMeta?.fields ?? []).map((field) => [field, row[field] ?? '']),
    })),
  }
  return `BV-${hash32(stableStringify(payload)).toString(16).padStart(8, '0')}`
}

// 示例数据里的业务字段是占位文本，这里按业务版本里的编号派生稳定的曲线和指标。
// 派生只依赖记录内容，同一业务版本在任何页面、任何刷新后读到的曲线都一致。
export function derivePattern(row: EntryRow): SnapshotPattern {
  const code = rowCode(row)
  const segment = String(row['用户分群'] ?? '')
  const firstWindow = String(row['首次访问窗口'] ?? '')
  const rng = mulberry32(hash32(`${code}|${segment}|${firstWindow}`))

  const cycleDays =
    numeric(row['回访周期天']) ?? 7 + Math.floor(rng() * 21)
  const frequency =
    numeric(row['回访频次']) ?? round(1.5 + rng() * 3.5, 2)
  const cohortUsers =
    numeric(row['用户数']) ?? 800 + Math.floor(rng() * 4200)
  const halfLife = 3.5 + rng() * 6.5

  const curve: RetentionCurvePoint[] = []
  for (let day = 0; day <= CURVE_HORIZON_DAYS; day += 1) {
    const jitter = 0.94 + rng() * 0.12
    const rawRate = day === 0 ? 1 : clamp(Math.exp(-day / halfLife) * jitter, 0.01, 1)
    const retentionRate = round(rawRate, 4)
    curve.push({
      day,
      retainedUsers: Math.round(cohortUsers * retentionRate),
      retentionRate,
    })
  }

  const dayRate = (day: number): number => curve[day]?.retentionRate ?? 0
  const stickinessIndex = round(
    clamp(((dayRate(1) + dayRate(3) + dayRate(7)) / 3) * 100 * (frequency / 3), 0, 100),
    1,
  )

  return {
    code,
    sourceCode: code,
    segment,
    firstWindow,
    cycleDays: round(cycleDays, 1),
    frequency,
    stickinessIndex,
    cohortUsers,
    curve,
  }
}

function weightedAverage(
  patterns: SnapshotPattern[],
  pick: (pattern: SnapshotPattern) => number,
): number {
  const total = patterns.reduce((sum, pattern) => sum + pattern.cohortUsers, 0)
  if (total <= 0) {
    return 0
  }
  return patterns.reduce((sum, pattern) => sum + pick(pattern) * pattern.cohortUsers, 0) / total
}

export function aggregatePatterns(patterns: SnapshotPattern[]): {
  curve: RetentionCurvePoint[]
  cycleDays: number
  stickinessIndex: number
  frequency: number
  cohortUsers: number
} {
  const cohortUsers = patterns.reduce((sum, pattern) => sum + pattern.cohortUsers, 0)
  const curve: RetentionCurvePoint[] = []
  for (let day = 0; day <= CURVE_HORIZON_DAYS; day += 1) {
    const retainedUsers = patterns.reduce(
      (sum, pattern) => sum + (pattern.curve[day]?.retainedUsers ?? 0),
      0,
    )
    curve.push({
      day,
      retainedUsers,
      retentionRate: cohortUsers > 0 ? round(retainedUsers / cohortUsers, 4) : 0,
    })
  }
  return {
    curve,
    cycleDays: round(weightedAverage(patterns, (pattern) => pattern.cycleDays), 1),
    stickinessIndex: round(weightedAverage(patterns, (pattern) => pattern.stickinessIndex), 1),
    frequency: round(weightedAverage(patterns, (pattern) => pattern.frequency), 2),
    cohortUsers,
  }
}

function buildSources(
  retentions: EntryRow[],
  views: EntryRow[],
): SnapshotSourceRef[] {
  const sources: SnapshotSourceRef[] = retentions.map((row) => ({
    module: 'retention',
    id: Number(row.id),
    code: rowCode(row),
    status: String(row.status),
    summary: `${String(row['用户分群'] ?? '')} · ${String(row['首次访问窗口'] ?? '')}`,
  }))
  for (const row of views) {
    sources.push({
      module: 'dataview',
      id: Number(row.id),
      code: viewCode(row),
      status: String(row.status),
      summary: `${String(row['视图名称'] ?? '')} · ${String(row['数据源组合'] ?? '')}`,
    })
  }
  return sources
}

function makeRequestId(publisher: string, code: string, requestedAt: string): string {
  return `REQ-${hash32(`${publisher}|${code}|${requestedAt}`).toString(16).padStart(8, '0')}`
}

function nextBoard(
  board: SnapshotBoard,
  patch: Partial<SnapshotBoard>,
): SnapshotBoard {
  return saveSnapshotBoard({
    ...board,
    ...patch,
    snapshots: patch.snapshots ?? board.snapshots,
    receipts: patch.receipts ?? board.receipts,
    isolationTickets: patch.isolationTickets ?? board.isolationTickets,
    reviewChecklists: patch.reviewChecklists ?? board.reviewChecklists,
  })
}

function makeReceipt(
  board: SnapshotBoard,
  input: {
    requestId: string
    publisher: string
    role: 'owner' | 'editor'
    businessVersion: string
    snapshotCode: string
    analysisViewCode: string
    reason: string
    policy: ArbitrationPolicy
  },
): SnapshotConflictReceipt {
  return {
    code: nextSequenceCode(board.receipts, RECEIPT_PREFIX),
    requestId: input.requestId,
    publisher: input.publisher,
    role: input.role,
    businessVersion: input.businessVersion,
    snapshotCode: input.snapshotCode,
    analysisViewCode: input.analysisViewCode,
    reason: input.reason,
    readOnly: true,
    decidedAt: nowIso(),
    policy: input.policy,
  }
}

function makeTicket(
  board: SnapshotBoard,
  input: {
    requestId: string
    publisher: string
    role: 'owner' | 'editor'
    businessVersion: string
    snapshotCode: string
    analysisViewCode: string
    reason: string
  },
): SnapshotIsolationTicket {
  return {
    code: nextSequenceCode(board.isolationTickets, TICKET_PREFIX),
    requestId: input.requestId,
    publisher: input.publisher,
    role: input.role,
    businessVersion: input.businessVersion,
    snapshotCode: input.snapshotCode,
    analysisViewCode: input.analysisViewCode,
    reason: input.reason,
    readOnly: true,
    createdAt: nowIso(),
  }
}

function makeChecklist(
  board: SnapshotBoard,
  input: {
    owner: string
    requestedBy: string
    snapshotCode: string
    businessVersion: string
  },
): SnapshotReviewChecklist {
  return {
    code: nextSequenceCode(board.reviewChecklists, CHECKLIST_PREFIX),
    owner: input.owner,
    requestedBy: input.requestedBy,
    snapshotCode: input.snapshotCode,
    businessVersion: input.businessVersion,
    items: [
      `核对快照 ${input.snapshotCode} 的回访曲线与回访页展示一致`,
      '复核回访周期与粘性指数的计算口径',
      '确认较晚完成快照的迟到保存已留档并隔离原版本',
      `确认业务版本 ${input.businessVersion} 仍为最新`,
    ],
    status: '待复核',
    createdAt: nowIso(),
  }
}

export function createSnapshot(input: {
  board: SnapshotBoard
  requestId: string
  publisher: string
  role: 'owner' | 'editor'
  policy: ArbitrationPolicy
  requestedAt: string
  analysisViewCode: string
  businessVersion: string
  patterns: SnapshotPattern[]
  retentions: EntryRow[]
  views: EntryRow[]
  previous: RetentionSnapshot | null
  competingRequestIds: string[]
}): RetentionSnapshot {
  const aggregate = aggregatePatterns(input.patterns)
  return {
    code: nextSequenceCode(input.board.snapshots, SNAPSHOT_PREFIX),
    requestId: input.requestId,
    analysisViewCode: input.analysisViewCode,
    businessVersion: input.businessVersion,
    status: 'current',
    readOnly: true,
    owner: input.role === 'owner' ? input.publisher : DEFAULT_OPERATOR,
    publisher: input.publisher,
    publisherRole: input.role,
    requestedAt: input.requestedAt,
    publishedAt: input.requestedAt,
    frozenAt: nowIso(),
    retentionCodes: input.patterns.map((pattern) => pattern.code),
    dataviewCodes: input.views.map((row) => viewCode(row)),
    sources: buildSources(input.retentions, input.views),
    patterns: input.patterns,
    curve: aggregate.curve,
    cycleDays: aggregate.cycleDays,
    stickinessIndex: aggregate.stickinessIndex,
    frequency: aggregate.frequency,
    cohortUsers: aggregate.cohortUsers,
    previousSnapshotCode: input.previous?.code ?? '',
    arbitration: {
      policy: input.policy,
      winnerRole: input.role,
      competingRequests: input.competingRequestIds.length,
      conflictRequestIds: input.competingRequestIds,
    },
  }
}

function publishFailure(
  message: string,
  extra: Partial<PublishResult> = {},
): PublishResult {
  return {
    ok: false,
    code: 'INVALID_REQUEST',
    message,
    readOnly: false,
    snapshot: null,
    receipt: null,
    ticket: null,
    checklist: null,
    ...extra,
  }
}

/**
 * 发布一次回访分析视图数据快照。
 *
 * 仲裁规则（两种做法都只留一份可追溯的当前冻结快照）：
 * - owner：所有者优先。所有者版本成为当前快照；协作者的迟到保存落隔离单，不进入快照。
 * - completion：完成时间优先。较晚完成的快照成为当前快照，所有者收到复核清单。
 * 同一业务版本无论同时提交还是重复提交，都只保留一个当前快照，其余请求返回只读冲突回执。
 */
export function publishRetentionSnapshot(request: PublishRequest): PublishResult {
  const board = snapshotBoard()
  const publisher = (request.publisher || '').trim() || DEFAULT_OPERATOR
  const role: 'owner' | 'editor' = request.role === 'editor' ? 'editor' : 'owner'
  const policy: ArbitrationPolicy = request.policy ?? board.policy ?? 'owner'

  const rawCode = (request.retentionCode || '').trim()
  if (!rawCode) {
    return publishFailure('发布快照需要指定回访模式编号')
  }
  const retentionRow = findRetentionRow(rawCode)
  if (!retentionRow) {
    return publishFailure(`没有找到回访模式 ${rawCode}，无法发布快照`)
  }
  const targetView = (request.dataviewCode || '').trim()
  const analysisViewCode = targetView || AGGREGATE_VIEW_CODE
  if (targetView && !findDataViewRow(targetView)) {
    return publishFailure(`没有找到分析视图 ${targetView}，无法发布快照`)
  }

  const requestedAt = (request.requestedAt || '').trim() || nowIso()
  if (Number.isNaN(Date.parse(requestedAt))) {
    return publishFailure(`请求时间 ${requestedAt} 不是可识别的时间`)
  }
  const requestId =
    (request.requestId || '').trim() || makeRequestId(publisher, rawCode, requestedAt)

  const retentions = retentionRows()
  const views = dataviewRows()
  // 聚合待处理所读取的回访模式：所有待处理行 + 本次指定的模式，按编号去重。
  const selected = retentions.filter(
    (row) => row.pending || rowCode(row).toUpperCase() === normalizeRetentionCode(rawCode),
  )
  const selectedIds = new Set(selected.map((row) => row.id))
  if (!selectedIds.has(retentionRow.id)) {
    selected.push(retentionRow)
  }
  const patterns = selected.map(derivePattern)
  const businessVersion = computeBusinessVersion(retentions, views)

  const current = board.snapshots.find((snapshot) => snapshot.status === 'current') ?? null

  // 同一业务版本：任何分支都只保留一个当前快照，落败请求只拿只读回执，不写业务数据。
  if (current && current.businessVersion === businessVersion) {
    const requestedMs = Date.parse(requestedAt)
    const currentMs = Date.parse(current.requestedAt)
    const sameMoment = requestedMs === currentMs
    const later = requestedMs > currentMs

    if (policy === 'owner') {
      // 所有者优先：所有者版本压过协作者版本，不论谁先落库。
      if (role === 'owner' && current.publisherRole !== 'owner') {
        const snapshot = createSnapshot({
          board,
          requestId,
          publisher,
          role,
          policy,
          requestedAt,
          analysisViewCode,
          businessVersion,
          patterns,
          retentions: selected,
          views,
          previous: current,
          competingRequestIds: [current.requestId],
        })
        const savedSnapshots = board.snapshots.map((item) =>
          item.code === current.code ? { ...item, status: 'superseded' as const } : item,
        )
        const ticket = makeTicket(board, {
          requestId: current.requestId,
          publisher: current.publisher,
          role: current.publisherRole,
          businessVersion,
          snapshotCode: snapshot.code,
          analysisViewCode: current.analysisViewCode,
          reason: '所有者优先：协作者版本被所有者版本取代，原保存请求隔离留档，不并入快照',
        })
        nextBoard(board, {
          policy,
          snapshots: [...savedSnapshots, snapshot],
          isolationTickets: [...board.isolationTickets, ticket],
        })
        return {
          ok: true,
          code: 'SNAPSHOT_SUPERSEDED',
          message: `所有者版本已冻结为当前快照 ${snapshot.code}，协作者请求落隔离单 ${ticket.code}`,
          readOnly: true,
          snapshot,
          receipt: null,
          ticket,
          checklist: null,
        }
      }

      if (role === 'editor' && current.publisherRole === 'owner') {
        // 协作者的保存（含同时保存的平局）都不能覆盖所有者版本，只落隔离单和只读回执。
        const receipt = makeReceipt(board, {
          requestId,
          publisher,
          role,
          businessVersion,
          snapshotCode: current.code,
          analysisViewCode,
          reason: sameMoment
            ? '所有者优先：与所有者同时保存时按所有者版本冻结，本请求按只读冲突处理'
            : later
              ? '所有者优先：协作者的迟到保存命中已冻结的所有者快照，按只读冲突隔离'
              : '所有者优先：协作者提交时间早于所有者冻结版本，按只读冲突隔离',
          policy,
        })
        const ticket = makeTicket(board, {
          requestId,
          publisher,
          role,
          businessVersion,
          snapshotCode: current.code,
          analysisViewCode,
          reason: sameMoment
            ? '同时保存隔离单：与所有者同时提交同一回访结果，未生成第二个快照'
            : later
              ? '迟到保存隔离单：协作者在所有者快照冻结后仍提交同一业务版本，未写入快照'
              : '迟到保存隔离单：协作者版本早于所有者确认版本，未写入快照',
        })
        nextBoard(board, {
          policy,
          receipts: [...board.receipts, receipt],
          isolationTickets: [...board.isolationTickets, ticket],
        })
        return {
          ok: false,
          code: sameMoment ? 'READ_ONLY_CONFLICT' : 'LATE_SAVE_ISOLATED',
          message: sameMoment
            ? `与所有者同时保存，只有快照 ${current.code} 生效；本请求收到只读冲突回执 ${receipt.code}，保存隔离为 ${ticket.code}`
            : `本请求按只读冲突处理：所有者快照 ${current.code} 保持当前，协作者保存隔离为 ${ticket.code}`,
          readOnly: true,
          snapshot: current,
          receipt,
          ticket,
          checklist: null,
        }
      }

      const receipt = makeReceipt(board, {
        requestId,
        publisher,
        role,
        businessVersion,
        snapshotCode: current.code,
        analysisViewCode,
        reason: sameMoment
          ? '同一业务版本的两个发布请求同时保存，只生成一个当前快照；本请求按只读冲突处理'
          : '同一业务版本已有当前冻结快照，重复提交按只读冲突处理，不再生成第二个快照',
        policy,
      })
      const saved = nextBoard(board, {
        policy,
        receipts: [...board.receipts, receipt],
      })
      return {
        ok: false,
        code: 'READ_ONLY_CONFLICT',
        message: `业务版本 ${businessVersion} 已由快照 ${current.code} 冻结，本请求只收到只读冲突回执 ${receipt.code}`,
        readOnly: true,
        snapshot: current,
        receipt,
        ticket: null,
        checklist: null,
        revision: saved.revision,
      }
    }

    // completion：完成时间优先。严格较晚完成的保存才能取代当前快照。
    if (later) {
      if (role === 'editor' && current.publisherRole === 'owner') {
        // 协作者的较晚完成版本胜出，但所有者必须复核：留复核清单而不是隔离单。
        const snapshot = createSnapshot({
          board,
          requestId,
          publisher,
          role,
          policy,
          requestedAt,
          analysisViewCode,
          businessVersion,
          patterns,
          retentions: selected,
          views,
          previous: current,
          competingRequestIds: [current.requestId],
        })
        const savedSnapshots = board.snapshots.map((item) =>
          item.code === current.code ? { ...item, status: 'superseded' as const } : item,
        )
        const checklist = makeChecklist(board, {
          owner: current.owner,
          requestedBy: publisher,
          snapshotCode: snapshot.code,
          businessVersion,
        })
        nextBoard(board, {
          policy,
          snapshots: [...savedSnapshots, snapshot],
          reviewChecklists: [...board.reviewChecklists, checklist],
        })
        return {
          ok: true,
          code: 'OWNER_REVIEW_REQUIRED',
          message: `较晚完成的保存已冻结为当前快照 ${snapshot.code}，所有者复核清单 ${checklist.code} 已生成`,
          readOnly: true,
          snapshot,
          receipt: null,
          ticket: null,
          checklist,
        }
      }

      if (role === 'owner' && current.publisherRole !== 'owner') {
        const snapshot = createSnapshot({
          board,
          requestId,
          publisher,
          role,
          policy,
          requestedAt,
          analysisViewCode,
          businessVersion,
          patterns,
          retentions: selected,
          views,
          previous: current,
          competingRequestIds: [current.requestId],
        })
        const savedSnapshots = board.snapshots.map((item) =>
          item.code === current.code ? { ...item, status: 'superseded' as const } : item,
        )
        nextBoard(board, {
          policy,
          snapshots: [...savedSnapshots, snapshot],
        })
        return {
          ok: true,
          code: 'SNAPSHOT_SUPERSEDED',
          message: `较晚完成的所有者保存已冻结为当前快照 ${snapshot.code}，原快照 ${current.code} 保留为历史冻结版本`,
          readOnly: true,
          snapshot,
          receipt: null,
          ticket: null,
          checklist: null,
        }
      }
    }

    const receipt = makeReceipt(board, {
      requestId,
      publisher,
      role,
      businessVersion,
      snapshotCode: current.code,
      analysisViewCode,
      reason: sameMoment
        ? '完成时间优先：两个请求完成时间相同，先冻结的快照保持不变，本请求按只读冲突处理'
        : '完成时间优先：本请求未晚于当前冻结版本，重复提交按只读冲突处理',
      policy,
    })
    const saved = nextBoard(board, {
      policy,
      receipts: [...board.receipts, receipt],
    })
    return {
      ok: false,
      code: 'READ_ONLY_CONFLICT',
      message: `业务版本 ${businessVersion} 已冻结，本请求只收到只读冲突回执 ${receipt.code}`,
      readOnly: true,
      snapshot: current,
      receipt,
      ticket: null,
      checklist: null,
      revision: saved.revision,
    }
  }

  // 新业务版本：生成新的当前快照，旧的当前快照保留为可追溯的历史冻结版本。
  const snapshot = createSnapshot({
    board,
    requestId,
    publisher,
    role,
    policy,
    requestedAt,
    analysisViewCode,
    businessVersion,
    patterns,
    retentions: selected,
    views,
    previous: current,
    competingRequestIds: current ? [current.requestId] : [],
  })
  const savedSnapshots = board.snapshots.map((item) =>
    item.status === 'current' ? { ...item, status: 'superseded' as const } : item,
  )
  nextBoard(board, {
    policy,
    snapshots: [...savedSnapshots, snapshot],
  })
  return {
    ok: true,
    code: current ? 'SNAPSHOT_SUPERSEDED' : 'SNAPSHOT_CREATED',
    message: current
      ? `新快照 ${snapshot.code} 已冻结为当前版本，原快照 ${current.code} 转为历史版本`
      : `快照 ${snapshot.code} 已冻结，业务版本 ${businessVersion}`,
    readOnly: true,
    snapshot,
    receipt: null,
    ticket: null,
    checklist: null,
  }
}

export function listSnapshots(): RetentionSnapshot[] {
  return [...snapshotBoard().snapshots].sort((left, right) =>
    right.code.localeCompare(left.code),
  )
}

export function getCurrentSnapshot(): RetentionSnapshot | null {
  return snapshotBoard().snapshots.find((snapshot) => snapshot.status === 'current') ?? null
}

export function getSnapshotByCode(code: string): RetentionSnapshot | null {
  const normalized = (code || '').trim().toUpperCase()
  if (!normalized) {
    return null
  }
  return (
    snapshotBoard().snapshots.find((snapshot) => snapshot.code.toUpperCase() === normalized) ??
    null
  )
}

export function listConflictReceipts(): SnapshotConflictReceipt[] {
  return [...snapshotBoard().receipts].reverse()
}

export function listIsolationTickets(): SnapshotIsolationTicket[] {
  return [...snapshotBoard().isolationTickets].reverse()
}

export function listReviewChecklists(): SnapshotReviewChecklist[] {
  return [...snapshotBoard().reviewChecklists].reverse()
}

export function currentArbitrationPolicy(): ArbitrationPolicy {
  return snapshotBoard().policy
}

export function setArbitrationPolicy(policy: ArbitrationPolicy): ArbitrationPolicy {
  const board = snapshotBoard()
  nextBoard(board, { policy })
  return policy
}

export function resetRetentionSnapshots(): void {
  resetSnapshotBoard()
}

export function formatPercent(rate: number, digits = 1): string {
  return `${(rate * 100).toFixed(digits)}%`
}

export function formatCurve(
  snapshot: RetentionSnapshot | null,
  days: number[] = [1, 3, 7, 14],
): string {
  if (!snapshot) {
    return '—'
  }
  return days
    .map((day) => {
      const point = snapshot.curve.find((item) => item.day === day)
      return point ? `D${day} ${formatPercent(point.retentionRate)}` : `D${day} —`
    })
    .join(' / ')
}

// 分享链接只解析到具体快照编号，读不到编号就报缺失，绝不回退到实时业务行。
export function buildSnapshotShareLink(code: string, page = 'retention'): string {
  const origin =
    typeof window !== 'undefined' && window.location
      ? window.location.origin
      : 'http://127.0.0.1:5173'
  return `${origin}/${page}?snapshot=${encodeURIComponent(code)}`
}

export function parseSnapshotQuery(query: Record<string, unknown>): string {
  const raw = query.snapshot
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value.trim() : ''
}

export function loadDataViewManifest(snapshotCode = ''): DataViewManifestResult {
  const requestedSnapshotCode = snapshotCode.trim()
  const snapshot = requestedSnapshotCode
    ? getSnapshotByCode(requestedSnapshotCode)
    : getCurrentSnapshot()
  const missingSnapshot = Boolean(requestedSnapshotCode) && !snapshot
  const frozenViews = new Set(snapshot?.dataviewCodes ?? [])
  const rows: DataViewManifestRow[] = dataviewRows().map((row) => {
    const base: EntryRow = { ...row }
    // 只有冻结时纳入快照的分析视图才展示该快照的曲线，后建的视图不能借用旧快照指标。
    const inSnapshot = Boolean(snapshot) && frozenViews.has(viewCode(row))
    return {
      ...base,
      '回访模式': snapshot
        ? inSnapshot
          ? snapshot.retentionCodes.join('、')
          : '未纳入该快照'
        : '未发布回访视图快照',
      '回访曲线': inSnapshot ? formatCurve(snapshot) : '—',
      '回访周期': inSnapshot ? `${snapshot!.cycleDays} 天` : '—',
      '粘性指数': inSnapshot ? `${snapshot!.stickinessIndex}` : '—',
      '回访视图快照来源': snapshot
        ? inSnapshot
          ? `${snapshot.code} · ${snapshot.businessVersion}`
          : `${snapshot.code} 未包含该视图`
        : missingSnapshot
          ? `未找到冻结快照 ${requestedSnapshotCode}`
          : '未发布快照',
      '快照冻结状态': snapshot
        ? inSnapshot
          ? `${snapshot.status === 'current' ? '当前冻结版本' : '历史冻结版本'} · ${snapshot.frozenAt}`
          : '未纳入冻结版本'
        : '无冻结版本',
      snapshotCode: inSnapshot ? snapshot!.code : '',
    }
  })
  return { rows, snapshot, requestedSnapshotCode, missingSnapshot }
}

export type SnapshotCheck = {
  label: string
  ok: boolean
  detail: string
}

// 核对冻结快照内部的曲线、周期和粘性指数是否自洽，供两个业务面刷新后复核。
export function verifySnapshot(snapshot: RetentionSnapshot): SnapshotCheck[] {
  const checks: SnapshotCheck[] = []
  const first = snapshot.curve.find((point) => point.day === 0)
  checks.push({
    label: 'D0 基线',
    ok: Boolean(first && first.retentionRate === 1),
    detail: first ? `D0 留存率 ${formatPercent(first.retentionRate)}` : '缺少 D0 采样点',
  })

  const retainedMatch = snapshot.curve.every((point) => {
    const expected = Math.round(snapshot.cohortUsers * point.retentionRate)
    return Math.abs(expected - point.retainedUsers) <= 1
  })
  checks.push({
    label: '曲线留存人数',
    ok: retainedMatch,
    detail: retainedMatch
      ? '每个采样点的留存人数与留存率一致'
      : '存在留存人数与留存率不一致的采样点',
  })

  const aggregate = aggregatePatterns(snapshot.patterns)
  const curveMatch = aggregate.curve.every((point, index) => {
    const actual = snapshot.curve[index]
    return actual ? actual.retainedUsers === point.retainedUsers : false
  })
  checks.push({
    label: '分模式聚合曲线',
    ok: curveMatch,
    detail: curveMatch
      ? `${snapshot.patterns.length} 个回访模式加权聚合一致`
      : '聚合曲线与分模式留存人数不一致',
  })

  const metricMatch =
    aggregate.cycleDays === snapshot.cycleDays &&
    aggregate.stickinessIndex === snapshot.stickinessIndex &&
    aggregate.frequency === snapshot.frequency
  checks.push({
    label: '回访周期与粘性指数',
    ok: metricMatch,
    detail: metricMatch
      ? `周期 ${snapshot.cycleDays} 天 · 粘性指数 ${snapshot.stickinessIndex} · 频次 ${snapshot.frequency}`
      : '冻结指标与聚合口径不一致',
  })

  const currentCount = snapshotBoard().snapshots.filter((item) => item.status === 'current').length
  checks.push({
    label: '当前快照唯一',
    ok: currentCount === 1,
    detail: currentCount === 1 ? '只有一个当前冻结快照' : `当前存在 ${currentCount} 个快照`,
  })

  return checks
}

export function retentionSnapshotView(snapshotCode = ''): {
  snapshot: RetentionSnapshot | null
  missing: boolean
  checks: SnapshotCheck[]
} {
  const requested = snapshotCode.trim()
  const snapshot = requested ? getSnapshotByCode(requested) : getCurrentSnapshot()
  return {
    snapshot,
    missing: Boolean(requested) && !snapshot,
    checks: snapshot ? verifySnapshot(snapshot) : [],
  }
}
