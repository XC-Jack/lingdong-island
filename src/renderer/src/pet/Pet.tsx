import type { JSX } from 'react'
import { getPetSkin } from './index'
import type { PetAction, PetMood, PetSize } from './types'

/**
 * 桌宠的对外入口（SPEC-deskpet-skin）。
 *
 * 调用方只说「我要哪个尺寸、什么情绪、什么动作、用哪套皮肤」，具体画法由皮肤自己决定。
 * 这样 `App.tsx` 不用知道有几套皮肤，设置页也不用知道岛里长什么样。
 *
 * 为什么传 skinId 而不是直接传皮肤对象：皮肤对象里带函数，跨 IPC 传不出去；
 * 但这里只在渲染层内部用，传对象也行——选 id 是为了让 props 保持可序列化，
 * 将来 e2e 或独立小窗口可以直接把 prefs 里的值透传进来。
 *
 * `action`（SPEC-deskpet-action）：动作是一次性表演，只有实现了动作素材的皮肤会理它。
 * 没实现的两套皮肤（黄豆、胶囊）收到 `laugh` 也什么都不做——不是 bug，
 * 是「这套皮肤没有这支动作」的正常表现。
 */
export default function Pet({
  skin,
  mood = 'idle',
  action = 'idle',
  size = 'tiny'
}: {
  /** 皮肤 id（来自 prefs.petSkin）；不传或查不到会回落默认皮肤 */
  skin?: string
  mood?: PetMood
  /** 正在播的动作；不传等于没有动作 */
  action?: PetAction
  size?: PetSize
}): JSX.Element {
  const s = getPetSkin(skin)
  const Art = size === 'full' ? s.Full : s.Tiny
  return (
    <span
      className={`pet-wrap pet-wrap-${size}`}
      data-pet-skin={s.id}
      data-pet-size={size}
      data-pet-action={action}
    >
      {size === 'full' ? <Art mood={mood} action={action} /> : <Art mood={mood} />}
    </span>
  )
}
