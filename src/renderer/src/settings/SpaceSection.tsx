import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { CleanupItemDef, CleanupScope, CleanupTargetId } from '../../../shared/types'

/**
 * 设置「空间」页（SPEC-space-cleanup / SPEC-space-system-junk）。
 *
 * 两组：灵动岛自己的缓存、系统垃圾。清单与路径全部在主进程
 * `cleanupStore.ts` 里写死，这里只负责展示、勾选和发 scope + id——
 * 页面上不存在「传路径」的入口，避免清理功能被页面错误驱动。
 *
 * 扫描是「先出骨架、再逐项填数字」：%TEMP% 大的机器递归统计要好几秒，
 * 如果等全部算完再渲染，整组会长时间停在「正在计算占用…」。现在先拿到清单
 * 立即渲染，每项算出大小就替换成实际数字，慢的那项自己转「计算中…」。
 */

function formatBytes(n: number): string {
  if (n <= 0) return '无'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 页面上的一行：定义来自主进程，bytes=null 表示这一项还在计算 */
interface Row extends CleanupItemDef {
  bytes: number | null
}

interface PanelProps {
  scope: CleanupScope
  title: string
  lead: string
}

/** 一组清理项：独立的扫描结果、勾选、提示与按钮 */
function CleanupPanel({ scope, title, lead }: PanelProps): ReactElement {
  const [rows, setRows] = useState<Row[]>([])
  const [selected, setSelected] = useState<Set<CleanupTargetId>>(new Set())
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  /** 全量扫描：先出清单，再并行逐项取大小 */
  const refresh = useCallback(async (): Promise<void> => {
    setScanning(true)
    setNote('')
    try {
      const defs = await window.island.cleanupItems(scope)
      setRows(defs.map((d) => ({ ...d, bytes: null })))
      setSelected(new Set(defs.filter((d) => d.defaultChecked).map((d) => d.id)))
      await Promise.all(
        defs.map(async (d) => {
          let bytes = 0
          try {
            bytes = await window.island.cleanupScanItem(scope, d.id)
          } catch {
            bytes = 0
          }
          setRows((prev) => prev.map((r) => (r.id === d.id ? { ...r, bytes } : r)))
          // 算出来是 0 的项自动取消勾选，避免把空项算进「已选」
          if (bytes === 0) {
            setSelected((prev) => {
              if (!prev.has(d.id)) return prev
              const next = new Set(prev)
              next.delete(d.id)
              return next
            })
          }
        })
      )
    } catch {
      setNote('读取占用失败，请稍后再试。')
    } finally {
      setScanning(false)
    }
  }, [scope])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const totalBytes = rows.reduce((n, r) => n + (r.bytes ?? 0), 0)
  const selectedBytes = rows
    .filter((r) => selected.has(r.id))
    .reduce((n, r) => n + (r.bytes ?? 0), 0)

  const toggle = (id: CleanupTargetId): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const run = async (): Promise<void> => {
    if (busy || scanning || selectedBytes === 0) return
    setBusy(true)
    // 不清空提示：提示区固定占一行，原地换成「正在清理…」，避免整块底部在点击瞬间上下跳
    setNote('正在清理…')
    const ids = [...selected]
    try {
      const res = await window.island.cleanupRun(scope, ids)
      const afterById = new Map(res.scan.items.map((i) => [i.id, i]))
      setRows((prev) =>
        prev.map((r) => (afterById.has(r.id) ? { ...r, bytes: afterById.get(r.id)?.bytes ?? 0 } : r))
      )
      setSelected(
        new Set(
          res.scan.items.filter((i) => i.defaultChecked && i.bytes > 0).map((i) => i.id)
        )
      )
      const head = res.freedBytes > 0 ? `已释放 ${formatBytes(res.freedBytes)}。` : '这次没有释放出空间。'
      // 网页缓存是程序运行时会马上重新写入的，清完再看又有一点属正常，别让用户以为没清掉
      const webLeft =
        ids.includes('web-cache') && (res.scan.items.find((i) => i.id === 'web-cache')?.bytes ?? 0) > 0
      const tail = webLeft ? '网页缓存会随使用重新生成，刚清完又出现少量是正常的。' : ''
      setNote([head, ...res.warnings, tail].filter(Boolean).join(' '))
    } catch {
      setNote('清理失败，请稍后再试。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="clean-group">
      <div className="clean-group-head">
        <h3 className="clean-group-title">{title}</h3>
        <p className="clean-lead">{lead}</p>
      </div>
      <div className="set-card">
        {rows.length === 0 ? (
          <div className="clean-empty">
            {scanning ? '正在读取清理项…' : '暂时读不到清理项，点「重新计算」再试。'}
          </div>
        ) : null}
        {rows.map((row) => {
          const on = selected.has(row.id)
          const known = row.bytes !== null
          return (
            <button
              key={row.id}
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-label={row.label}
              className={`clean-row${on ? ' on' : ''}`}
              disabled={busy || !known || row.bytes === 0}
              onClick={() => toggle(row.id)}
            >
              <span className="clean-check" aria-hidden="true">
                {on ? (
                  <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M2.4 6.2 5 8.7l4.6-5.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : null}
              </span>
              <span className="clean-text">
                <span className="clean-name">{row.label}</span>
                <span className="clean-hint">{row.hint}</span>
              </span>
              <span className="clean-size">{known ? formatBytes(row.bytes ?? 0) : '计算中…'}</span>
            </button>
          )
        })}
      </div>
      {/* 提示区始终占位（.clean-note 有最小高度）：反复清理时底部按钮不会因为
          提示出现/消失而上下移动，避免在鼠标底下跳动 */}
      <div className="set-note clean-note">{note}</div>
      <div className="clean-foot">
        <div className="clean-total">
          可清理 <b>{formatBytes(totalBytes)}</b> · 已选 <b>{formatBytes(selectedBytes)}</b>
          {scanning ? <span className="clean-pending">（计算中…）</span> : null}
        </div>
        <div className="clean-actions">
          <button
            type="button"
            className="set-btn set-btn-quiet"
            disabled={busy || scanning}
            onClick={() => {
              void refresh()
            }}
          >
            重新计算
          </button>
          <button
            type="button"
            className="set-btn set-btn-primary"
            disabled={busy || scanning || selectedBytes === 0}
            onClick={() => {
              void run()
            }}
          >
            {busy ? '处理中…' : scanning ? '计算中…' : '清理选中项'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function SpaceSection(): ReactElement {
  return (
    <section className="set-page">
      <h2 className="set-page-title">空间</h2>
      <CleanupPanel
        scope="app"
        title="灵动岛的缓存"
        lead="只清理灵动岛自己产生的缓存和日志。待办、日程、置物架和设置都存在别处，这里绝不会动。"
      />
      <CleanupPanel
        scope="system"
        title="系统垃圾"
        lead="Windows 和其他软件留下的临时文件。这一组不需要管理员权限，正在使用的文件会自动跳过。"
      />
    </section>
  )
}
