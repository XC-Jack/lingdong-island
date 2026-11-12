import type { PetSkinId } from '../../../shared/types'
import type { PetSkin } from './types'
import capsule from './skinCapsule'
import bean from './skinBean'

/**
 * 皮肤清单（SPEC-deskpet-skin）。
 *
 * 加一套新皮肤的步骤，只有两步：
 * 1. 在 `src/shared/types.ts` 的 `PET_SKIN_IDS` 里加上新 id（主进程要拿它做白名单校验）；
 * 2. 在本文件 `PET_SKINS` 数组里加一项。
 * `App.tsx`、设置页、prefsStore 都不用动。
 *
 * 数组顺序就是设置页里的展示顺序；第一项是「默认皮肤」，`petSkin` 缺失时用它。
 */
const PET_SKINS: PetSkin[] = [capsule, bean]

/** 默认皮肤：prefs 里没有 petSkin（老用户升级）时用它，保证不换脸 */
export const DEFAULT_PET_SKIN: PetSkinId = 'capsule'

/** 设置页展示用：全部皮肤 */
export function listPetSkins(): PetSkin[] {
  return PET_SKINS
}

/**
 * 按 id 取皮肤；取不到就回落默认。
 *
 * 必须容错而不是抛错：这个 id 来自 prefs.json（明文文件，用户可能手改出乱码），
 * 抛错会让整个岛的渲染挂掉，用户看到的是「灵动岛不见了」——比换成旧形象严重得多。
 */
export function getPetSkin(id: string | undefined | null): PetSkin {
  const hit = PET_SKINS.find((s) => s.id === id)
  return hit ?? PET_SKINS.find((s) => s.id === DEFAULT_PET_SKIN) ?? PET_SKINS[0]
}
