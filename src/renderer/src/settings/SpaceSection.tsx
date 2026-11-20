import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  AdminCleanupId,
  CleanupItemDef,
  CleanupScope,
  CleanupTargetId,
  ResidueItem,
  SoftwareResidueItem,
  SoftwareResidueLevel
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

/**
 * 勾选的行置顶；组内按勾选先后从早到晚排（最近勾的落在组末）。
 * 默认勾选的项没有勾选记录（rank -1），排在最前并按清单原顺序稳定排列。
 * 2026-11-20 用户更正：先做成「最近勾的最前」，用户要的是「后勾选排后面」。
 */
function checkedFirst<T>(
  rows: T[],
  keyOf: (row: T) => string,
  selected: Set<string>,
  recent: string[]
): T[] {
  const rank = new Map(recent.map((k, i) => [k, i]))
  const on = rows
    .filter((r) => selected.has(keyOf(r)))
    .sort((a, b) => (rank.get(keyOf(a)) ?? -1) - (rank.get(keyOf(b)) ?? -1))
  const off = rows.filter((r) => !selected.has(keyOf(r)))
  return [...on, ...off]
}

/**
 * 勾选后行会重排，可视区跟着上下窜；用户每次都得重新滚。
 * 记下右侧内容区的滚动位置，重排后的下一帧还原（两帧是为了等 React 提交完）。
 */
