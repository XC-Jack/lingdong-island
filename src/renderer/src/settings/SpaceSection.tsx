import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { CleanupScanResult, CleanupTargetId } from '../../../shared/types'

/**
 * 设置「空间」页（SPEC-space-cleanup）。
 *
 * 第一阶段只清灵动岛自己的缓存和日志。清单与路径全部在主进程
 * `cleanupStore.ts` 里写死，这里只负责展示、勾选和发 id——
 * 页面上不存在「传路径」的入口，避免清理功能被页面错误驱动。
 */

function formatBytes(n: number): string {
  if (n <= 0) return '无'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export default function SpaceSection(): ReactElement {
  const [scan, setScan] = useState<CleanupScanResult | null>(null)
  const [selected, setSelected] = useState<Set<CleanupTargetId>>(new Set())
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  /** 扫描结果落地时，把勾选重置为「默认勾选且有内容」——清理后不会残留空选项 */
  const applyScan = useCallback((r: CleanupScanResult): void => {
    setScan(r)
    setSelected(
      new Set(
        r.items
          .filter((i) => i.defaultChecked && i.bytes > 0)
          .map((i) => i.id)
      )
    )
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      applyScan(await window.island.cleanupScan())
    } catch {
      setNote('读取占用失败，请稍后再试。')
    } finally {
      setBusy(false)
    }
  }, [applyScan])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const items = scan?.items ?? []
  const totalBytes = scan?.totalBytes ?? 0
  const selectedBytes = items
    .filter((i) => selected.has(i.id))
    .reduce((n, i) => n + i.bytes, 0)

  const toggle = (id: CleanupTargetId): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const run = async (): Promise<void> => {
    if (busy || selectedBytes === 0) return
    setBusy(true)
    setNote('')
    const ids = [...selected]
    try {
      const res = await window.island.cleanupRun(ids)
      applyScan(res.scan)
      const head = res.freedBytes > 0 ? `已释放 ${formatBytes(res.freedBytes)}。` : '这次没有释放出空间。'
      // 网页缓存是程序运行时会马上重新写入的，清完再看又有一点属正常，别让用户以为没清掉
      const webLeft = ids.includes('web-cache') && (res.scan.items.find((i) => i.id === 'web-cache')?.bytes ?? 0) > 0
      const tail = webLeft ? '网页缓存会随使用重新生成，刚清完又出现少量是正常的。' : ''
      setNote([head, ...res.warnings, tail].filter(Boolean).join(' '))
    } catch {
      setNote('清理失败，请稍后再试。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="set-page">
      <h2 className="set-page-title">空间</h2>
      <p className="clean-lead">
        只清理灵动岛自己产生的缓存和日志。待办、日程、置物架和设置都存在别处，这里绝不会动。
      </p>
      <div className="set-card">
        {scan === null ? <div className="clean-empty">正在计算占用…</div> : null}
        {items.map((item) => {
          const on = selected.has(item.id)
          return (
            <button
              key={item.id}
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-label={item.label}
              className={`clean-row${on ? ' on' : ''}`}
              disabled={busy || item.bytes === 0}
              onClick={() => toggle(item.id)}
            >
              <span className="clean-check" aria-hidden="true">
                {on ? (
                  <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M2.4 6.2 5 8.7l4.6-5.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : null}
              </span>
              <span className="clean-text">
                <span className="clean-name">{item.label}</span>
                <span className="clean-hint">{item.hint}</span>
              </span>
              <span className="clean-size">{formatBytes(item.bytes)}</span>
            </button>
          )
        })}
      </div>
      {note ? <div className="set-note">{note}</div> : null}
      <div className="clean-foot">
        <div className="clean-total">
          可清理 <b>{formatBytes(totalBytes)}</b> · 已选 <b>{formatBytes(selectedBytes)}</b>
        </div>
        <div className="clean-actions">
          <button
            type="button"
            className="set-btn set-btn-quiet"
            disabled={busy}
            onClick={() => {
              void refresh()
            }}
          >
            重新计算
          </button>
          <button
            type="button"
            className="set-btn set-btn-primary"
            disabled={busy || selectedBytes === 0}
            onClick={() => {
              void run()
            }}
          >
            {busy ? '处理中…' : '清理选中项'}
          </button>
        </div>
      </div>
    </section>
  )
}
