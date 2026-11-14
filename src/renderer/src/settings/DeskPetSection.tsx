import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { PetMode, PetSkinId } from '../../../shared/types'
import { PET_MODES } from '../../../shared/types'
import Pet from '../pet/Pet'
import { listPetSkins } from '../pet'

/**
 * 设置窗口「桌宠」分区（SPEC-deskpet-skin / SPEC-deskpet-out / SPEC-deskpet-walk）。
 *
 * - 皮肤：三套可切换，选中立刻生效（岛、宠物窗口和这里共用 prefs.petSkin）。
 * - 模式：三档全列出来，三档都可用。window=独立小窗口（SPEC-deskpet-out），
 *   free=自由走动、在独立窗口里横向溜达走一段停一段（SPEC-deskpet-walk）。
 *
 * 为什么不给「保存」按钮：桌宠在另外两个窗口实时渲染，用户改完就想立刻看到效果。
 * 立刻写 + 广播回来（与页面管理分区同一套模式）。
 */

/** 模式的三档文案：label 给按钮，desc 解释它是什么意思 */
const MODE_META: Record<PetMode, { label: string; desc: string; ready: boolean }> = {
  island: {
    label: '只在岛里',
    desc: '就是现在的样子：收起时待在小胶囊里，展开时站在头部。',
    ready: true
  },
  window: {
    label: '独立小窗口',
    desc: '单独浮在桌面上的一只，拖到哪都行，关掉重开会回到原位。右键可以收回岛里。',
    ready: true
  },
  free: {
    label: '自由走动',
    desc: '自己沿屏幕四条边溜达，走到边才停一会儿换下一条边，四个方向都能贴住屏幕边；拖它、点它、右键都照旧。',
    ready: true
  }
}

export default function DeskPetSection(): ReactElement {
  const [skin, setSkin] = useState<PetSkinId>('capsule')
  const [mode, setMode] = useState<PetMode>('island')
  // 用户点过就不再接受启动回填（与页面管理分区同一个防覆盖思路）
  const dirty = useRef(false)

  useEffect(() => {
    let alive = true
    window.island
      .prefsGet()
      .then((p) => {
        if (!alive || dirty.current) return
        if (p.petSkin) setSkin(p.petSkin)
        if (p.petMode) setMode(p.petMode)
      })
      .catch(() => {
        /* 读不到就用默认 */
      })
    // 岛里（或另一处）改了偏好也要跟上
    const off = window.island.onPrefsChanged((p) => {
      if (p.petSkin) setSkin(p.petSkin)
      if (p.petMode) setMode(p.petMode)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  const pickSkin = (id: PetSkinId): void => {
    dirty.current = true
    setSkin(id)
    window.island.prefsSet({ petSkin: id }).catch(() => {
      /* 写失败下次还是旧值，不打扰用户 */
    })
  }

  const pickMode = (m: PetMode): void => {
    dirty.current = true
    setMode(m)
    window.island.prefsSet({ petMode: m }).catch(() => {
      /* 同上 */
    })
  }

  const skins = listPetSkins()

  return (
    <div className="pet-set">
      {/* ---------- 预览：大尺寸画法，会呼吸会眨眼 ---------- */}
      <div className="pet-set-preview" data-skin={skin}>
        <Pet skin={skin} mood="idle" size="full" />
        <div className="pet-set-preview-name">{skins.find((s) => s.id === skin)?.name ?? '—'}</div>
      </div>

      {/* ---------- 皮肤 ---------- */}
      <div className="set-card pet-set-card">
        <div className="pet-set-head">形象</div>
        {skins.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`pet-set-skin ${skin === s.id ? 'on' : ''}`}
            data-skin-id={s.id}
            aria-pressed={skin === s.id}
            onClick={() => pickSkin(s.id as PetSkinId)}
          >
            <span className="pet-set-skin-thumb">
              <Pet skin={s.id} mood="idle" size="full" />
            </span>
            <span className="pet-set-skin-text">
              <span className="pet-set-skin-name">{s.name}</span>
              <span className="pet-set-skin-desc">{s.desc}</span>
            </span>
            <span className="pet-set-radio" aria-hidden="true" />
          </button>
        ))}
        <div className="pet-set-tip">
          想自己画一只？以后这里会支持「导入皮肤包」——一个文件夹放几张图就能换，不用改代码。
        </div>
      </div>

      {/* ---------- 出现模式 ---------- */}
      <div className="set-card pet-set-card">
        <div className="pet-set-head">出现在哪里</div>
        {PET_MODES.map((m) => {
          const meta = MODE_META[m]
          return (
            <button
              key={m}
              type="button"
              className={`pet-set-mode ${mode === m ? 'on' : ''} ${meta.ready ? '' : 'off'}`}
              data-mode={m}
              aria-pressed={mode === m}
              disabled={!meta.ready}
              onClick={() => meta.ready && pickMode(m)}
            >
              <span className="pet-set-mode-text">
                <span className="pet-set-mode-name">
                  {meta.label}
                  {meta.ready ? null : <span className="pet-set-soon">还没做</span>}
                </span>
                <span className="pet-set-mode-desc">{meta.desc}</span>
              </span>
              <span className="pet-set-radio" aria-hidden="true" />
            </button>
          )
        })}
        <div className="pet-set-tip">
          选「独立小窗口」后它会跑到桌面右下角，拖到哪下次就在哪；选「自由走动」它会沿屏幕四条边依次溜达，走到边贴住一会儿再换下一条边。
          两种模式下在它身上点右键都能收回岛里。
        </div>
      </div>
    </div>
  )
}
