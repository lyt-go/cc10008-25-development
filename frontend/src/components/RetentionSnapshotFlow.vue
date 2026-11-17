<template>
  <section class="snapshot-entry" data-snapshot-entry :data-surface="surface">
    <header class="snapshot-head">
      <div>
        <h3>回访视图快照</h3>
        <p class="snapshot-desc">
          聚合待处理回访模式与分析视图，按同一业务版本冻结成只读回访分析视图数据快照；回访页与数据视图共用这一份跨模块数据流。
        </p>
      </div>
      <span class="snapshot-badge" :class="snapshotBadgeClass">{{ snapshotBadge }}</span>
    </header>

    <div v-if="missingSnapshot" class="snapshot-warning">
      分享链接中的冻结快照 {{ selectedCode }} 不存在，已停止读取实时业务行。请让发布者重新发布或改用当前快照。
      <button class="btn ghost" type="button" @click="backToCurrent">回到当前快照</button>
    </div>

    <div v-if="snapshot" class="snapshot-meta">
      <div class="meta-item"><span>快照编号</span><strong>{{ snapshot.code }}</strong></div>
      <div class="meta-item"><span>业务版本</span><strong>{{ snapshot.businessVersion }}</strong></div>
      <div class="meta-item"><span>分析视图</span><strong>{{ snapshot.analysisViewCode }}</strong></div>
      <div class="meta-item"><span>发布人 / 角色</span><strong>{{ snapshot.publisher }} · {{ roleLabel(snapshot.publisherRole) }}</strong></div>
      <div class="meta-item"><span>冻结时间</span><strong>{{ formatTime(snapshot.frozenAt) }}</strong></div>
      <div class="meta-item"><span>仲裁策略</span><strong>{{ policyLabel(snapshot.arbitration.policy) }}</strong></div>
      <div class="meta-item"><span>上一冻结版本</span><strong>{{ snapshot.previousSnapshotCode || '—' }}</strong></div>
      <div class="meta-item"><span>回访模式数 / 分析视图数</span><strong>{{ snapshot.retentionCodes.length }} / {{ snapshot.dataviewCodes.length }}</strong></div>
    </div>

    <div v-if="snapshot" class="share-row">
      <span>分享链接（只读取此冻结快照）</span>
      <input class="share-input" :value="shareLink" readonly />
      <button class="btn" type="button" @click="copyShareLink">复制链接</button>
      <button class="btn ghost" type="button" @click="backToCurrent">回到当前快照</button>
    </div>

    <template v-if="snapshot">
      <div class="snapshot-metrics">
        <article class="metric-card">
          <span>回访周期</span>
          <strong>{{ snapshot.cycleDays }} 天</strong>
        </article>
        <article class="metric-card">
          <span>粘性指数</span>
          <strong>{{ snapshot.stickinessIndex }}</strong>
        </article>
        <article class="metric-card">
          <span>回访频次</span>
          <strong>{{ snapshot.frequency }}</strong>
        </article>
        <article class="metric-card">
          <span>回访用户数</span>
          <strong>{{ snapshot.cohortUsers }}</strong>
        </article>
      </div>

      <h4 class="snapshot-subtitle">冻结回访曲线</h4>
      <table class="data-table snapshot-curve">
        <thead>
          <tr>
            <th v-for="point in snapshot.curve" :key="point.day">D{{ point.day }}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td v-for="point in snapshot.curve" :key="point.day">{{ formatPercent(point.retentionRate) }}</td>
          </tr>
          <tr class="curve-users">
            <td v-for="point in snapshot.curve" :key="point.day">{{ point.retainedUsers }}</td>
          </tr>
        </tbody>
      </table>

      <h4 class="snapshot-subtitle">快照自检（同一业务版本核对）</h4>
      <ul class="check-list">
        <li v-for="check in checks" :key="check.label" :class="check.ok ? 'check-ok' : 'check-bad'">
          <span>{{ check.ok ? '✓' : '✗' }} {{ check.label }}</span>
          <em>{{ check.detail }}</em>
        </li>
      </ul>

      <h4 class="snapshot-subtitle">回访模式明细（按用户数加权聚合为上方曲线）</h4>
      <table class="data-table">
        <thead>
          <tr>
            <th>回访模式</th>
            <th>用户分群</th>
            <th>首次访问窗口</th>
            <th>回访周期</th>
            <th>粘性指数</th>
            <th>回访用户数</th>
            <th>D1 / D3 / D7</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="pattern in snapshot.patterns" :key="pattern.code">
            <td>{{ pattern.code }}</td>
            <td>{{ pattern.segment || '—' }}</td>
            <td>{{ pattern.firstWindow || '—' }}</td>
            <td>{{ pattern.cycleDays }} 天</td>
            <td>{{ pattern.stickinessIndex }}</td>
            <td>{{ pattern.cohortUsers }}</td>
            <td>{{ patternCurve(pattern) }}</td>
          </tr>
        </tbody>
      </table>

      <h4 class="snapshot-subtitle">快照来源（回访模式 + 分析视图）</h4>
      <p class="source-list">
        <span v-for="source in snapshot.sources" :key="`${source.module}-${source.id}`" class="source-tag">
          {{ source.module === 'retention' ? '回访模式' : '分析视图' }} {{ source.code }} · {{ source.status }}
        </span>
      </p>

      <details class="snapshot-history">
        <summary>历史冻结版本（{{ snapshots.length }} 个）</summary>
        <ul>
          <li v-for="item in snapshots" :key="item.code">
            <button class="link" type="button" @click="selectSnapshot(item.code)">{{ item.code }}</button>
            <span class="history-meta">
              {{ item.businessVersion }} · {{ item.status === 'current' ? '当前版本' : '历史版本' }} ·
              周期 {{ item.cycleDays }} 天 · 粘性 {{ item.stickinessIndex }} · {{ formatTime(item.frozenAt) }}
            </span>
          </li>
        </ul>
      </details>
    </template>

    <form v-if="surface === 'retention'" class="publish-form" @submit.prevent="publish">
      <div class="publish-head">
        <h4>发布回访分析视图数据快照</h4>
        <label class="inline-check">
          <input v-model="policy" type="radio" value="owner" /> 所有者优先
        </label>
        <label class="inline-check">
          <input v-model="policy" type="radio" value="completion" /> 完成时间优先
        </label>
      </div>
      <div class="publish-grid">
        <label>
          <span>回访模式编号</span>
          <input v-model="retentionCode" placeholder="RETN-0002" />
        </label>
        <label>
          <span>分析视图（可选）</span>
          <select v-model="dataviewCode">
            <option value="">全部分析视图</option>
            <option v-for="row in dataviewOptions" :key="String(row.id)" :value="String(row['视图编号'])">
              {{ row['视图编号'] }} · {{ row['视图名称'] }}
            </option>
          </select>
        </label>
        <label>
          <span>发布人</span>
          <input v-model="publisher" />
        </label>
        <label>
          <span>发布角色</span>
          <select v-model="role">
            <option value="owner">所有者</option>
            <option value="editor">协作者</option>
          </select>
        </label>
        <label>
          <span>请求时间（留空为当前时间）</span>
          <input v-model="requestedAtText" type="datetime-local" step="1" />
        </label>
        <div class="publish-buttons">
          <button class="btn primary" type="submit">发布快照</button>
          <button class="btn" type="button" @click="simulateSimultaneous">模拟同时保存</button>
          <button class="btn" type="button" @click="simulateLateSave">模拟迟到保存</button>
          <button class="btn" type="button" @click="resubmitLast">重复提交上次请求</button>
        </div>
      </div>
      <p class="publish-hint">
        RETN-0002 与示例数据中的 RETE-0002 指向同一条回访模式；同一业务版本只会保留一个当前快照，其余请求收到只读冲突回执。
      </p>
    </form>

    <div v-if="results.length" class="snapshot-results">
      <h4>最近发布回执</h4>
      <ul>
        <li v-for="item in results" :key="item.key" :class="item.result.ok ? 'result-ok' : 'result-conflict'">
          <span class="result-code">{{ item.result.code }}</span>
          <span>{{ item.label }}：{{ item.result.message }}</span>
        </li>
      </ul>
    </div>

    <div class="arbitration-grid">
      <section>
        <h4>只读冲突回执（{{ receipts.length }}）</h4>
        <ul class="record-list">
          <li v-for="item in receipts" :key="item.code">
            <strong>{{ item.code }}</strong>
            <span>{{ item.publisher }} · {{ item.businessVersion }} · 快照 {{ item.snapshotCode }}</span>
            <em>{{ item.reason }}</em>
          </li>
          <li v-if="!receipts.length" class="record-empty">暂无冲突回执</li>
        </ul>
      </section>
      <section>
        <h4>迟到保存隔离单（{{ tickets.length }}）</h4>
        <ul class="record-list">
          <li v-for="item in tickets" :key="item.code">
            <strong>{{ item.code }}</strong>
            <span>{{ item.publisher }} · 快照 {{ item.snapshotCode }}</span>
            <em>{{ item.reason }}</em>
          </li>
          <li v-if="!tickets.length" class="record-empty">暂无隔离单</li>
        </ul>
      </section>
      <section>
        <h4>所有者复核清单（{{ checklists.length }}）</h4>
        <ul class="record-list">
          <li v-for="item in checklists" :key="item.code">
            <strong>{{ item.code }}</strong>
            <span>{{ item.owner }} 复核 {{ item.snapshotCode }}（{{ item.requestedBy }} 发布）</span>
            <em>{{ item.items.join('；') }}</em>
          </li>
          <li v-if="!checklists.length" class="record-empty">暂无复核清单</li>
        </ul>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import {
  buildSnapshotShareLink,
  currentArbitrationPolicy,
  formatPercent,
  getSnapshotByCode,
  listConflictReceipts,
  listIsolationTickets,
  listReviewChecklists,
  listSnapshots,
  normalizeRetentionCode,
  parseSnapshotQuery,
  publishRetentionSnapshot,
  retentionSnapshotView,
  setArbitrationPolicy,
} from '@/api/snapshot-service'
import { listEntries } from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type {
  ArbitrationPolicy,
  EntryRow,
  PublishResult,
  RetentionSnapshot,
  SnapshotConflictReceipt,
  SnapshotIsolationTicket,
  SnapshotPattern,
  SnapshotReviewChecklist,
} from '@/data/types'

