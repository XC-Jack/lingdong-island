import { useRef, useState } from 'react'
import type { ReactElement } from 'react'

/**
 * 设置窗口的「页面管理」分区（SPEC-settings-shell）。
 *
 * 业务逻辑从岛内的 PageManagerPanel（App.tsx）原样搬过来：勾选显示哪些页面、收起态显示哪些
 * 组件、拖拽调整顺序；差别只有两处——独立窗口里没有「完成并收起」按钮（关闭走标题栏 ×），
 * 以及样式改由 settings.css 提供（岛内那份 .pm-* 随面板一起删掉）。
 *
 * 为什么偏好类型/默认值/规整函数在这里自建一份而不从 App.tsx import：
 * App.tsx 里那些只给面板用的定义会随面板一起删除，设置窗口不能依赖会被删掉的东西。
 * 结构必须与主进程 prefsStore.ts 的 PagesCustom 保持一致（IPC 传输的是纯 JSON）。
 */

/** 收起态可裁剪组件的键（与主进程 prefsStore 保持一致） */
const COLLAPSED_KEYS = ['pet', 'clock', 'battery', 'net', 'todo', 'bell'] as const
export type CollapsedKey = (typeof COLLAPSED_KEYS)[number]

/** 收起态组件的默认顺序（美化-02）：电量 → 岛仔 → 时钟 → 网络 → 待办 → 铃铛 */
const DEFAULT_COLLAPSED_ORDER: CollapsedKey[] = ['battery', 'pet', 'clock', 'net', 'todo', 'bell']

/**
 * 页面裁剪偏好：pages 是显示的页面索引集合，collapsed 是收起态组件开关，
 * order 是收起态组件从左到右的顺序（美化-02，用户可拖动调整）。
 */
export interface PagesCustom {
  pages: number[]
  collapsed: Record<CollapsedKey, boolean>
  order: CollapsedKey[]
}

/** 默认全开（4 页 + 6 个收起态组件）+ 默认顺序 */
export function defaultPagesCustom(): PagesCustom {
  return {
    pages: [0, 1, 2, 3],
    collapsed: { pet: true, clock: true, battery: true, net: true, todo: true, bell: true },
    order: [...DEFAULT_COLLAPSED_ORDER]
  }
}

/**
 * 规整收起态组件顺序（美化-02）：只保留合法键并去重，再把缺失的键按默认顺序补到末尾。
 * 为什么必须补全而不是丢弃：order 是「渲染清单」——少一个键该组件就永远不显示；
 * 旧版 prefs 没有 order、或用户手改坏了，都不该让组件消失，按默认位置补回即可。
 */
function normalizeOrder(v: unknown): CollapsedKey[] {
  const arr = Array.isArray(v) ? v : []
  const seen = new Set<CollapsedKey>()
  const out: CollapsedKey[] = []
  for (const item of arr) {
    if (typeof item === 'string' && (COLLAPSED_KEYS as readonly string[]).includes(item)) {
      const k = item as CollapsedKey
      if (!seen.has(k)) {
        seen.add(k)
        out.push(k)
      }
    }
  }
  for (const k of DEFAULT_COLLAPSED_ORDER) if (!seen.has(k)) out.push(k)
  return out
}

/**
 * 校验并规整页面裁剪偏好（US-032 / 美化-02）。
 * 值不合法（手工改坏/缺字段/全空页面）一律返回 null，调用方回落默认全开。
 */
export function normalizePagesCustom(v: unknown): PagesCustom | null {
  if (!v || typeof v !== 'object') return null
  const raw = v as Partial<PagesCustom>
  // 顺序即用户自定义的页面顺序（US-032 反馈）：只做去重 + 范围校验 + 非空，不排序。
  const pages = Array.isArray(raw.pages)
    ? [...new Set(raw.pages.filter((n) => Number.isInteger(n) && n >= 0 && n <= 3))]
    : []
  if (pages.length === 0) return null
  const collapsed = defaultPagesCustom().collapsed
  if (raw.collapsed && typeof raw.collapsed === 'object') {
    for (const k of COLLAPSED_KEYS) {
      if (typeof raw.collapsed[k] === 'boolean') collapsed[k] = raw.collapsed[k]
    }
  }
  return { pages, collapsed, order: normalizeOrder(raw.order) }
}

/** 页标签：名称 + 强调色（对应岛内 PAGE_META 的 label/accent，图标在设置窗口里不需要） */
const PAGE_META: { label: string; accent: string }[] = [
  { label: '待办', accent: '#7dd87d' },
  { label: '置物架', accent: '#ffb74d' },
  { label: '通知', accent: '#9f8bff' },
  { label: '日程', accent: '#64b5f6' }
]

