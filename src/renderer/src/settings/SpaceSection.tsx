import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  AdminCleanupId,
  CleanupItemDef,
  CleanupScope,
  CleanupTargetId,
  ResidueBackup,
  ResidueItem,
  SoftwareResidueItem
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
  /** 条目是否真实存在（回收站空文件夹：0 字节但仍可选） */
  exists: boolean
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
  /** 已勾选「默认不勾」的项，正在等第二次点击；勾选一变就作废 */
  const [confirming, setConfirming] = useState(false)

  /** 全量扫描：先出清单，再并行逐项取大小 */
  const refresh = useCallback(async (): Promise<void> => {
    setScanning(true)
    setConfirming(false)
    setNote('')
    try {
      const defs = await window.island.cleanupItems(scope)
      setRows(defs.map((d) => ({ ...d, bytes: null, exists: false })))
      setSelected(new Set(defs.filter((d) => d.defaultChecked).map((d) => d.id)))
      await Promise.all(
        defs.map(async (d) => {
          let bytes = 0
          let exists = false
          try {
            const scan = await window.island.cleanupScanItem(scope, d.id)
            bytes = scan.bytes
            exists = scan.exists
          } catch {
            bytes = 0
          }
          setRows((prev) => prev.map((r) => (r.id === d.id ? { ...r, bytes, exists } : r)))
          // 算出来是 0 且确实没东西的项自动取消勾选，避免把空项算进「已选」
          if (bytes === 0 && !exists) {
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

  /** 已选中的「默认不勾」项：删除不可恢复，要先问一句 */
  const risky = rows.filter((r) => selected.has(r.id) && !r.defaultChecked)

  const toggle = (id: CleanupTargetId): void => {
    // 选择变了，之前的确认就不再代表用户当前的选择；对应的提示也一起撤掉
    if (confirming) setNote('')
    setConfirming(false)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const run = async (): Promise<void> => {
    // 注意：不能按「已选字节为 0」拦，回收站里的空文件夹是 0 字节但可清理
    if (busy || scanning || selected.size === 0) return
    // 第一次只提示，第二次才执行；勾选变化会把 confirming 置回 false
    if (risky.length > 0 && !confirming) {
      setConfirming(true)
      setNote(
        `已选「${risky.map((r) => r.label).join('、')}」，默认不勾选，删除后不能恢复。再点一次「确认清理」才会执行。`
      )
      return
    }
    setConfirming(false)
    setBusy(true)
    // 不清空提示：提示区固定占一行，原地换成「正在清理…」，避免整块底部在点击瞬间上下跳
    setNote('正在清理…')
    const ids = [...selected]
    try {
      const res = await window.island.cleanupRun(scope, ids)
      const afterById = new Map(res.scan.items.map((i) => [i.id, i]))
      setRows((prev) =>
        prev.map((r) => {
          const hit = afterById.get(r.id)
          return hit ? { ...r, bytes: hit.bytes ?? 0, exists: hit.exists } : r
        })
      )
      setSelected(
        new Set(
          res.scan.items
            .filter((i) => i.defaultChecked && (i.bytes > 0 || i.exists))
            .map((i) => i.id)
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
      <div className="clean-list">
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
              disabled={busy || !known || (row.bytes === 0 && !row.exists)}
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
              <span className="clean-size">
                {known ? (row.bytes === 0 && row.exists ? '0 B' : formatBytes(row.bytes ?? 0)) : '计算中…'}
              </span>
            </button>
          )
        })}
      </div>
      {/* 提示区始终占位（.clean-note 有最小高度）：反复清理时底部按钮不会因为
          提示出现/消失而上下移动，避免在鼠标底下跳动 */}
      <div className="set-note clean-note">{note}</div>
      <div className="clean-foot">
        <div className="clean-total">
          可清理 <b>{totalBytes === 0 && rows.some((r) => r.exists) ? '0 B' : formatBytes(totalBytes)}</b> ·
          已选 <b>{selectedBytes === 0 && selected.size > 0 ? '0 B' : formatBytes(selectedBytes)}</b>
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
            disabled={busy || scanning || selected.size === 0}
            onClick={() => {
              void run()
            }}
          >
            {busy ? '处理中…' : scanning ? '计算中…' : confirming ? '确认清理' : '清理选中项'}
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
      // 「没有发现残留」由列表里的空状态说一次就够了，提示行只放警告
      setNote(r.warnings.join(' '))
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
      // 残留清理是「移入备份」，同一块盘上并没有腾出空间；别写「释放」误导用户。
      // 想真正腾空间，要在下面的「备份与撤销」里删除这批备份。
      const head =
        r.removed > 0
          ? `已清理 ${r.removed} 项${
              r.movedBytes > 0
                ? `，其中 ${formatBytes(r.movedBytes)} 移进了备份（删除备份后才真正腾出空间）`
                : ''
            }；可以撤销。`
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
    <div className="clean-group clean-part">
      <div className="clean-group-head">
        <h4 className="clean-group-title">卸载残留</h4>
        <p className="clean-lead">
          已经卸载、但还剩注册表项或快捷方式的软件。只扫当前用户，不需要管理员；清理一律先进备份区，可以撤销。
        </p>
      </div>
      <div className="clean-list">
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
 * 系统垃圾：把「不需要管理员」和「需要管理员」合并成一张清单（SPEC-space-merge-junk）。
 *
 * 两类项目本来是一件事，区别只在删的时候要不要授权：普通项清理立即执行；
 * 勾了标「需要管理员」的项，才会在普通项清完之后弹一次 UAC，把要提权的部分交给提权脚本。
 * 取消授权只影响后者，前面的结果照常保留并如实说明。
 */
interface JunkRow {
  id: string
  label: string
  hint: string
  /** 普通项：null = 还在算；管理员项：known=false 表示系统不给大小 */
  bytes: number | null
  known: boolean
  /** 条目真实存在（回收站空文件夹：0 字节但仍可清理） */
  exists: boolean
  admin: boolean
  defaultChecked: boolean
}

function JunkPanel(): ReactElement {
  const [rows, setRows] = useState<JunkRow[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  /** 已勾选「默认不勾」的项，正在等第二次点击；勾选一变就作废 */
  const [confirming, setConfirming] = useState(false)

  /** 全量扫描：先出清单（普通项 + 管理员项），再并行逐项算普通项的大小 */
  const refresh = useCallback(async (): Promise<void> => {
    setScanning(true)
    setConfirming(false)
    setNote('')
    try {
      const [defs, admin] = await Promise.all([
        window.island.cleanupItems('system'),
        window.island.adminCleanupScan()
      ])
      const normalRows: JunkRow[] = defs.map((d) => ({
        id: d.id,
        label: d.label,
        hint: d.hint,
        bytes: null,
        known: true,
        exists: false,
        admin: false,
        defaultChecked: d.defaultChecked
      }))
      const adminRows: JunkRow[] = admin.items.map((i) => ({
        id: i.id,
        label: i.label,
        hint: i.hint,
        bytes: i.known ? i.bytes : null,
        known: i.known,
        exists: false,
        admin: true,
        defaultChecked: i.defaultChecked
      }))
      const all = [...normalRows, ...adminRows]
      setRows(all)
      setSelected(
        new Set(all.filter((r) => r.defaultChecked && (r.bytes !== 0 || r.exists)).map((r) => r.id))
      )
      await Promise.all(
        defs.map(async (d) => {
          let bytes = 0
          let exists = false
          try {
            const scan = await window.island.cleanupScanItem('system', d.id)
            bytes = scan.bytes
            exists = scan.exists
          } catch {
            bytes = 0
          }
          setRows((prev) => prev.map((r) => (r.id === d.id ? { ...r, bytes, exists } : r)))
          // 算出来是 0 且确实没东西的项自动取消勾选，避免把空项算进「已选」
          if (bytes === 0 && !exists) {
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
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const totalBytes = rows.reduce((n, r) => n + (r.bytes ?? 0), 0)
  const selectedRows = rows.filter((r) => selected.has(r.id))
  const selectedBytes = selectedRows.reduce((n, r) => n + (r.bytes ?? 0), 0)
  const adminPicked = selectedRows.some((r) => r.admin)
  /** 已选中的「默认不勾」项（回收站）：删除不可恢复，要先问一句 */
  const risky = selectedRows.filter((r) => !r.defaultChecked)

  const toggle = (id: string): void => {
    // 选择变了，之前的确认就不再代表用户当前的选择；对应的提示也一起撤掉
    if (confirming) setNote('')
    setConfirming(false)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 用清理后的扫描结果就地更新大小；known=false 的项回到「无法统计」 */
  const applySizes = (
    list: Array<{ id: string; bytes: number; known?: boolean; exists?: boolean }>
  ): void => {
    const by = new Map(list.map((i) => [i.id, i]))
    setRows((prev) =>
      prev.map((r) => {
        const hit = by.get(r.id)
        if (!hit) return r
        return hit.known === false
          ? { ...r, bytes: null, known: false, exists: false }
          : { ...r, bytes: hit.bytes, known: true, exists: hit.exists ?? hit.bytes > 0 }
      })
    )
  }

  /** 清完变成 0 的项退出勾选，避免下次把空项一起提交 */
  const clearEmpty = (
    list: Array<{ id: string; bytes: number; known?: boolean; exists?: boolean }>
  ): void => {
    // 0 字节但条目还在（回收站空文件夹）不算空，继续留在勾选里
    const zero = new Set(
      list.filter((i) => (i.known ?? true) && i.bytes === 0 && !i.exists).map((i) => i.id)
    )
    if (zero.size === 0) return
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of zero) next.delete(id)
      return next
    })
  }

  const run = async (): Promise<void> => {
    if (busy || scanning || selected.size === 0) return
    // 第一次只提示，第二次才执行；勾选变化会把 confirming 置回 false
    if (risky.length > 0 && !confirming) {
      setConfirming(true)
      setNote(
        `已选「${risky.map((r) => r.label).join('、')}」，默认不勾选，删除后不能恢复。再点一次「确认清理」才会执行。`
      )
      return
    }
    setConfirming(false)
    const picked = rows.filter((r) => selected.has(r.id))
    const normalIds = picked.filter((r) => !r.admin).map((r) => r.id) as CleanupTargetId[]
    const adminIds = picked.filter((r) => r.admin).map((r) => r.id) as AdminCleanupId[]
    setBusy(true)
    // 普通项先清、不需要授权；勾了管理员项时，等轮到它们再提示授权
    setNote(normalIds.length > 0 ? '正在清理…' : '正在等待管理员授权…')
    const parts: string[] = []
    const warnings: string[] = []
    let freed = 0
    let canceled = false
    let adminFailed = false
    try {
      if (normalIds.length > 0) {
        const r = await window.island.cleanupRun('system', normalIds)
        freed += r.freedBytes
        warnings.push(...r.warnings)
        applySizes(r.scan.items)
        clearEmpty(r.scan.items)
      }
      if (adminIds.length > 0) {
        setNote('正在等待管理员授权…')
        const r = await window.island.adminCleanupRun(adminIds)
        applySizes(r.scan.items)
        clearEmpty(r.scan.items)
        if (r.canceled) {
          canceled = true
          parts.push('已取消管理员授权，需要管理员的那几项没有动。')
        } else if (!r.ok) {
          // 提权没跑起来（不是用户取消）：别在提示里说「清理完成」
          adminFailed = true
          warnings.push(...r.warnings)
        } else {
          freed += r.freedBytes
          warnings.push(...r.warnings)
          // 传递优化缓存的大小靠系统接口读，接口没给结果时说明一句，
          // 免得「没有释放量」被理解成没清
          const unmeasured = r.items.filter((i) => !i.measured).map((i) => i.label)
          if (unmeasured.length > 0) {
            parts.push(`${unmeasured.join('、')}交给系统接口清理，这次没统计到大小。`)
          }
        }
      }
      const head = canceled
        ? ''
        : adminFailed
          ? normalIds.length > 0
            ? '普通项已清理，管理员项没有执行。'
            : '管理员项没有执行。'
          : freed > 0
            ? `已释放 ${formatBytes(freed)}。`
            : '清理完成，没有可统计的释放量。'
      setNote([head, ...parts, ...warnings].filter(Boolean).join(' '))
    } catch {
      setNote('清理失败，请稍后再试。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="clean-group clean-part">
      <div className="clean-group-head">
        <h4 className="clean-group-title">系统垃圾</h4>
      </div>
      <div className="clean-list">
        {rows.length === 0 ? (
          <div className="clean-empty">
            {scanning ? '正在读取清理项…' : '暂时读不到清理项，点「重新读取」再试。'}
          </div>
        ) : null}
        {rows.map((row) => {
          const on = selected.has(row.id)
          const pending = row.known && row.bytes === null
          const empty = row.known && row.bytes === 0 && !row.exists
          return (
            <button
              key={row.id}
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-label={row.label}
              className={`clean-row${on ? ' on' : ''}`}
              disabled={busy || pending || empty}
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
                <span className="clean-name">
                  {row.label}
                  {/* 需要管理员只用一个人形标记表示（琥珀色），文字说明在卡片开头和 title 里 */}
                  {row.admin ? (
                    <svg
                      className="clean-admin-icon"
                      viewBox="0 0 16 16"
                      width="12"
                      height="12"
                      role="img"
                      aria-label="需要管理员授权"
                    >
                      <title>需要管理员授权</title>
                      <circle cx="8" cy="4.6" r="2.8" fill="currentColor" />
                      <path d="M3.1 13.8a4.9 4.9 0 0 1 9.8 0Z" fill="currentColor" />
                    </svg>
                  ) : null}
                </span>
                <span className="clean-hint">{row.hint}</span>
              </span>
              {/* 「无法统计」说的是大小，不是「要管理员才能用」 */}
              <span className="clean-size">
                {!row.known
                  ? '无法统计'
                  : pending
                    ? '计算中…'
                    : row.bytes === 0 && row.exists
                      ? '0 B'
                      : formatBytes(row.bytes ?? 0)}
              </span>
            </button>
          )
        })}
      </div>
      <div className="set-note clean-note">{note}</div>
      <div className="clean-foot">
        <div className="clean-total">
          可清理 <b>{totalBytes === 0 && rows.some((r) => r.exists) ? '0 B' : formatBytes(totalBytes)}</b> ·
          已选 <b>{selectedBytes === 0 && selected.size > 0 ? '0 B' : formatBytes(selectedBytes)}</b>
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
            {busy
              ? adminPicked
                ? '等待授权…'
                : '处理中…'
              : scanning
                ? '计算中…'
                : confirming
                  ? '确认清理'
                  : '清理选中项'}
          </button>
        </div>
      </div>
    </div>
  )
}

const RESIDUE_LEVEL_TEXT: Record<SoftwareResidueItem['level'], string> = {
  definite: '确定',
  likely: '很可能',
  check: '需确认'
}

const RESIDUE_KIND_TEXT: Record<SoftwareResidueItem['kind'], string> = {
  service: '服务',
  driver: '驱动',
  task: '计划任务',
  folder: '目录',
  process: '进程'
}

/**
 * 软件残留（SPEC-space-software-residue）：只检测、只展示。
 * 这张卡片没有任何停止/删除入口，避免第一版误伤。
 */
function SoftwareResiduePanel(): ReactElement {
  const [items, setItems] = useState<SoftwareResidueItem[]>([])
  const [scanning, setScanning] = useState(false)
  const [scanned, setScanned] = useState(false)
  const [note, setNote] = useState('')
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    setScanning(true)
    setNote('')
    try {
      const r = await window.island.softwareResidueScan()
      setItems(r.items)
      setNote(r.warnings.join(' '))
      setScanned(true)
    } catch {
      setNote('扫描失败，请稍后再试。')
    } finally {
      setScanning(false)
    }
  }, [])

  // 扫描要读服务、驱动和各个盘符下的目录，十几秒起步，不随设置页打开自动跑

  const copy = async (): Promise<void> => {
    const text =
      items
        .map(
          (i) =>
            `${RESIDUE_LEVEL_TEXT[i.level]}｜${RESIDUE_KIND_TEXT[i.kind]}｜${i.label}${i.running ? '（运行中）' : ''}\n  ${i.detail}\n  ${i.path}`
        )
        .join('\n\n') || '没有发现软件残留。'
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setNote('复制失败，请手动选中文本。')
    }
  }

  return (
    <div className="clean-group swr-group">
      <div className="clean-group-head">
        <h3 className="clean-group-title">软件残留（仅检测）</h3>
        <p className="clean-lead">
          检查已删除软件留下的服务、驱动、计划任务和目录，覆盖各个本地盘。这是线索清单，不是待删清单：徽标只表示证据强弱，不代表删掉安全（驱动和非空目录尤其不要直接删）。只检测，不会停止或删除任何东西。
        </p>
      </div>
      <div className="swr-list">
        {scanning ? <div className="clean-empty">正在扫描服务、驱动、计划任务和目录，需要十几秒…</div> : null}
        {!scanning && !scanned ? (
          <div className="clean-empty">还没检测过。点右下角「开始检测」扫一次。</div>
        ) : null}
        {!scanning && scanned && items.length === 0 ? (
          <div className="clean-empty">没有发现软件残留。</div>
        ) : null}
        {items.map((it) => (
          <div key={it.id} className={`swr-row swr-${it.level}`}>
            <div className="swr-head">
              <span className={`swr-level swr-level-${it.level}`}>{RESIDUE_LEVEL_TEXT[it.level]}</span>
              <span className="swr-kind">{RESIDUE_KIND_TEXT[it.kind]}</span>
              <span className="swr-name">{it.label}</span>
              {it.running ? <span className="swr-tag swr-tag-running">运行中</span> : null}
              {it.admin ? <span className="swr-tag">需要管理员</span> : null}
              <span className="swr-size">{it.bytes === null ? '' : formatBytes(it.bytes)}</span>
            </div>
            <div className="swr-detail">{it.detail}</div>
            <div className="swr-path" title={it.path}>
              {it.path}
            </div>
          </div>
        ))}
      </div>
      <div className="set-note clean-note">{note}</div>
      <div className="clean-foot">
        <div className="clean-total">
          {scanned ? (
            <>
              共 <b>{items.length}</b> 项 · 仅检测，不会改动系统
            </>
          ) : (
            '仅检测，不会改动系统'
          )}
        </div>
        <div className="clean-actions">
          <button
            type="button"
            className="set-btn set-btn-quiet"
            disabled={scanning || items.length === 0}
            onClick={() => {
              void copy()
            }}
          >
            {copied ? '已复制' : '复制清单'}
          </button>
          <button
            type="button"
            className="set-btn set-btn-primary"
            disabled={scanning}
            onClick={() => {
              void refresh()
            }}
          >
            {scanning ? '扫描中…' : scanned ? '重新扫描' : '开始检测'}
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
      {/* 两张卡片：灵动岛自己的东西一张，系统相关的一张。
          系统卡里两节：系统垃圾（普通项与需要管理员项合成一张清单）、卸载残留
          （要备份和撤销，行为不同所以单独一节） */}
      <CleanupPanel
        scope="app"
        title="灵动岛"
        lead="只清理灵动岛自己产生的缓存和日志。待办、日程、置物架和设置都存在别处，这里绝不会动。"
      />
      <div className="clean-group clean-group-space">
        <div className="clean-group-head">
          <h3 className="clean-group-title">系统</h3>
          <p className="clean-lead">
            Windows 和其他软件留下的临时文件、卸载残留。名字后面带琥珀色人形标记的几项，清理时需要管理员授权，其余不需要。
          </p>
        </div>
        <JunkPanel />
        <ResiduePanel />
      </div>
      {/* 第三张卡：只读的软件残留检测（SPEC-space-software-residue），没有停止/删除入口 */}
      <SoftwareResiduePanel />
    </section>
  )
}