const props = defineProps<{ surface: 'retention' | 'dataview' }>()
const emit = defineEmits<{ changed: [] }>()

const route = useRoute()
const router = useRouter()
const store = useSessionStore()

const snapshots = ref<RetentionSnapshot[]>([])
const receipts = ref<SnapshotConflictReceipt[]>([])
const tickets = ref<SnapshotIsolationTicket[]>([])
const checklists = ref<SnapshotReviewChecklist[]>([])
const current = ref<RetentionSnapshot | null>(null)
const selectedCode = ref(parseSnapshotQuery(route.query))
const missingSnapshot = ref(false)
const checks = ref<{ label: string; ok: boolean; detail: string }[]>([])
const results = ref<{ key: number; label: string; result: PublishResult }[]>([])
const resultSeq = ref(0)

const retentionCode = ref('RETN-0002')
const dataviewCode = ref('')
const publisher = ref(store.operator)
const role = ref<'owner' | 'editor'>('owner')
const policy = ref<ArbitrationPolicy>(currentArbitrationPolicy())
const requestedAtText = ref('')
const dataviewOptions = ref<EntryRow[]>([])

const snapshot = computed<RetentionSnapshot | null>(() =>
  selectedCode.value ? getSnapshotByCode(selectedCode.value) : current.value,
)