/** 收起态组件在页面管理面板里的显示名（US-032 / 美化-02） */
const COLLAPSED_LABELS: Record<CollapsedKey, string> = {
  pet: '岛仔',
  clock: '时钟',
  battery: '电量圈',
  net: '网络图标',
  todo: '待办数字',
  bell: '通知铃铛'
}

/**
 * 页面管理分区：勾选显示哪些页面、收起态显示哪些组件、拖拽调整顺序。
 * 改动立即生效并写主进程 prefs.json；至少保留 1 个页面。
 * （e2e 依赖这里的 class：.pm-panel/.pm-section/.pm-row/.pm-name/.pm-grip/.pm-lock-hint/
 *  .pm-actions/.pm-reset，以及收起态行的 data-comp。）
 */
export default function PageManagerSection({
  pagesCustom,
  onChange
}: {
  pagesCustom: PagesCustom
  onChange: (v: PagesCustom) => void
}): ReactElement {
  const togglePage = (i: number): void => {
    const has = pagesCustom.pages.includes(i)
    // 最后一个页面不允许取消（至少保留 1 页）
    if (has && pagesCustom.pages.length <= 1) return
    // 重新勾上时排到列表末尾（用户当前顺序的自然延伸），不强制按页号排序
    const pages = has ? pagesCustom.pages.filter((n) => n !== i) : [...pagesCustom.pages, i]
    onChange({ ...pagesCustom, pages })
  }
  const toggleCollapsed = (k: CollapsedKey): void => {
    onChange({ ...pagesCustom, collapsed: { ...pagesCustom.collapsed, [k]: !pagesCustom.collapsed[k] } })
  }
  const reset = (): void => onChange(defaultPagesCustom())
  // 拖拽排序（US-032 反馈 + 2026-11-11 用户修正）：只在「显示的页面」列表里拖换位；
  // HTML5 dataTransfer 必须带数据才稳定触发 dragover/drop（项目踩坑记录）。
  // **插入**语义，与下方收起态组件区一致（用户原话「上面的这个要和下面的互换逻辑一样，从中间插入」）：
  // 拖到目标行上半 → 插到它前面，下半 → 插到它后面，其余页顺移；被拖项先从序列里抽掉。
  const dragFrom = useRef<number | CollapsedKey | null>(null)
  /** 页面区的落点提示（与组件区的 dropHint 分开存：键的类型不同，混用会让 TS 收窄出错） */
  const [pageHint, setPageHint] = useState<{ i: number; before: boolean } | null>(null)
  const reorderTo = (targetPageId: number, before: boolean): void => {
    const from = dragFrom.current
    dragFrom.current = null
    setPageHint(null)
    if (typeof from !== 'number' || from === targetPageId) return
    // 未勾选的页不参与排序；被拖项也不在 pages 里时无从下手
    if (!pagesCustom.pages.includes(from) || !pagesCustom.pages.includes(targetPageId)) return
    // 先抽掉再插：这样「前/后」直接以抽掉后的列表为准，不用为 fi<ti 单独减一
    const rest = pagesCustom.pages.filter((p) => p !== from)
    const ti = rest.indexOf(targetPageId)
    if (ti === -1) return
    const insertAt = before ? ti : ti + 1
    rest.splice(insertAt, 0, from)
    onChange({ ...pagesCustom, pages: rest })
  }
  // 收起态组件排序（美化-02）：**插入**语义，不是互换——用户 2026-11-08 验收反馈
  // 「拖动组件插空放」，即把被拖项抽出来插到目标行的前/后空隙，其余组件顺移。
  // 这里没有勾选门槛——6 个组件恒在 order 里，关掉的只是显隐，位置照样能调
  // （用户常先摆好位置再逐个关，位置信息不该因为关掉就丢）。
  const [dropHint, setDropHint] = useState<{ key: CollapsedKey; before: boolean } | null>(null)
  /** 光标落在目标行的上半还是下半：决定插到它前面还是后面 */
  const dropEdge = (el: HTMLElement, clientY: number): boolean => {
    const r = el.getBoundingClientRect()
    return clientY < r.top + r.height / 2
  }
  const reorderCollapsed = (targetKey: CollapsedKey, before: boolean): void => {
    const from = dragFrom.current
    dragFrom.current = null
    setDropHint(null)
    // dragFrom 是「页面区 / 组件区」共用的 ref，页面区拖拽时装的是 number。
    // 必须按类型挡住，否则跨区落下来会把一个数字 splice 进 order，渲染时多出一行（独立验收 5.1）。
    if (typeof from !== 'string' || from === targetKey) return
    // 先把被拖项抽掉再插：这样「前/后」直接以抽掉后的列表为准，不用为 fi<ti 单独减一
    const rest = pagesCustom.order.filter((k) => k !== from)
    const ti = rest.indexOf(targetKey)
    if (ti === -1) return
    const insertAt = before ? ti : ti + 1
    rest.splice(insertAt, 0, from)
    onChange({ ...pagesCustom, order: rest })
  }
  return (
    <div className="pm-panel">
      <div className="pm-section">页面（勾选显示，按住拖到目标行插入）</div>
      {(() => {
        // 按用户自定义顺序渲染：已勾选页按 pages 排在前（可拖），未勾选页按固定号排在后
        const shown = pagesCustom.pages.map((p) => ({ m: PAGE_META[p], i: p, on: true }))
        const hidden = PAGE_META.map((m, i) => ({ m, i, on: false })).filter(
          (h) => !pagesCustom.pages.includes(h.i)
        )
        const rows = [...shown, ...hidden]
        return rows.map(({ m, i, on }) => {
          const locked = on && pagesCustom.pages.length <= 1
          return (
            <div
              key={i}
              className={`pm-row ${on ? '' : 'pm-row-off'} ${locked ? 'pm-locked' : ''} ${
                pageHint?.i === i ? (pageHint.before ? 'pm-drop-before' : 'pm-drop-after') : ''
              }`}
              draggable={on}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', String(i))
                e.dataTransfer.effectAllowed = 'move'
                dragFrom.current = i
              }}
              onDragOver={(e) => {
                // 未勾选的页不接落点：它们不在 pages 里，插进去没有意义
                if (!on) return
                e.preventDefault()
                if (typeof dragFrom.current === 'number' && dragFrom.current !== i) {
                  setPageHint({ i, before: dropEdge(e.currentTarget, e.clientY) })
                }
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  setPageHint((h) => (h?.i === i ? null : h))
                }
              }}
              onDrop={(e) => {
                if (!on) return
                e.preventDefault()
                reorderTo(i, dropEdge(e.currentTarget, e.clientY))
              }}
              onDragEnd={() => {
                dragFrom.current = null
                setPageHint(null)
              }}
            >
              <input type="checkbox" checked={on} onChange={() => togglePage(i)} />
              <span className="pm-dot" style={{ background: m.accent }} />
              <span className="pm-name">{m.label}</span>
              {locked ? (
                <span className="pm-lock-hint">至少保留一个</span>
              ) : on ? (
                <span className="pm-grip" title="按住拖到目标行：落在上半插到它前面，落在下半插到它后面">
                  ⋮⋮
                </span>
              ) : null}
            </div>
          )
        })
      })()}
      <div className="pm-section">收起态组件（勾选显示，按住拖到目标行插入）</div>
      {pagesCustom.order.map((k) => (
        <div
          key={k}
          className={`pm-row ${pagesCustom.collapsed[k] ? '' : 'pm-row-off'} ${
            dropHint?.key === k ? (dropHint.before ? 'pm-drop-before' : 'pm-drop-after') : ''
          }`}
          data-comp={k}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('text/plain', k)
            e.dataTransfer.effectAllowed = 'move'
            dragFrom.current = k
          }}
          onDragOver={(e) => {
            e.preventDefault()
            // 光标在上半 → 插到本行前面，下半 → 插到本行后面；拖自己身上不显示提示。
            // 只认字符串来源（组件区自己拖出来的），页面区拖过来时不能亮错位提示线。
            if (typeof dragFrom.current === 'string' && dragFrom.current !== k) {
              setDropHint({ key: k, before: dropEdge(e.currentTarget, e.clientY) })
            }
          }}
          onDragLeave={(e) => {
            // 只在真正离开本行时清提示（子元素间移动不算离开）
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setDropHint((h) => (h?.key === k ? null : h))
            }
          }}
          onDrop={(e) => {
            e.preventDefault()
            reorderCollapsed(k, dropEdge(e.currentTarget, e.clientY))
          }}
          onDragEnd={() => {
            dragFrom.current = null
            setDropHint(null)
          }}
        >
          {/* 复选框自己处理点击并阻止冒泡：否则点勾选框时会先触发下一行拖拽逻辑 */}
          <input
            type="checkbox"
            checked={pagesCustom.collapsed[k]}
            onChange={(e) => {
              e.stopPropagation()
              toggleCollapsed(k)
            }}
            onClick={(e) => e.stopPropagation()}
          />
          <span className="pm-name">{COLLAPSED_LABELS[k]}</span>
          <span className="pm-grip" title="按住拖到目标行：落在上半插到它前面，落在下半插到它后面">
            ⋮⋮
          </span>
        </div>
      ))}
      <div className="pm-actions">
        <button type="button" className="pm-reset" onClick={reset}>
          重置为默认
        </button>
      </div>
    </div>
  )
}
