import type { JSX } from 'react'
import type { PetMood, PetSkin } from './types'
import bean from './skinBean'
import photoUrl from '../assets/pet/bean-photo.png'

/**
 * 皮肤 3：原图版（`skinPhoto`）。用户 2026-11-12 12:44 发来的参考图，抠成透明底后用。
 *
 * 为什么有了矢量版还要这一套：用户明确要求「大尺寸就用我这张脸」。
 * 矢量版（`skinBean`）是我照图描的近似，颜色和体型总有偏差；原图版是他自己的那一张，
 * 一字不差。两套并存，用户在设置里选，谁也不吃亏。
 *
 * 为什么 22px 不用这张图：位图缩到 22px 只剩一团黄，绿眼睛糊成两个脏点。
 * 所以这一套的 `Tiny` 直接复用黄豆矢量版的简版——同一个角色，小尺寸用画的，
 * 大尺寸用他的原图，视觉上是连贯的。
 *
 * 图从哪来：`src/renderer/src/assets/pet/bean-photo.png`（310×515，133 KB）。
 * 处理过程见 `docs/Spec/SPEC-deskpet-photo.md` —— 抠底 + 边缘抗锯齿，只留下角色本体。
 * 想换一张图，直接覆盖这个文件即可，不用改代码（尺寸比例变了要回来改下面的 VIEW 常量）。
 */

/** 画布边长（跟矢量版统一成 160，方便同一套 CSS 尺寸规则） */
const VIEW = 160
/**
 * 画布顶部额外留白。
 *
 * 为什么需要：这套皮肤的所有动画都是「以脚底为轴」做的——呼吸 `scaleY(1.025)` 往上长、
 * 开心 `translateY(-6%)` 往上跳、惊讶 `scaleY(1.05)` 往上弹。图本身几乎顶满画布，
 * 一放大就冲出 viewBox 上边界被裁掉，用户看到的是「呼吸时头被削掉一块」。
 * 实测：`IMG_H = 150` 时呼吸上顶 3.75 单位、开心上跳 9 单位，都被裁。
 * 留 10 单位刚好盖住最大的一种（开心 -6% = 9）。
 */
const PAD_TOP = 10
/** 图本身的高宽比（310 / 515），改图后要同步 */
const RATIO = 310 / 515
/** 图在画布里占的高度（扣掉顶部留白，底部还剩一点给投影） */
const IMG_H = VIEW - PAD_TOP - 10
const IMG_W = IMG_H * RATIO
const IMG_X = (VIEW - IMG_W) / 2
/** 图的顶边在画布里的纵坐标 */
const IMG_Y = PAD_TOP

function Full({ mood }: { mood: PetMood }): JSX.Element {
  const happy = mood === 'happy'
  const sleepy = mood === 'sleepy'
  const surprised = mood === 'surprised'
  return (
    <svg
      className={`pet-full pet-photo ${happy ? 'pet-photo-happy' : ''} ${
        sleepy ? 'pet-photo-sleepy' : ''
      } ${surprised ? 'pet-photo-surprised' : ''}`}
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      aria-hidden="true"
    >
      {/* 脚下的投影：图是平面照片，没有落地感，补一小片椭圆让它「站」在桌面上。
          呼吸/眨眼都动图本身，影子只跟着轻微变宽变淡，见 settings.css / styles.css。 */}
      <ellipse
        className="pet-photo-shadow"
        cx={VIEW / 2}
        cy={IMG_Y + IMG_H + 3.5}
        rx={IMG_W * 0.42}
        ry={4}
        fill="#000000"
        opacity="0.22"
      />
      {/* 呼吸作用在图本身：锚点放在脚底，缩放时脚不动、身体上下微微起伏 */}
      <image
        className="pet-photo-img"
        href={photoUrl}
        x={IMG_X}
        y={IMG_Y}
        width={IMG_W}
        height={IMG_H}
        preserveAspectRatio="xMidYMax meet"
      />
    </svg>
  )
}

const photo: PetSkin = {
  id: 'photo',
  name: '我的原图',
  desc: '用你给的那张参考图抠的透明底大图：大尺寸就是这个样子，一字不差。',
  // 22px 用矢量简版：位图缩到那个尺寸只剩一团黄
  Tiny: bean.Tiny,
  Full
}

export default photo