const shareLink = computed(() =>
  snapshot.value ? buildSnapshotShareLink(snapshot.value.code, props.surface) : '',
)

const snapshotBadge = computed(() => {
  if (missingSnapshot.value) {
    return '快照缺失'
  }
  if (!snapshot.value) {
    return '尚未发布'
  }
  return snapshot.value.status === 'current' ? '当前冻结版本' : '历史冻结版本'
})

const snapshotBadgeClass = computed(() => {
  if (missingSnapshot.value || !snapshot.value) {
    return 'badge-warn'
  }
  return snapshot.value.status === 'current' ? 'badge-ok' : 'badge-muted'
})

function roleLabel(value: 'owner' | 'editor'): string {
  return value === 'owner' ? '所有者' : '协作者'
}

function policyLabel(value: ArbitrationPolicy): string {
  return value === 'owner' ? '所有者优先' : '完成时间优先'
}

function formatTime(value: string): string {
  const time = Date.parse(value)
  if (Number.isNaN(time)) {
    return value || '—'
  }
  return new Date(time).toLocaleString('zh-CN', { hour12: false })
}

function patternCurve(pattern: SnapshotPattern): string {
  const pick = (day: number) =>
    pattern.curve.find((point) => point.day === day)?.retentionRate ?? 0
  return `${formatPercent(pick(1))} / ${formatPercent(pick(3))} / ${formatPercent(pick(7))}`
}