function keepScroll(run: () => void): void {
  const el = document.querySelector<HTMLElement>('.set-content')
  const top = el ? el.scrollTop : 0
  run()
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const now = document.querySelector<HTMLElement>('.set-content')
      if (now) now.scrollTop = top
    })
  })
}

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
  /** 勾选顺序：最近勾选的排在置顶区最前 */
  const [recent, setRecent] = useState<string[]>([])
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

  /** 记下勾选先后：新勾的追加到末尾（组内顺序就是勾选顺序）；取消勾选就移掉 */
  const rememberPick = (id: string, wasOn: boolean): void => {
    setRecent((prev) => (wasOn ? prev.filter((x) => x !== id) : [...prev.filter((x) => x !== id), id]))
  }

  const toggle = (id: CleanupTargetId): void => {
    keepScroll(() => {
      // 选择变了，之前的确认就不再代表用户当前的选择；对应的提示也一起撤掉
      if (confirming) setNote('')
      setConfirming(false)
      rememberPick(id, selected.has(id))
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
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
        {checkedFirst(rows, (r) => r.id, selected, recent).map((row) => {
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
  uninstall: '卸载项',
  shortcut: '快捷方式',
  folder: '开始菜单'
}

function timeText(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
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
  /** 勾选顺序：最近勾选的排在置顶区最前 */
  const [recent, setRecent] = useState<string[]>([])
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

  /** 记下勾选先后：新勾的追加到末尾（组内顺序就是勾选顺序）；取消勾选就移掉 */
  const rememberPick = (id: string, wasOn: boolean): void => {
    setRecent((prev) => (wasOn ? prev.filter((x) => x !== id) : [...prev.filter((x) => x !== id), id]))
  }

  const toggle = (id: string): void => {
    keepScroll(() => {
      // 选择变了，之前的确认就不再代表用户当前的选择；对应的提示也一起撤掉
      if (confirming) setNote('')
      setConfirming(false)
      rememberPick(id, selected.has(id))
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
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
        {checkedFirst(rows, (r) => r.id, selected, recent).map((row) => {
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
              <span
                className="clean-size"
                title={row.known ? undefined : '这项的大小要管理员权限或系统接口才能读到；不影响清理。'}
              >
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

/** 图例：短句常驻显示，长句挂在 title 上 */
const RESIDUE_LEVEL_INFO: Record<SoftwareResidueItem['level'], { brief: string; full: string }> = {
  definite: {
    brief: '程序文件已不存在',
    full: '登记还在，但它指向的程序文件已经不存在了。只有这一级的服务、计划任务和空目录能勾选。'
  },
  likely: {
    brief: '程序没了，同公司还有软件',
    full: '程序文件没了，但同一家公司还有别的软件装着。只报告，不能删。'
  },
  check: {
    brief: '有疑点，需你看一眼',
    full: '有疑点：程序还在、目录里有内容或来源不明。只报告，不能删。'
  }
}

const RESIDUE_LEVELS = ['definite', 'likely', 'check'] as const

const RESIDUE_KIND_TEXT: Record<SoftwareResidueItem['kind'], string> = {
  service: '服务',
  driver: '驱动',
  task: '计划任务',
  folder: '目录',
  process: '进程'
}

/** 清单里的一行：两类残留合成同一种形状（SPEC-space-residue-merge） */
interface MergedResidueRow {
  key: string
  source: 'uninstall' | 'software'
  /** 原始 id，清理时传回主进程 */
  id: string
  kindText: string
  label: string
  detail: string
  path: string
  size: number | null
  level: SoftwareResidueLevel
  running: boolean
  admin: boolean
  cleanable: boolean
  /** 没有勾选框时给一句原因；可勾选为空字符串 */
  reportOnly: string
}

/**
 * 残留（SPEC-space-residue / SPEC-space-software-residue / SPEC-space-residue-merge）。
 *
 * 一张清单装两类东西：当前用户的卸载残留（失效卸载项、死快捷方式、空的开始菜单文件夹），
 * 以及全机的软件残留（死服务、计划任务、无主目录等）。两边扫描引擎不同，但都先备份再删，
 * 所以勾选、清理、备份共用一套：卸载残留直接进备份区；软件残留只有确定级的服务/计划任务/
 * 空目录能勾，勾了再清会弹一次 UAC。
 */
function ResiduePanel({
  onChanged,
  refresh
}: {
  /** 清理产生了新备份：通知共享的备份块重新读取 */
  onChanged: () => void
  /** 共享备份块撤销了某一类：把那一类重扫一遍 */
  refresh: { uninstall: number; software: number }
}): ReactElement {
  const [uninstallItems, setUninstallItems] = useState<ResidueItem[]>([])
  const [softwareItems, setSoftwareItems] = useState<SoftwareResidueItem[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /** 勾选顺序：最近勾选的排在置顶区最前 */
  const [recent, setRecent] = useState<string[]>([])
  const [scanning, setScanning] = useState(false)
  const [scanned, setScanned] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState(false)

  /** 撤销后只重扫对应那一类，别把另一类正在显示的结果也清掉 */
  const rescanUninstall = useCallback(async (): Promise<void> => {
    try {
      const r = await window.island.residueScan()
      setUninstallItems(r.items)
      setSelected(new Set())
    } catch {
      /* 重扫失败不影响已经做完的撤销 */
    }
  }, [])

  const rescanSoftware = useCallback(async (): Promise<void> => {
    try {
      const r = await window.island.softwareResidueScan()
      setSoftwareItems(r.items)
      setSelected(new Set())
      setScanned(true)
    } catch {
      /* 同上 */
    }
  }, [])

  useEffect(() => {
    if (refresh.uninstall > 0) void rescanUninstall()
  }, [refresh.uninstall, rescanUninstall])

  useEffect(() => {
    if (refresh.software > 0) void rescanSoftware()
  }, [refresh.software, rescanSoftware])

  const rows: MergedResidueRow[] = [
    ...uninstallItems.map((it) => ({
      key: `u:${it.id}`,
      source: 'uninstall' as const,
      id: it.id,
      kindText: KIND_LABEL[it.kind],
      label: it.label,
      detail: it.detail,
      path: it.path,
      size: it.bytes > 0 ? it.bytes : null,
      level: 'definite' as const,
      running: false,
      admin: false,
      cleanable: true,
      reportOnly: ''
    })),
    ...softwareItems.map((it) => ({
      key: `s:${it.id}`,
      source: 'software' as const,
      id: it.id,
      kindText: RESIDUE_KIND_TEXT[it.kind],
      label: it.label,
      detail: it.detail,
      path: it.path,
      size: it.bytes,
      level: it.level,
      running: it.running,
      admin: it.admin,
      cleanable: it.cleanable,
      reportOnly: it.cleanable
        ? ''
        : it.kind === 'driver'
          ? '驱动删错可能让硬件不能用，只报告'
          : it.kind === 'process'
            ? '正在运行的进程不结束，只报告'
            : it.kind === 'folder'
              ? '目录里有内容，不自动删'
              : '证据不足，只报告'
    }))
  ]

  const refreshAll = async (): Promise<void> => {
    setScanning(true)
    setNote('')
    setSelected(new Set())
    setConfirming(false)
    try {
      const [u, s] = await Promise.allSettled([
        window.island.residueScan(),
        window.island.softwareResidueScan()
      ])
      const warnings: string[] = []
      if (u.status === 'fulfilled') {
        setUninstallItems(u.value.items)
        warnings.push(...u.value.warnings)
      } else {
        warnings.push('卸载残留没扫成。')
      }
      if (s.status === 'fulfilled') {
        setSoftwareItems(s.value.items)
        warnings.push(...s.value.warnings)
      } else {
        warnings.push('软件残留没扫成。')
      }
      setNote(warnings.join('\n'))
      setScanned(true)
    } finally {
      setScanning(false)
    }
  }

  /** 记下勾选先后：新勾的追加到末尾（组内顺序就是勾选顺序）；取消勾选就移掉 */
  const rememberPick = (id: string, wasOn: boolean): void => {
    setRecent((prev) => (wasOn ? prev.filter((x) => x !== id) : [...prev.filter((x) => x !== id), id]))
  }

  const toggle = (row: MergedResidueRow): void => {
    if (!row.cleanable || busy || scanning) return
    keepScroll(() => {
      rememberPick(row.key, selected.has(row.key))
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(row.key)) next.delete(row.key)
        else next.add(row.key)
        return next
      })
      // 勾选一变，之前的确认就作废
      setConfirming(false)
      setNote('')
    })
  }

  /**
   * 复制一段能直接贴给 AI 助手的提示词：带上清单、每项的判定依据和工具本身的边界，
   * 让助手判断哪些能删、哪些必须留。只复制文字，不执行任何东西。
   */
  const buildPrompt = (): string => {
    const cleanable = rows.filter((r) => r.cleanable).length
    const lines = rows.map((r, i) => {
      const tags = [
        RESIDUE_LEVEL_TEXT[r.level],
        r.kindText,
        r.running ? '运行中' : '',
        r.admin ? '需要管理员' : '',
        r.reportOnly ? `工具里不能删：${r.reportOnly}` : ''
      ].filter(Boolean)
      const size = r.size === null ? '' : `｜${formatBytes(r.size)}`
      return `${i + 1}. [${tags.join('｜')}] ${r.label}${size}\n   依据：${r.detail}\n   路径：${r.path}`
    })
    return [
      '我在用一款叫「灵动岛」的 Windows 小工具扫了一遍系统里的「软件残留」，清单在下面。请帮我判断哪些可以安全清理、哪些必须保留，并说明理由。只输出分析和建议，不要给直接执行删除的命令。',
      '',
      '## 这份清单是什么',
      '- 一张清单混了两类：①「卸载项 / 快捷方式 / 开始菜单」= 当前用户下失效的卸载登记、指向空处的快捷方式、只剩死链的开始菜单文件夹；②「服务 / 驱动 / 计划任务 / 目录 / 进程」= 全机范围查到的、可能属于已卸载软件的残留。',
      '- 等级只表示证据强弱：确定 = 登记还在、但它指向的程序文件已经不存在；很可能 = 程序文件没了、但同一家公司还有别的软件装着；需确认 = 证据不足（运行中但查不到归属、第三方驱动、里面还有内容的无主目录等）。',
      '- 工具里只有「确定」级的服务、计划任务和空目录可以勾选清理，删前会导出备份、可以撤销；驱动、非空目录、进程和「需确认」项只报告，不提供删除。',
      '',
      `## 清单（共 ${rows.length} 项，工具里可勾选 ${cleanable} 项）`,
      '',
      ...lines,
      '',
      '## 请你输出',
      '1. 可以清理：按风险从低到高排序，每项一句话理由。',
      '2. 建议保留：每项一句话理由，尤其是程序可能还在用的、驱动、以及里面还有东西的目录。',
      '3. 拿不准：写出需要我核实什么（例如某个程序是否还在用），不要猜。',
      '4. 如果清单里有明显不属于残留的东西，直接指出来。',
      '',
      '只依据上面的信息判断；拿不准就说不确定，不要编造清单里没有的程序或路径。'
    ].join('\n')
  }

  const copy = async (): Promise<void> => {
    const text = rows.length === 0 ? '没有发现残留，不需要分析。' : buildPrompt()
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setNote('复制失败，请手动选中文本。')
    }
  }

  const pickedUninstall = rows.filter((r) => r.source === 'uninstall' && selected.has(r.key))
  const pickedSoftware = rows.filter((r) => r.source === 'software' && selected.has(r.key))

  const runCleanup = async (): Promise<void> => {
    if (busy || scanning || selected.size === 0) return
    // 软件残留要先备份、要 UAC，所以只要选了它们就得点两下；只是卸载残留则直接清
    if (pickedSoftware.length > 0 && !confirming) {
      const names = pickedSoftware.slice(0, 5).map((p) => p.label).join('、')
      const more = pickedSoftware.length > 5 ? ' 等' : ''
      setConfirming(true)
      setNote(
        `将清理 ${pickedSoftware.length} 项软件残留：${names}${more}。${
          pickedUninstall.length > 0 ? `另有 ${pickedUninstall.length} 项卸载残留一起清理。` : ''
        }删前会备份、可撤销；需要一次管理员授权。再点一次「确认清理」。`
      )
      return
    }

    setBusy(true)
    const lines: string[] = []
    const warnings: string[] = []
    try {
      if (pickedUninstall.length > 0) {
        setNote('正在清理卸载残留…')
        const r = await window.island.residueClean(pickedUninstall.map((x) => x.id))
        setUninstallItems(r.scan.items)
        lines.push(
          r.removed > 0
            ? `卸载残留：已清理 ${r.removed} 项${
                r.movedBytes > 0 ? `，${formatBytes(r.movedBytes)} 移进了备份（删除备份后才真正腾出空间）` : ''
              }。`
            : '卸载残留：这次没有清理任何项。'
        )
        warnings.push(...r.warnings)
        if (r.backupId) onChanged()
      }
      if (pickedSoftware.length > 0) {
        setNote([...lines, '正在请求管理员权限，请在弹窗里点「是」…'].join('\n'))
        const r = await window.island.softwareResidueCleanup(pickedSoftware.map((x) => x.id))
        setSoftwareItems(r.scan.items)
        const done = r.items.filter((x) => x.ok).length
        if (!r.canceled) lines.push(`软件残留：本次处理 ${done}/${r.items.length} 项。`)
        lines.push(...r.items.map((x) => `${x.ok ? '已清理' : '未处理'}：${x.label}${x.message ? `（${x.message}）` : ''}`))
        warnings.push(...r.warnings)
        if (done > 0) onChanged()
      }
      setNote([...lines, ...warnings].filter(Boolean).join('\n'))
      setSelected(new Set())
    } catch {
      setNote('清理失败，请稍后再试。')
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  const cleanableCount = rows.filter((r) => r.cleanable).length

  return (
    <div className="swr-group">
      <div className="swr-legend">
        <span className="swr-legend-title">等级表示证据强弱，不代表能不能删：</span>
        {RESIDUE_LEVELS.map((lv) => (
          <span key={lv} className="swr-legend-item" title={RESIDUE_LEVEL_INFO[lv].full}>
            <span className={`swr-level swr-level-${lv}`}>{RESIDUE_LEVEL_TEXT[lv]}</span>
            {RESIDUE_LEVEL_INFO[lv].brief}
          </span>
        ))}
        <span className="swr-legend-item">
          <span className="swr-tag swr-tag-running">运行中</span>此刻在运行
        </span>
        <span className="swr-legend-item">
          <span className="swr-tag">需要管理员</span>清理时要提权
        </span>
      </div>
      <div className="swr-list">
        {scanning ? <div className="clean-empty">正在扫描卸载残留和软件残留，需要十几秒…</div> : null}
        {!scanning && !scanned ? <div className="clean-empty">还没检测过。点右下角「开始检测」扫一次。</div> : null}
        {!scanning && scanned && rows.length === 0 ? <div className="clean-empty">没有发现残留。</div> : null}
        {checkedFirst(rows, (r) => r.key, selected, recent).map((row) => {
          const on = selected.has(row.key)
          return (
            <div
              key={row.key}
              className={`swr-row swr-lv-${row.level}${on ? ' on' : ''}${row.cleanable ? ' swr-selectable' : ''}`}
            >
              <div className="swr-head">
                {row.cleanable ? (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    aria-label={row.label}
                    className="swr-check"
                    disabled={busy || scanning}
                    onClick={() => toggle(row)}
                  >
                    <span className="clean-check" aria-hidden="true">
                      {on ? (
                        <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <path d="M2.4 6.2 5 8.7l4.6-5.2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : null}
                    </span>
                  </button>
                ) : null}
                <span className={`swr-level swr-level-${row.level}`} title={RESIDUE_LEVEL_INFO[row.level].full}>
                  {RESIDUE_LEVEL_TEXT[row.level]}
                </span>
                <span className="swr-kind">{row.kindText}</span>
                <span className="swr-name">{row.label}</span>
                {row.reportOnly ? (
                  <span className="swr-tag swr-tag-report" title={row.reportOnly}>
                    只报告
                  </span>
                ) : null}
                {row.running ? <span className="swr-tag swr-tag-running">运行中</span> : null}
                {row.admin ? <span className="swr-tag">需要管理员</span> : null}
                <span className="swr-size">{row.size === null ? '' : formatBytes(row.size)}</span>
              </div>
              <div className="swr-detail">{row.detail}</div>
              <div className="swr-path" title={row.path}>
                {row.path}
              </div>
            </div>
          )
        })}
      </div>
      <div className="set-note clean-note swr-note">{note}</div>
      <div className="clean-foot">
        <div className="clean-total">
          {scanned ? (
            <>
              共 <b>{rows.length}</b> 项 · 可清理 <b>{cleanableCount}</b> 项
              {selected.size > 0 ? <> · 已选 <b>{selected.size}</b> 项</> : null}
            </>
          ) : (
            '只检测，不会改动系统'
          )}
        </div>
        <div className="clean-actions">
          <button
            type="button"
            className="set-btn set-btn-quiet"
            disabled={scanning || busy || rows.length === 0}
            title="复制一段带清单的提示词，贴给 AI 判断哪些能删"
            onClick={() => void copy()}
          >
            {copied ? '已复制' : '复制提示词'}
          </button>
          <button
            type="button"
            className="set-btn set-btn-primary"
            disabled={scanning || busy}
            onClick={() => void refreshAll()}
          >
            {scanning ? '扫描中…' : scanned ? '重新扫描' : '开始检测'}
          </button>
          {cleanableCount > 0 || selected.size > 0 ? (
            <button
              type="button"
              className="set-btn set-btn-primary"
              disabled={busy || selected.size === 0}
              onClick={() => void runCleanup()}
            >
              {busy
                ? '处理中…'
                : confirming
                  ? '确认清理'
                  : pickedSoftware.length > 0
                    ? '清理选中项（需要管理员）'
                    : '清理选中项'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** 两类备份合在一起显示：来源用文字区分，撤销与删除各走各的接口 */
interface BackupRow {
  key: string
  source: 'uninstall' | 'software'
  id: string
  createdAt: number
  count: number
  labels: string[]
  restored: boolean
}

function ResidueBackupsPanel({
  refreshSignal,
  onUndone
}: {
  refreshSignal: number
  /** 撤销了哪一类：让对应的列表重扫，恢复的项才会回到清单里 */
  onUndone: (source: BackupRow['source']) => void
}): ReactElement {
  const [rows, setRows] = useState<BackupRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState('')
  const [note, setNote] = useState('')

  const load = useCallback(async (): Promise<void> => {
    try {
      const [uninstall, software] = await Promise.all([
        window.island.residueBackups(),
        window.island.softwareResidueBackups()
      ])
      const merged: BackupRow[] = [
        ...uninstall.map((b) => ({
          key: `u:${b.id}`,
          source: 'uninstall' as const,
          id: b.id,
          createdAt: b.createdAt,
          count: b.files + b.registry,
          labels: [],
          restored: b.restored
        })),
        ...software.map((b) => ({
          key: `s:${b.id}`,
          source: 'software' as const,
          id: b.id,
          createdAt: b.createdAt,
          count: b.count,
          labels: b.labels,
          restored: b.restored
        }))
      ]
      setRows(merged.sort((a, b) => b.createdAt - a.createdAt))
    } catch {
      /* 备份列表读不到就保留上一次的结果 */
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshSignal])

  const undo = async (row: BackupRow): Promise<void> => {
    if (busy) return
    setConfirmDiscard('')
    setBusy(row.key)
    setNote('正在撤销…')
    try {
      if (row.source === 'uninstall') {
        const r = await window.island.residueUndo(row.id)
        setNote(r.ok ? ['已撤销这批备份。', ...r.warnings].join(' ') : r.warnings.join(' '))
      } else {
        setNote('正在请求管理员权限，请在弹窗里点「是」…')
        const r = await window.island.softwareResidueUndo(row.id)
        setNote(
          [r.canceled ? '已取消管理员授权，没有恢复任何东西。' : `已恢复 ${r.restored} 项。`, ...r.warnings]
            .filter(Boolean)
            .join('\n')
        )
      }
      await load()
      onUndone(row.source)
    } catch {
      setNote('撤销失败，请稍后再试。')
    } finally {
      setBusy('')
    }
  }

  const discard = async (row: BackupRow): Promise<void> => {
    if (busy) return
    // 第一下只是把按钮换成「确认删除」，第二下才真删（删除不可恢复）
    if (confirmDiscard !== row.key) {
      setConfirmDiscard(row.key)
      setNote('再点一次「确认删除」就会永久删除这批备份，不能恢复。')
      return
    }
    setConfirmDiscard('')
    setBusy(row.key)
    setNote('正在删除备份…')
    try {
      const r =
        row.source === 'uninstall'
          ? await window.island.residueDiscardBackup(row.id)
          : await window.island.softwareResidueDiscardBackup(row.id)
      setNote(r.ok ? '备份已删除。' : r.warnings.join(' '))
      await load()
    } catch {
      setNote('删除备份失败，请稍后再试。')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="residue-backups">
      <div className="residue-backups-head">
        <h4 className="clean-group-title">清理备份</h4>
        <span className="clean-hint">
          清理的东西先存这里，撤销会恢复原样。删掉备份才真正腾出空间，且不能恢复。
        </span>
      </div>
      {loaded && rows.length === 0 ? <div className="clean-empty">还没有备份。</div> : null}
      {rows.map((row) => (
        <div className="residue-backup-row" key={row.key}>
          <span className="residue-backup-meta">
            {timeText(row.createdAt)} · {row.source === 'uninstall' ? '卸载残留' : '软件残留'} · {row.count} 项
            {row.labels.length > 0
              ? `（${row.labels.join('、')}${row.count > row.labels.length ? ' 等' : ''}）`
              : ''}
            {row.restored ? ' · 已撤销' : ''}
          </span>
          <span className="residue-backup-actions">
            <button
              type="button"
              className="set-btn set-btn-quiet"
              disabled={row.restored || Boolean(busy)}
              onClick={() => {
                void undo(row)
              }}
            >
              {busy === row.key ? '处理中…' : '撤销'}
            </button>
            <button
              type="button"
              className="set-btn set-btn-quiet"
              disabled={Boolean(busy)}
              onClick={() => {
                void discard(row)
              }}
            >
              {confirmDiscard === row.key ? '确认删除' : '删除备份'}
            </button>
          </span>
        </div>
      ))}
      <div className="set-note clean-note">{note}</div>
    </div>
  )
}

/** 残留：卸载残留 + 软件残留 + 共用一块清理备份（SPEC-space-residue-merge） */
function ResidueSection(): ReactElement {
  const [backupToken, setBackupToken] = useState(0)
  const [refresh, setRefresh] = useState({ uninstall: 0, software: 0 })

  const onChanged = useCallback((): void => setBackupToken((n) => n + 1), [])
  const onUndone = useCallback((source: BackupRow['source']): void => {
    setRefresh((r) => ({ ...r, [source]: r[source] + 1 }))
  }, [])

  return (
    <div className="clean-group">
      <div className="clean-group-head">
        <h3 className="clean-group-title">残留</h3>
        <p className="clean-lead">
          已卸载软件留下的痕迹：失效卸载项、死快捷方式、空的开始菜单文件夹，以及死服务、计划任务和无主目录。只有确定级能勾选，删前备份，可撤销。
        </p>
      </div>
      <ResiduePanel onChanged={onChanged} refresh={refresh} />
      <ResidueBackupsPanel refreshSignal={backupToken} onUndone={onUndone} />
    </div>
  )
}

export default function SpaceSection(): ReactElement {
  return (
    <section className="set-page">
      <h2 className="set-page-title">空间</h2>
      {/* 三张卡片：灵动岛自己的东西、系统垃圾、残留（两张清单合一张表 + 共用清理备份，
          SPEC-space-residue-merge） */}
      <CleanupPanel
        scope="app"
        title="灵动岛"
        lead="只清理灵动岛自己的缓存和日志，不会动待办、日程、置物架和设置。"
      />
      <div className="clean-group clean-group-space">
        <div className="clean-group-head">
          <h3 className="clean-group-title">系统</h3>
          <p className="clean-lead">
            Windows 和其他软件留下的临时文件。带琥珀色人形标记的项需要管理员授权；显示「无法统计」的项，大小要管理员权限或系统接口才读得到，不影响清理。
          </p>
        </div>
        <JunkPanel />
      </div>
      <ResidueSection />
    </section>
  )
}
