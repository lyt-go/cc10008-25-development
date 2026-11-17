<template>
  <section class="page" data-module="dataview">
    <header class="page-head">
      <div>
        <h2>数据视图管理</h2>
        <p class="page-desc">管理可定制和分享的数据分析视图，组合多个数据源、过滤条件和度量。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记分析视图</button>
        <button class="btn" type="button" @click="exportRows">导出数据视图清单</button>
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
          <th v-for="column in snapshotColumns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td v-for="column in snapshotColumns" :key="column">{{ row[column] ?? '—' }}</td>
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
          <td :colspan="columns.length + snapshotColumns.length + 2" class="empty-state">暂无数据视图数据，可先登记分析视图</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条数据视图记录</span>
      <span>回访曲线取自冻结快照 {{ manifestSnapshotCode }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <RetentionSnapshotFlow surface="dataview" @changed="reload" />
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import {
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { loadDataViewManifest, parseSnapshotQuery } from '@/api/snapshot-service'
import RetentionSnapshotFlow from '@/components/RetentionSnapshotFlow.vue'
import type { DataViewManifestRow, EntryRow } from '@/data/types'

const meta = moduleMeta('dataview')
const columns = ["视图编号", "视图名称", "数据源组合", "过滤条件集", "维度选择", "度量选择", "排序规则", "分享链接"]
// 回访列由冻结快照提供，页面不再直接读回访模式的实时行。
const snapshotColumns = ["回访模式", "回访曲线", "回访周期", "粘性指数", "回访视图快照来源", "快照冻结状态"]
const actions = ["提交视图评审", "保存视图", "删除视图"]
const statuses = ["草稿", "视图评审中", "已保存", "已删除"]
const stats = [{"label": "分析视图总数", "value": 0}, {"label": "已保存视图", "value": 0}, {"label": "评审中视图", "value": 0}]

const route = useRoute()
const rows = ref<DataViewManifestRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const manifestSnapshotCode = ref('')
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  errorMessage.value = ''
  try {
    const manifest = loadDataViewManifest(parseSnapshotQuery(route.query))
    const header = ['编号', ...meta.fields, ...snapshotColumns, '当前状态']
    const lines = [header.join(',')]
    for (const row of manifest.rows) {
      lines.push(
        [
          row.id,
          ...meta.fields.map((field) => row[field] ?? ''),
          ...snapshotColumns.map((field) => row[field] ?? ''),
          row.status,
        ].join(','),
      )
    }
    // 加 BOM，和 local-service 导出的清单保持同一种 Excel 打开方式。
    const content = `﻿${lines.join('\n')}`
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${meta.name}-清单.csv`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '数据视图清单导出失败'
  }
}

function openCreate() {
  errorMessage.value = '分析视图登记入口尚未接入审批流'
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
    const manifest = loadDataViewManifest(parseSnapshotQuery(route.query))
    manifestSnapshotCode.value = manifest.snapshot
      ? `${manifest.snapshot.code}（${manifest.snapshot.status === 'current' ? '当前冻结版本' : '历史冻结版本'}）`
      : manifest.requestedSnapshotCode
        ? `缺失 ${manifest.requestedSnapshotCode}`
        : '尚未发布'
    rows.value = filterRows(manifest.rows, filters.value)
    total.value = rows.value.length
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '数据视图列表读取失败'
  }
}

// 清单的行来自冻结快照，过滤仍沿用 local-service 的字段包含匹配口径。
function filterRows(source: DataViewManifestRow[], current: Record<string, string>): DataViewManifestRow[] {
  const pairs = Object.entries(current).filter(([, value]) => value.trim() !== '')
  if (!pairs.length) {
    return source
  }
  return source.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

// 清单来自冻结快照：setup 阶段就读一次，刷新页面后首屏展示的仍是同一份冻结曲线。
reload()
watch(() => route.query, reload)
</script>
