import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  AdminCleanupId,
  AdminCleanupItem,
  CleanupItemDef,
  CleanupScope,
  CleanupTargetId,
  ResidueBackup,
  ResidueItem
} from '../../../shared/types'

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

/** 残留类别的短标签 */
const KIND_LABEL: Record<ResidueItem['kind'], string> = {
  uninstall: '注册表',
  shortcut: '快捷方式',
  folder: '文件夹'
}

function timeText(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 第三组：卸载残留（SPEC-space-residue）。
 *
 * 与两组缓存不同，这里删掉的是「别的东西」：失效的卸载注册项、指向空处的快捷方式、
 * 只剩死链的开始菜单文件夹。所以默认一项都不勾，清理一律先进备份区，并能一键撤销。
 */
function ResiduePanel(): ReactElement {
  /** null = 还没扫描过；[] = 扫过但没有残留 */
  const [items, setItems] = useState<ResidueItem[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [backups, setBackups] = useState<ResidueBackup[]>([])
  const [backupBusy, setBackupBusy] = useState('')
  /** 正在等二次确认「删除备份」的批次 id；删除不可恢复，所以要按两下 */
  const [confirmDiscard, setConfirmDiscard] = useState('')

  const loadBackups = useCallback(async (): Promise<void> => {
    try {
      setBackups(await window.island.residueBackups())
    } catch {
      /* 备份列表读不到不影响扫描；留着上一次的结果 */
    }
  }, [])

  /** 只重扫列表，不动提示行（撤销/清理后由调用方决定写什么提示） */
  const refreshItems = useCallback(async (): Promise<void> => {
    const r = await window.island.residueScan()
    setItems(r.items)
    setSelected(new Set())
  }, [])

  const scan = useCallback(async (): Promise<void> => {
    setScanning(true)
    setConfirmDiscard('')
    setNote('')
    try {
      const r = await window.island.residueScan()
      setItems(r.items)
      setSelected(new Set())
      setNote(
        r.warnings.length > 0
          ? r.warnings.join(' ')
          : r.items.length === 0
            ? '没有发现卸载残留。'
            : ''
      )
    } catch {
      setNote('扫描失败，请稍后再试。')
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    void scan()
    void loadBackups()
  }, [scan, loadBackups])

  const list = items ?? []
  const selectedBytes = list
    .filter((i) => selected.has(i.id))
    .reduce((n, i) => n + i.bytes, 0)

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const run = async (): Promise<void> => {
    if (busy || scanning || selected.size === 0) return
    setBusy(true)
    setNote('正在清理…')
    try {
      const r = await window.island.residueClean([...selected])
      setItems(r.scan.items)
      setSelected(new Set())
      const head =
        r.removed > 0
          ? `已清理 ${r.removed} 项${r.freedBytes > 0 ? `，腾出 ${formatBytes(r.freedBytes)}` : ''}；可以撤销。`
          : '这次没有清理任何项。'
      setNote([head, ...r.warnings].filter(Boolean).join(' '))
      if (r.backupId) await loadBackups()
    } catch {
      setNote('清理失败，请稍后再试。')
    } finally {
      setBusy(false)
    }
  }

  const undo = async (id: string): Promise<void> => {
    if (backupBusy) return
    setConfirmDiscard('')
    setBackupBusy(id)
    setNote('正在撤销…')
    try {
      const r = await window.island.residueUndo(id)
      setBackups(r.backups)
      await refreshItems()
      setNote(r.ok ? ['已撤销这批备份。', ...r.warnings].join(' ') : r.warnings.join(' '))
    } catch {
      setNote('撤销失败，请稍后再试。')
    } finally {
      setBackupBusy('')
    }
  }

  const discard = async (id: string): Promise<void> => {
    if (backupBusy) return
    // 第一下只是把按钮换成「确认删除」，第二下才真删（删除不可恢复）
    if (confirmDiscard !== id) {
      setConfirmDiscard(id)
      setNote('再点一次「确认删除」就会永久删除这批备份，不能恢复。')
      return
    }
    setConfirmDiscard('')
    setBackupBusy(id)
    setNote('正在删除备份…')
    try {
      const r = await window.island.residueDiscardBackup(id)
      setBackups(r.backups)
      setNote(r.ok ? '备份已删除。' : r.warnings.join(' '))
    } catch {
      setNote('删除备份失败，请稍后再试。')
    } finally {
      setBackupBusy('')
    }
  }

  return (
    <div className="clean-group">
      <div className="clean-group-head">
        <h3 className="clean-group-title">卸载残留</h3>
        <p className="clean-lead">
          已经卸载、但还剩注册表项或快捷方式的软件。只扫当前用户，不需要管理员；清理一律先进备份区，可以撤销。
        </p>
      </div>
      <div className="set-card">
        {items === null ? <div className="clean-empty">正在扫描…</div> : null}
        {items !== null && list.length === 0 ? (
          <div className="clean-empty">没有发现卸载残留。</div>
        ) : null}
        {list.map((item) => {
          const on = selected.has(item.id)
          return (
            <button
              key={item.id}
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-label={item.label}
              className={`clean-row${on ? ' on' : ''}`}
              disabled={busy || scanning}
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
                <span className="clean-name">
                  {item.label}
                  <span className="clean-badge">{KIND_LABEL[item.kind]}</span>
                </span>
                <span className="clean-hint">{item.detail}</span>
              </span>
              <span className="clean-size">{item.bytes > 0 ? formatBytes(item.bytes) : '—'}</span>
            </button>
          )
        })}
      </div>
      <div className="set-note clean-note">{note}</div>
      <div className="clean-foot">
        <div className="clean-total">
          已选 <b>{selected.size}</b> 项 · 合计 <b>{formatBytes(selectedBytes)}</b>
        </div>
        <div className="clean-actions">
          <button
            type="button"
            className="set-btn set-btn-quiet"
            disabled={busy || scanning}
            onClick={() => {
              void scan()
            }}
          >
            {scanning ? '扫描中…' : '重新扫描'}
          </button>
          <button
            type="button"
            className="set-btn set-btn-primary"
            disabled={busy || scanning || selected.size === 0}
            onClick={() => {
              void run()
            }}
          >
            {busy ? '处理中…' : '清理选中项'}
          </button>
        </div>
      </div>

      <div className="residue-backups">
        <div className="residue-backups-head">
          <h4 className="clean-group-title">备份与撤销</h4>
          <span className="clean-hint">清理的项先放在这里，撤销会搬回原位置、注册表也会导回。</span>
        </div>
        {backups.length === 0 ? <div className="clean-empty">还没有备份。</div> : null}
        {backups.map((b) => (
          <div className="residue-backup-row" key={b.id}>
            <span className="residue-backup-meta">
              {timeText(b.createdAt)} · {b.files + b.registry} 项
              {b.bytes > 0 ? ` · ${formatBytes(b.bytes)}` : ''}
              {b.restored ? ' · 已撤销' : ''}
            </span>
            <span className="residue-backup-actions">
              <button
                type="button"
                className="set-btn set-btn-quiet"
                disabled={b.restored || Boolean(backupBusy)}
                onClick={() => {
                  void undo(b.id)
                }}
              >
                {backupBusy === b.id ? '处理中…' : '撤销'}
              </button>
              <button
                type="button"
                className="set-btn set-btn-quiet"
                disabled={Boolean(backupBusy)}
                onClick={() => {
                  void discard(b.id)
                }}
              >
                {confirmDiscard === b.id ? '确认删除' : '删除备份'}
              </button>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * 第四组：系统清理（需要管理员，SPEC-space-admin-cleanup）。
 *
 * 扫描不提权；点清理才会弹一次 UAC。拒绝授权就什么都别删——
 * 这一组删的是系统目录，宁可多一次确认。
 */
function AdminPanel(): ReactElement {
  const [items, setItems] = useState<AdminCleanupItem[] | null>(null)
  const [selected, setSelected] = useState<Set<AdminCleanupId>>(new Set())
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  const applyScan = (list: AdminCleanupItem[]): void => {
    setItems(list)
    setSelected(new Set(list.filter((i) => i.defaultChecked).map((i) => i.id)))
  }

  const scan = useCallback(async (): Promise<void> => {
    setScanning(true)
    setNote('')
    try {
      const r = await window.island.adminCleanupScan()
      applyScan(r.items)
    } catch {
      setNote('扫描失败，请稍后再试。')
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    void scan()
  }, [scan])

  const list = items ?? []
  const selectedKnown = list
    .filter((i) => selected.has(i.id) && i.known)
    .reduce((n, i) => n + i.bytes, 0)

  const toggle = (id: AdminCleanupId): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const run = async (): Promise<void> => {
    if (busy || scanning || selected.size === 0) return
    // 勾了看不到大小的项（传递优化缓存）：清理后说明一句「它不统计大小」，
    // 免得「没有释放量」被理解成没清
    const unknownPicked = list.filter((i) => selected.has(i.id) && !i.known).map((i) => i.label)
    setBusy(true)
    setNote('正在等待管理员授权…')
    try {
      const r = await window.island.adminCleanupRun([...selected])
      applyScan(r.scan.items)
      if (r.canceled) {
        setNote('已取消管理员授权，没有删除任何东西。')
      } else {
        const parts: string[] = [
          r.freedBytes > 0 ? `已释放 ${formatBytes(r.freedBytes)}。` : '清理完成。'
        ]
        if (unknownPicked.length > 0) {
          parts.push(`${unknownPicked.join('、')}交给系统接口清理，不统计大小。`)
        }
        setNote([...parts, ...r.warnings].filter(Boolean).join(' '))
      }
    } catch {
      setNote('清理失败，请稍后再试。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="clean-group">
      <div className="clean-group-head">
        <h3 className="clean-group-title">系统清理（需要管理员）</h3>
        <p className="clean-lead">
          这些目录普通权限删不动。浏览和扫描不会弹窗；点「清理选中项」时系统会弹一次管理员授权，拒绝则什么都不删。
        </p>
      </div>
      <div className="set-card">
        {items === null ? <div className="clean-empty">正在读取…</div> : null}
        {list.map((item) => {
          const on = selected.has(item.id)
          return (
            <button
              key={item.id}
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-label={item.label}
              className={`clean-row${on ? ' on' : ''}`}
              disabled={busy || scanning}
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
              {/* 「无法统计」说的是大小，不是「要管理员才能用」——这一组本来就要管理员，
                  写成「需管理员」会让人以为点了没生效 */}
              <span className="clean-size">{item.known ? formatBytes(item.bytes) : '无法统计'}</span>
            </button>
          )
        })}
      </div>
      <div className="set-note clean-note">{note}</div>
      <div className="clean-foot">
        <div className="clean-total">
          已选 <b>{selected.size}</b> 项 · 可计算占用 <b>{formatBytes(selectedKnown)}</b>
        </div>
        <div className="clean-actions">
          <button
            type="button"
            className="set-btn set-btn-quiet"
            disabled={busy || scanning}
            onClick={() => {
              void scan()
            }}
          >
            {scanning ? '读取中…' : '重新读取'}
          </button>
          <button
            type="button"
            className="set-btn set-btn-primary"
            disabled={busy || scanning || selected.size === 0}
            onClick={() => {
              void run()
            }}
          >
            {busy ? '等待授权…' : '清理选中项'}
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
      <ResiduePanel />
      <AdminPanel />
    </section>
  )
}
