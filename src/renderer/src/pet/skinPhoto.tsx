import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { PetMood, PetSkin } from './types'
import bean from './skinBean'
import frontUrl from '../assets/pet/bean-photo.png'
import sideUrl from '../assets/pet/bean-photo-side.png'
import backUrl from '../assets/pet/bean-photo-back.png'

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
 * 图从哪来：`src/renderer/src/assets/pet/bean-photo*.png`。
 * 处理过程见 `docs/Spec/SPEC-deskpet-photo.md` —— 抠底 + 边缘去污染 + 抗锯齿。
 * 想换一张图，直接覆盖同名文件即可，不用改代码（比例变了要回来改下面的常量）。
 *
 * ===== 四视图转身（2026-11-12 追加，见 SPEC-deskpet-turn）=====
 * 用户想要 3D，评估后选了成本低一档的做法：用正面 / 侧左 / 背面 / 侧右四张图
 * 依次切换，看起来像在转身。不是真 3D，但比一张静图有生气得多。
 *
 * 为什么四张图都按「同一高度、水平居中」摆：三张图是分三次抠的，各自的
 * 宽高比不同（310×515 / 230×521 / 322×518）。如果强行塞进同一个方框会拉变形，
 * 只统一高度、宽度按比例算，体型比例才跟原图一致。
 * 三张图的高度本来就只差几像素，统一高度后脚底自然对齐，不会「一抽一抽地长高」。
 *
 * 侧右不单独做图，是把侧左水平镜像——同一张图翻过来，省一份素材，
 * 而且镜像和原图严格对称，转身时左右不会不对称。
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
/** 图在画布里占的高度（扣掉顶部留白，底部还剩一点给投影） */
const IMG_H = VIEW - PAD_TOP - 10

/** 各视图的宽高比（改图后要同步，否则会拉变形） */
const RATIO_FRONT = 310 / 515
const RATIO_SIDE = 230 / 521
const RATIO_BACK = 322 / 518

interface ViewDef {
  /** 用于调试与 e2e 的稳定名字 */
  key: string
  src: string
  ratio: number
  /** 是否水平镜像（侧右 = 侧左的镜像） */
  mirror: boolean
}

const VIEWS: ViewDef[] = [
  { key: 'front', src: frontUrl, ratio: RATIO_FRONT, mirror: false },
  { key: 'side-l', src: sideUrl, ratio: RATIO_SIDE, mirror: false },
  { key: 'back', src: backUrl, ratio: RATIO_BACK, mirror: false },
  { key: 'side-r', src: sideUrl, ratio: RATIO_SIDE, mirror: true }
]

/** 每一格停多久（毫秒）。太快看不清，太慢像卡住 */
const TURN_STEP_MS = 260
/**
 * 转完一圈之后歇多久再转。
 *
 * 为什么要歇：一直转就成了陀螺，看着累。22 秒是试出来的——短到能感觉到
 * 「它活着」，长到不会让人分心。改成 0 就是一直转。
 */
const TURN_GAP_MS = 22000

/** 从当前视图开始转一圈：1 → 2 → 3 → 回到 0 */
const TURN_ORDER = [1, 2, 3, 0]

/**
 * 转身节拍器。
 *
 * 为什么用 state 而不是 CSS 关键帧：四张图各自的可见时长不一样（正面停得最久），
 * 用 CSS 得写四组关键帧再对齐时间轴，改一次数值要同步改四处。
 * 用 state 就是「现在是第几格」，切换一格渲染一次，一眼能看懂。
 *
 * 为什么监听 `pet:turn` 事件：e2e 不能等 22 秒。这个事件也留给以后的交互复用
 * （比如点它一下让它转个身）。它只是内部约定，没有写进 Preload 的对外 API。
 */
