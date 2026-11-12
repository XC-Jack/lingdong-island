import type { JSX } from 'react'
import { getPetSkin } from './index'
import type { PetMood, PetSize } from './types'

/**
 * 桌宠的对外入口（SPEC-deskpet-skin）。
 *
 * 调用方只说「我要哪个尺寸、什么情绪、用哪套皮肤」，具体画法由皮肤自己决定。
 * 这样 `App.tsx` 不用知道有几套皮肤，设置页也不用知道岛里长什么样。
 *
 * 为什么传 skinId 而不是直接传皮肤对象：皮肤对象里带函数，跨 IPC 传不出去；
 * 但这里只在渲染层内部用，传对象也行——选 id 是为了让 props 保持可序列化，
 * 将来 e2e 或独立小窗口可以直接把 prefs 里的值透传进来。
 */
export default function Pet({
  skin,
  mood = 'idle',
  size = 'tiny'
}: {
  /** 皮肤 id（来自 prefs.petSkin）；不传或查不到会回落默认皮肤 */
  skin?: string
  mood?: PetMood
  size?: PetSize
}): JSX.Element {
  const s = getPetSkin(skin)
  const Art = size === 'full' ? s.Full : s.Tiny
  return (
    <span className={`pet-wrap pet-wrap-${size}`} data-pet-skin={s.id} data-pet-size={size}>
      <Art mood={mood} />
    </span>
  )
}
