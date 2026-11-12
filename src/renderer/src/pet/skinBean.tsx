import type { JSX } from 'react'
import type { PetMood, PetSkin } from './types'

/**
 * 皮肤 2：黄豆小怪兽（`skinBean`）。按用户 2026-11-12 给的参考图描的矢量版。
 *
 * 参考图是一只 3D 渲染的黄色豆形生物：亮黄身体、米白大肚子、绿色眼睛（绿底黑瞳）、
 * 深灰棕的小手小脚、一条微笑弧线。这里没有做 3D——22px 尺寸下立体感完全消失，
 * 做 3D 只剩成本。做法是「把九种形状摊平成 SVG」，软质感靠径向渐变和脚下投影补。
 *
 * 两种画法的取舍（见 `types.ts`）：
 * - `Tiny`（22px，岛里）：只留黄团轮廓 + 两绿眼 + 一条嘴。肚子、手脚、渐变全删——
 *   22px 下它们各自不到 2px，画出来只会糊成一团脏色。
 * - `Full`（160px，设置页预览）：完整九部件 + 渐变 + 手脚本 + 脚下的影子。
 *
 * 改这里要注意的事：e2e（`scripts/e2e-m2.mjs`）要求 `.collapsed-pet` 存在、
 * `.pet-eye` 恰好 2 个、开心时根节点带 `.pet-happy`——加部件时不要把眼珠子拆成多个
 * `pet-eye`，否则眨眼动画和测试都会乱。
 */

/* ---------- 22px：岛里那只 ---------- */