function useTurnStep(): number {
  const [step, setStep] = useState(0)

  useEffect(() => {
    // 这里**故意不**看 prefers-reduced-motion。
    //
    // 常规做法是尊重它（系统开了「关闭动画」就别动），但那说的是装饰性动效——
    // 页面切换、菜单弹出那种，晃一下纯属干扰。
    // 桌宠转身不是装饰，它是这个形象唯一的存在感：不动就是一张贴图。
    // 而且本机实测这个开关是开着的（minAnimate=0），照规矩尊重它等于功能直接消失，
    // 用户会以为坏了。真要让用户能关，应该做成设置项，跟系统开关解耦。

    let cancelled = false
    let timers: number[] = []

    const runTurn = (): void => {
      timers.forEach((t) => window.clearTimeout(t))
      timers = TURN_ORDER.map((s, i) =>
        window.setTimeout(() => {
          if (!cancelled) setStep(s)
        }, (i + 1) * TURN_STEP_MS)
      )
    }

    const onTurn = (): void => runTurn()
    window.addEventListener('pet:turn', onTurn)
    // 开着就先转一圈：等 22 秒才动，用户会以为这是个静态图。
    // 第一次给 3 秒，让人先看清正脸，再动。
    const first = window.setTimeout(runTurn, 3000)
    const gap = window.setInterval(runTurn, TURN_GAP_MS)

    return () => {
      cancelled = true
      timers.forEach((t) => window.clearTimeout(t))
      window.clearTimeout(first)
      window.clearInterval(gap)
      window.removeEventListener('pet:turn', onTurn)
    }
  }, [])

  return step
}

function Full({ mood }: { mood: PetMood }): JSX.Element {
  const happy = mood === 'happy'
  const sleepy = mood === 'sleepy'
  const surprised = mood === 'surprised'
  const step = useTurnStep()
  const front = VIEWS[0]

  return (
    <svg
      className={`pet-full pet-photo ${happy ? 'pet-photo-happy' : ''} ${
        sleepy ? 'pet-photo-sleepy' : ''
      } ${surprised ? 'pet-photo-surprised' : ''}`}
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      data-turn-step={step}
      data-turn-view={VIEWS[step].key}
      aria-hidden="true"
    >
      {/* 脚下的投影：图是平面照片，没有落地感，补一小片椭圆让它「站」在桌面上。
          宽度按正面算——转身时四个视图共用同一个影子，跟着统一起伏比各画各的稳。 */}
      <ellipse
        className="pet-photo-shadow"
        cx={VIEW / 2}
        cy={PAD_TOP + IMG_H + 3.5}
        rx={IMG_H * front.ratio * 0.42}
        ry={4}
        fill="#000000"
        opacity="0.22"
      />
      {/* 四层叠在一起，只有当前这一层不透明，其余的由 CSS 过渡淡入淡出。
          为什么四层都留在 DOM 里而不是只渲染一层：换图会闪一下（新图要解码），
          叠着淡出淡入就没有空帧，看起来才是「转过去」而不是「切过去」。 */}
      {VIEWS.map((v, i) => {
        const w = IMG_H * v.ratio
        const x = (VIEW - w) / 2
        return (
          <g
            key={v.key}
            className="pet-photo-layer-group"
            data-view={v.key}
            transform={v.mirror ? `translate(${VIEW} 0) scale(-1 1)` : undefined}
          >
            <image
              className={`pet-photo-img pet-photo-layer ${step === i ? 'is-on' : ''}`}
              data-layer={v.key}
              href={v.src}
              x={x}
              y={PAD_TOP}
              width={w}
              height={IMG_H}
              preserveAspectRatio="xMidYMax meet"
            />
          </g>
        )
      })}
    </svg>
  )
}

const photo: PetSkin = {
  id: 'photo',
  name: '我的原图',
  desc: '用你给的那张参考图抠的透明底大图，还会隔一会儿转个身。',
  // 22px 用矢量简版：位图缩到那个尺寸只剩一团黄
  Tiny: bean.Tiny,
  Full
}

export default photo
