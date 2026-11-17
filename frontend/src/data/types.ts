/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 回访曲线上的一个采样点：第几天、留存用户数、留存率（0-1）。 */
export type RetentionCurvePoint = {
  day: number
  retainedUsers: number
  retentionRate: number
}

/** 快照里固化的单个回访模式的指标，用于回访页追溯曲线来源。 */
export type SnapshotPattern = {
  code: string
  sourceCode: string
  segment: string
  firstWindow: string
  cycleDays: number
  frequency: number
  stickinessIndex: number
  cohortUsers: number
  curve: RetentionCurvePoint[]
}

/** 快照引用的业务记录来源，回访模式与分析视图都要能追溯回原始编号。 */
export type SnapshotSourceRef = {
  module: 'retention' | 'dataview'
  id: number
  code: string
  status: string
  summary: string
}

/**
 * 回访分析视图数据快照：一旦发布就只读。
 * 数据视图的清单只从这里读回访曲线，不再直接读实时业务行。
 */
export type RetentionSnapshot = {
  code: string
  requestId: string
  analysisViewCode: string
  businessVersion: string
  status: 'current' | 'superseded'
  readOnly: true
  owner: string
  publisher: string
  publisherRole: 'owner' | 'editor'
  requestedAt: string
  publishedAt: string
  frozenAt: string
  retentionCodes: string[]
  dataviewCodes: string[]
  sources: SnapshotSourceRef[]
  patterns: SnapshotPattern[]
  curve: RetentionCurvePoint[]
  cycleDays: number
  stickinessIndex: number
  frequency: number
  cohortUsers: number
  previousSnapshotCode: string
  arbitration: {
    policy: ArbitrationPolicy
    winnerRole: 'owner' | 'editor'
    competingRequests: number
    conflictRequestIds: string[]
  }
}

export type ArbitrationPolicy = 'owner' | 'completion'

/** 发布失败时返回的只读冲突回执：调用方只能读已有冻结快照，不能改写。 */
export type SnapshotConflictReceipt = {
  code: string
  requestId: string
  publisher: string
  role: 'owner' | 'editor'
  businessVersion: string
  snapshotCode: string
  analysisViewCode: string
  reason: string
  readOnly: true
  decidedAt: string
  policy: ArbitrationPolicy
}

/** 所有者优先时，另一用户的迟到保存被隔离，不进入快照。 */
export type SnapshotIsolationTicket = {
  code: string
  requestId: string
  publisher: string
  role: 'owner' | 'editor'
  businessVersion: string
  snapshotCode: string
  analysisViewCode: string
  reason: string
  readOnly: true
  createdAt: string
}

/** 完成时间优先时，较晚完成的快照胜出，但所有者需要复核。 */
export type SnapshotReviewChecklist = {
  code: string
  owner: string
  requestedBy: string
  snapshotCode: string
  businessVersion: string
  items: string[]
  status: '待复核'
  createdAt: string
}

export type SnapshotBoard = {
  revision: number
  policy: ArbitrationPolicy
  snapshots: RetentionSnapshot[]
  receipts: SnapshotConflictReceipt[]
  isolationTickets: SnapshotIsolationTicket[]
  reviewChecklists: SnapshotReviewChecklist[]
}

export type PublishRequest = {
  retentionCode: string
  dataviewCode?: string
  publisher: string
  role?: 'owner' | 'editor'
  policy?: ArbitrationPolicy
  requestId?: string
  requestedAt?: string
}

export type PublishResult = {
  ok: boolean
  code:
    | 'SNAPSHOT_CREATED'
    | 'SNAPSHOT_SUPERSEDED'
    | 'READ_ONLY_CONFLICT'
    | 'LATE_SAVE_ISOLATED'
    | 'OWNER_REVIEW_REQUIRED'
    | 'INVALID_REQUEST'
  message: string
  readOnly: boolean
  snapshot: RetentionSnapshot | null
  receipt: SnapshotConflictReceipt | null
  ticket: SnapshotIsolationTicket | null
  checklist: SnapshotReviewChecklist | null
  /** 本次请求写入后的快照板版本号，用于页面判断是否有新写入。 */
  revision?: number
}

export type DataViewManifestRow = EntryRow & {
  回访模式: string
  回访曲线: string
  回访周期: string
  粘性指数: string
  回访视图快照来源: string
  快照冻结状态: string
  snapshotCode?: string
}

export type DataViewManifestResult = {
  rows: DataViewManifestRow[]
  snapshot: RetentionSnapshot | null
  requestedSnapshotCode: string
  missingSnapshot: boolean
}