function Tiny({ mood }: { mood: PetMood }): JSX.Element {
  const happy = mood === 'happy'
  const sleepy = mood === 'sleepy'
  const surprised = mood === 'surprised'
  return (
    <svg
      className={`collapsed-pet ${happy ? 'pet-happy' : ''}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="beanTinyBody" cx="0.38" cy="0.28" r="0.82">
          <stop offset="0%" stopColor="#FFE869" />
          <stop offset="58%" stopColor="#FFD400" />
          <stop offset="100%" stopColor="#F2A800" />
        </radialGradient>
      </defs>
      {/* 身体：上窄下宽的豆形。底部两个小脚直接压在轮廓上，省掉独立形状 */}
      <path
        d="M12 2.9c4.5 0 6.9 3.3 6.9 7.6 0 .8.1 1.6.3 2.4.7 2.9-.4 6-2.9 7-1 .4-2.6.6-4.3.6s-3.3-.2-4.3-.6c-2.5-1-3.6-4.1-2.9-7 .2-.8.3-1.6.3-2.4 0-4.3 2.4-7.6 6.9-7.6Z"
        fill="url(#beanTinyBody)"
      />
      {/* 米白肚子：22px 下只留一条淡淡的高光弧，不画整块椭圆（会显得脏） */}
      <path d="M8.4 15.6q3.6 2 7.2 0" fill="none" stroke="#F5EFE3" strokeWidth="1.5" strokeOpacity="0.75" strokeLinecap="round" />
      {happy ? (
        <>
          {/* 开心：眼睛弯成两条绿弧 */}
          <path className="pet-eye" d="M7.4 11.6q1.7-2 3.4 0" fill="none" stroke="#5FBF6A" strokeWidth="1.7" strokeLinecap="round" />
          <path className="pet-eye" d="M13.2 11.6q1.7-2 3.4 0" fill="none" stroke="#5FBF6A" strokeWidth="1.7" strokeLinecap="round" />
          <path d="M9.8 14.1q2.2 2.2 4.4 0" fill="none" stroke="#4A3B2E" strokeWidth="1.2" strokeLinecap="round" />
        </>
      ) : sleepy ? (
        <>
          {/* 困：眼睛压成两条横线 */}
          <path className="pet-eye" d="M7.6 11.9h3.2" fill="none" stroke="#5FBF6A" strokeWidth="1.7" strokeLinecap="round" />
          <path className="pet-eye" d="M13.2 11.9h3.2" fill="none" stroke="#5FBF6A" strokeWidth="1.7" strokeLinecap="round" />
          <path d="M10.4 14.4h3.2" fill="none" stroke="#4A3B2E" strokeWidth="1.2" strokeLinecap="round" />
        </>
      ) : (
        <>
          {/* 常态：绿眼珠 + 黑瞳。两个 <g> 各自一颗，保持 .pet-eye 总数 = 2 */}
          <g className="pet-eye">
            <circle cx="9.1" cy="11.3" r={surprised ? 2.4 : 2.1} fill="#5FBF6A" />
            <circle cx="9.1" cy="11.4" r={surprised ? 1.2 : 1} fill="#1B1108" />
          </g>
          <g className="pet-eye">
            <circle cx="14.9" cy="11.3" r={surprised ? 2.4 : 2.1} fill="#5FBF6A" />
            <circle cx="14.9" cy="11.4" r={surprised ? 1.2 : 1} fill="#1B1108" />
          </g>
          {surprised ? (
            <ellipse cx="12" cy="15" rx="1.5" ry="1.9" fill="#4A3B2E" />
          ) : (
            <path d="M10 14.5q2 1.7 4 0" fill="none" stroke="#4A3B2E" strokeWidth="1.1" strokeLinecap="round" />
          )}
        </>
      )}
    </svg>
  )
}

/* ---------- 160px：设置页预览（以及以后独立小窗口用） ---------- */

function Full({ mood }: { mood: PetMood }): JSX.Element {
  const happy = mood === 'happy'
  const sleepy = mood === 'sleepy'
  const surprised = mood === 'surprised'
  return (
    <svg className="pet-full" viewBox="0 0 160 160" aria-hidden="true">
      <defs>
        <radialGradient id="beanBody" cx="0.36" cy="0.24" r="0.86">
          <stop offset="0%" stopColor="#FFEE8C" />
          <stop offset="42%" stopColor="#FFD400" />
          <stop offset="82%" stopColor="#F5B800" />
          <stop offset="100%" stopColor="#E09A00" />
        </radialGradient>
        <radialGradient id="beanBelly" cx="0.45" cy="0.32" r="0.78">
          <stop offset="0%" stopColor="#FFFBF2" />
          <stop offset="70%" stopColor="#F5EFE3" />
          <stop offset="100%" stopColor="#E7DFCD" />
        </radialGradient>
        <radialGradient id="beanLimb" cx="0.4" cy="0.3" r="0.8">
          <stop offset="0%" stopColor="#6B5442" />
          <stop offset="100%" stopColor="#4A3B2E" />
        </radialGradient>
        <radialGradient id="beanEye" cx="0.38" cy="0.3" r="0.8">
          <stop offset="0%" stopColor="#86D68F" />
          <stop offset="60%" stopColor="#5FBF6A" />
          <stop offset="100%" stopColor="#3F9B4C" />
        </radialGradient>
      </defs>

      {/* 脚下的投影：不做这块，角色会像贴在纸上 */}
      <ellipse cx="80" cy="146" rx="42" ry="7" fill="#000000" opacity="0.18" />

      {/* 手：两颗水滴，收在身体两侧偏下 */}
      <path d="M31 92c-7 3-11 11-9 18 2 6 9 8 13 3 4-6 3-16-4-21Z" fill="url(#beanLimb)" />
      <path d="M129 92c7 3 11 11 9 18-2 6-9 8-13 3-4-6-3-16 4-21Z" fill="url(#beanLimb)" />

      {/* 脚：两只扁椭圆，压在身体底缘上 */}
      <ellipse cx="61" cy="131" rx="16" ry="9" fill="url(#beanLimb)" />
      <ellipse cx="99" cy="131" rx="16" ry="9" fill="url(#beanLimb)" />

      {/* 身体：上窄下宽的豆形（贝塞尔拼的，改形状就改这四个控制点） */}
      <path
        d="M80 18c23 0 40 18 40 44 0 6 .6 10.6 2 16.4 4.4 18.4-1 40-16 49.6-9 5.4-43 5.4-52 0-15-9.6-20.4-31.2-16-49.6 1.4-5.8 2-10.4 2-16.4 0-26 17-44 40-44Z"
        fill="url(#beanBody)"
      />

      {/* 肚子：大椭圆，偏下 */}
      <ellipse cx="80" cy="102" rx="33" ry="23" fill="url(#beanBelly)" />

      {/* 高光：左上角一小片，模拟参考图那种塑料/软胶质感 */}
      <ellipse cx="60" cy="38" rx="13" ry="9" fill="#FFFFFF" opacity="0.34" transform="rotate(-22 60 38)" />

      {happy ? (
        <>
          <path className="pet-eye" d="M55 68q11-15 22 0" fill="none" stroke="#4FAA5C" strokeWidth="7" strokeLinecap="round" />
          <path className="pet-eye" d="M83 68q11-15 22 0" fill="none" stroke="#4FAA5C" strokeWidth="7" strokeLinecap="round" />
          <path d="M68 86q12 12 24 0" fill="none" stroke="#4A3B2E" strokeWidth="5" strokeLinecap="round" />
          {/* 开心时的小星星：沿用紫胶囊那只的同款彩蛋 */}
          <path d="M132 14l3.4 8 8 3.4-8 3.4-3.4 8-3.4-8-8-3.4 8-3.4z" fill="#FFD45E" />
        </>
      ) : sleepy ? (
        <>
          <ellipse className="pet-eye" cx="66" cy="68" rx="11" ry="5" fill="url(#beanEye)" />
          <ellipse className="pet-eye" cx="94" cy="68" rx="11" ry="5" fill="url(#beanEye)" />
          <path d="M71 88h18" fill="none" stroke="#4A3B2E" strokeWidth="5" strokeLinecap="round" />
        </>
      ) : (
        <>
          <g className="pet-eye">
            <circle cx="66" cy="66" r={surprised ? 13 : 11.5} fill="url(#beanEye)" />
            <circle cx="67" cy="68" r={surprised ? 6 : 5} fill="#1B1108" />
            <circle cx="63.5" cy="62" r="2.6" fill="#FFFFFF" opacity="0.85" />
          </g>
          <g className="pet-eye">
            <circle cx="94" cy="66" r={surprised ? 13 : 11.5} fill="url(#beanEye)" />
            <circle cx="95" cy="68" r={surprised ? 6 : 5} fill="#1B1108" />
            <circle cx="91.5" cy="62" r="2.6" fill="#FFFFFF" opacity="0.85" />
          </g>
          {surprised ? (
            <ellipse cx="80" cy="90" rx="6" ry="7.5" fill="#4A3B2E" />
          ) : (
            /* 嘴：一条细弧线，两端略上翘 */
            <path d="M70 86q10 9 20 0" fill="none" stroke="#4A3B2E" strokeWidth="4.5" strokeLinecap="round" />
          )}
        </>
      )}
    </svg>
  )
}

const bean: PetSkin = {
  id: 'bean',
  name: '黄豆小怪兽',
  desc: '按你给的参考图描的矢量版：亮黄身体、米白肚子、绿眼睛。',
  Tiny,
  Full
}

export default bean
