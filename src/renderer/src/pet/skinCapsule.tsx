import type { JSX } from 'react'
import type { PetMood, PetSkin } from './types'

/**
 * 皮肤 1：紫胶囊（`skinCapsule`）。
 *
 * 这就是 2026-11-12 之前岛上那只「岛仔」——把 `App.tsx` 里原本内联的 `<Pet>` 原样搬过来，
 * 一个像素都没改。搬它有两个目的：
 * 1. 证明「皮肤包」这套架构能装下原有形象，不是只能装新画的；
 * 2. 升级不能让老用户突然看到另一个东西——所以 `petSkin` 缺失时默认就是它。
 *
 * 两种尺寸的画法差别（见 `types.ts`）：22px 的 tiny 就是原图；full 是这次新画的
 * 放大版，只在设置页预览里用到，形状沿用胶囊但补了高光和阴影。
 */

/** 22px：原封不动搬自 App.tsx 的 Pet 组件 */
function Tiny({ mood }: { mood: PetMood }): JSX.Element {
  const happy = mood === 'happy'
  return (
    <svg
      className={`collapsed-pet ${happy ? 'pet-happy' : ''}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <rect x="1" y="4" width="22" height="16" rx="8" fill="#4356b0" />
      {happy ? (
        <>
          {/* 开心：眼睛弯成 ^，嘴角上扬 */}
          <path
            className="pet-eye"
            d="M7 12.6q2-2.6 4 0"
            fill="none"
            stroke="#ffffff"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <path
            className="pet-eye"
            d="M13 12.6q2-2.6 4 0"
            fill="none"
            stroke="#ffffff"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <path
            d="M9.5 15.8q2.5 2.2 5 0"
            fill="none"
            stroke="#ffffff"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <path
            d="M19 2.4l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"
            fill="#ffd45e"
          />
        </>
      ) : (
        <>
          <circle className="pet-eye" cx="9" cy="12" r="1.9" fill="#ffffff" />
          <circle className="pet-eye" cx="15" cy="12" r="1.9" fill="#ffffff" />
        </>
      )}
    </svg>
  )
}

/**
 * 大尺寸：胶囊画法的放大版（160×160 画布）。
 *
 * 22px 版只有一颗纯色块 + 两个白点，放大到 160px 会非常单调，所以这里补了
 * 顶部高光、底部内阴影和脚下投影——但**轮廓、配色、五官位置与 22px 版完全一致**，
 * 用户看到的仍然是同一只宠物，不会觉得「换了个东西」。
 */
function Full({ mood }: { mood: PetMood }): JSX.Element {
  const happy = mood === 'happy'
  const sleepy = mood === 'sleepy'
  const surprised = mood === 'surprised'
  const eyeR = surprised ? 13 : 11
  return (
    <svg className="pet-full" viewBox="0 0 160 160" aria-hidden="true">
      <defs>
        <linearGradient id="capsuleBody" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#5f7be0" />
          <stop offset="55%" stopColor="#4356b0" />
          <stop offset="100%" stopColor="#2e3a78" />
        </linearGradient>
        <radialGradient id="capsuleSheen" cx="0.5" cy="0.1" r="0.7">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.42" />
          <stop offset="60%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* 脚下投影：让它在卡片上有「站着」的重量感 */}
      <ellipse cx="80" cy="147" rx="44" ry="8" fill="#000" opacity="0.22" />
      {/* 胶囊本体：140×98，圆角 49 = 完全半圆端 */}
      <rect x="10" y="26" width="140" height="98" rx="49" fill="url(#capsuleBody)" />
      <rect x="10" y="26" width="140" height="98" rx="49" fill="url(#capsuleSheen)" />
      {/* 高光条：一条细长白线从左上角斜着往下，制造玻璃感 */}
      <path
        d="M38 44q14-10 34-12"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.35"
        strokeWidth="6"
        strokeLinecap="round"
      />
      {happy ? (
        <>
          <path
            className="pet-eye"
            d="M46 80q11-14 22 0"
            fill="none"
            stroke="#ffffff"
            strokeWidth="7"
            strokeLinecap="round"
          />
          <path
            className="pet-eye"
            d="M92 80q11-14 22 0"
            fill="none"
            stroke="#ffffff"
            strokeWidth="7"
            strokeLinecap="round"
          />
          <path
            d="M64 102q16 14 32 0"
            fill="none"
            stroke="#ffffff"
            strokeWidth="6"
            strokeLinecap="round"
          />
          <path d="M132 12l3.4 8 8 3.4-8 3.4-3.4 8-3.4-8-8-3.4 8-3.4z" fill="#ffd45e" />
        </>
      ) : sleepy ? (
        <>
          <ellipse className="pet-eye" cx="57" cy="80" rx="11" ry="5" fill="#ffffff" />
          <ellipse className="pet-eye" cx="103" cy="80" rx="11" ry="5" fill="#ffffff" />
          <path
            d="M70 104h20"
            fill="none"
            stroke="#ffffff"
            strokeWidth="6"
            strokeLinecap="round"
          />
        </>
      ) : (
        <>
          <ellipse className="pet-eye" cx="57" cy="78" rx={eyeR} ry={eyeR + 1} fill="#ffffff" />
          <ellipse className="pet-eye" cx="103" cy="78" rx={eyeR} ry={eyeR + 1} fill="#ffffff" />
          {surprised ? (
            <ellipse cx="80" cy="106" rx="7" ry="9" fill="#141b2e" />
          ) : null}
        </>
      )}
    </svg>
  )
}

const capsule: PetSkin = {
  id: 'capsule',
  name: '胶囊',
  desc: '灵动岛最早的那只，蓝底白眼睛，一直在岛里待着。',
  Tiny,
  Full
}

export default capsule