function reload() {
  snapshots.value = listSnapshots()
  receipts.value = listConflictReceipts()
  tickets.value = listIsolationTickets()
  checklists.value = listReviewChecklists()
  current.value = snapshots.value.find((item) => item.status === 'current') ?? null
  dataviewOptions.value = listEntries('dataview').items
  const view = retentionSnapshotView(selectedCode.value)
  missingSnapshot.value = view.missing
  checks.value = view.checks
}

function syncFromRoute() {
  selectedCode.value = parseSnapshotQuery(route.query)
  reload()
}

function selectSnapshot(code: string) {
  router.replace({ query: { ...route.query, snapshot: code } })
}

function backToCurrent() {
  const query = { ...route.query }
  delete query.snapshot
  router.replace({ query })
}

function copyShareLink() {
  if (!shareLink.value) {
    return
  }
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(shareLink.value)
  }
}

function resultKey(): number {
  resultSeq.value += 1
  return resultSeq.value
}

function pushResult(label: string, result: PublishResult) {
  results.value = [{ key: resultKey(), label, result }, ...results.value].slice(0, 12)
}

// datetime-local 是本地时间，发布服务按 ISO 比较请求先后。
function requestedAtIso(): string {
  if (!requestedAtText.value) {
    return ''
  }
  const parsed = new Date(requestedAtText.value)
  return Number.isNaN(parsed.getTime()) ? requestedAtText.value : parsed.toISOString()
}

function baseRequest(overrides: Partial<{
  publisher: string
  role: 'owner' | 'editor'
  requestedAt: string
  requestId: string
}> = {}) {
  return {
    retentionCode: normalizeRetentionCode(retentionCode.value),
    dataviewCode: dataviewCode.value,
    publisher: overrides.publisher ?? (publisher.value.trim() || store.operator),
    role: overrides.role ?? role.value,
    policy: policy.value,
    requestedAt: overrides.requestedAt ?? requestedAtIso(),
    requestId: overrides.requestId,
  }
}

function publish() {
  setArbitrationPolicy(policy.value)
  const result = publishRetentionSnapshot(baseRequest())
  pushResult(`${result.snapshot?.code ?? retentionCode.value} · ${roleLabel(role.value)}`, result)
  reload()
  emit('changed')
}

function simulateSimultaneous() {
  setArbitrationPolicy(policy.value)
  const requestedAt = requestedAtIso() || new Date().toISOString()
  const ownerName = publisher.value.trim() || store.operator
  const first = publishRetentionSnapshot(
    baseRequest({ publisher: ownerName, role: 'owner', requestedAt }),
  )
  const second = publishRetentionSnapshot(
    baseRequest({ publisher: `${ownerName}-协作者`, role: 'editor', requestedAt }),
  )
  pushResult('同时保存 · 请求A', first)
  pushResult('同时保存 · 请求B', second)
  reload()
  emit('changed')
}

function simulateLateSave() {
  setArbitrationPolicy(policy.value)
  const requestedAt = new Date(Date.now() + 60_000).toISOString()
  const result = publishRetentionSnapshot(
    baseRequest({
      publisher: `${publisher.value.trim() || store.operator}-协作者`,
      role: 'editor',
      requestedAt,
    }),
  )
  pushResult(`迟到保存 · ${policyLabel(policy.value)}`, result)
  reload()
  emit('changed')
}

function resubmitLast() {
  setArbitrationPolicy(policy.value)
  const last = results.value[0]?.result
  const requestedAt = new Date().toISOString()
  const result = publishRetentionSnapshot(
    baseRequest({
      publisher: last?.snapshot?.publisher ?? (publisher.value.trim() || store.operator),
      role: last?.snapshot?.publisherRole ?? role.value,
      requestedAt,
    }),
  )
  pushResult('重复提交', result)
  reload()
  emit('changed')
}

watch(() => route.query, syncFromRoute)

// 本地数据是同步的：setup 阶段就读一次，首屏直接显示冻结快照，不依赖 onMounted。
reload()
onMounted(reload)
</script>
