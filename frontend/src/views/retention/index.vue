<template>
  <section class="page" data-module="retention">
    <header class="page-head">
      <div>
        <h2>回访分析管理</h2>
        <p class="page-desc">分析用户回访行为模式，计算粘性指数和流失周期。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记回访模式</button>
        <button class="btn" type="button" @click="exportRows">导出回访分析清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <div class="frozen-strip">
      <span>当前冻结快照：{{ frozen.snapshot?.code ?? '尚未发布' }}</span>
      <span>回访曲线：{{ frozen.snapshot ? curveSummary(frozen.snapshot.curve) : '—' }}</span>
      <span>回访周期：{{ frozen.snapshot ? `${frozen.snapshot.cycleDays} 天` : '—' }}</span>
      <span>粘性指数：{{ frozen.snapshot?.stickinessIndex ?? '—' }}</span>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无回访分析数据，可先登记回访模式</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条回访分析记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <RetentionSnapshotFlow surface="retention" @changed="onSnapshotChanged" />
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { retentionSnapshotView } from '@/api/snapshot-service'
import RetentionSnapshotFlow from '@/components/RetentionSnapshotFlow.vue'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('retention')
const columns = ["模式编号", "用户分群", "首次访问窗口", "回访周期天", "回访频次", "粘性指数", "流失周期", "唤醒策略"]
const actions = ["发起分析", "确认模式", "归档模式"]
const statuses = ["草稿", "分析中", "已确认", "已归档"]
const stats = [{"label": "回访模式总数", "value": 0}, {"label": "已确认模式", "value": 0}, {"label": "分析中模式", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 列表上方先显示当前冻结快照的指标：页面刷新后曲线、周期和粘性指数都以快照为准。
const frozen = ref<ReturnType<typeof retentionSnapshotView>>({ snapshot: null, missing: false, checks: [] })

// 本地数据是同步的：setup 阶段就载入，首屏即显示冻结指标，刷新后也先读快照。
reload()
refreshFrozen()

function resetFilters() {
  filters.value = {}
  reload()
}

function curveSummary(curve: { day: number; retentionRate: number }[]): string {
  return [1, 3, 7, 14]
    .map((day) => {
      const point = curve.find((item) => item.day === day)
      return point ? `D${day} ${(point.retentionRate * 100).toFixed(1)}%` : `D${day} —`
    })
    .join(' / ')
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '回访模式登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '回访分析列表读取失败'
  }
}

// 快照发布后重新算一次冻结指标，避免页面还显示发布前的曲线。
function refreshFrozen() {
  frozen.value = retentionSnapshotView()
}

function onSnapshotChanged() {
  reload()
  refreshFrozen()
}

// 本地数据是同步的：setup 阶段就载入，首屏即显示冻结指标，刷新后也先读快照。
reload()
refreshFrozen()

</script>
