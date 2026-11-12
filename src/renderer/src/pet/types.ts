import type { JSX } from 'react'

/**
 * 桌宠形象层的公共类型（SPEC-deskpet-skin）。
 *
 * 为什么单独抽出这一层：岛仔原本是 `App.tsx` 里的一个内联函数，美术和界面代码混在一起，
 * 想换形象就得动主界面文件。抽出来之后，「换一只宠物」= 新增一个皮肤文件 + 在
 * `pet/index.tsx` 的清单里加一行，`App.tsx` 一行都不用改。
 *
 * 两种尺寸不是同一个组件缩放出来的，是两套画法（见各皮肤文件里的注释）：
 * - `tiny`：岛那条窄条里的 22px。只保留剪影级特征（轮廓 + 眼睛 + 嘴），别的全删，
 *   因为 22px 下肚子、手脚、渐变都糊成一团，画了也是白画。
 * - `full`：设置页预览、以后独立小窗口里的 120px+。完整部件 + 渐变 + 影子。
 */

/** 情绪：idle 平时（呼吸+眨眼），happy 被讨好时（弯眼+弹跳），sleepy 困（半闭眼），surprised 惊讶（睁大眼） */
export type PetMood = 'idle' | 'happy' | 'sleepy' | 'surprised'

/** 尺寸档：见上方注释 */
export type PetSize = 'tiny' | 'full'

/** 一套皮肤必须同时提供两种尺寸的画法 */
export interface PetSkin {
  /** 落盘用的稳定 id，写进 prefs.json，改了就等于用户的选择丢失——不要改 */
  id: string
  /** 设置页显示的名字 */
  name: string
  /** 设置页显示的一句话说明 */
  desc: string
  /** 22px 版：挂在岛里 */
  Tiny: (props: { mood: PetMood }) => JSX.Element
  /** 大尺寸版：设置页预览 / 将来的独立小窗口 */
  Full: (props: { mood: PetMood }) => JSX.Element
}
