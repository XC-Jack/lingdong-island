/**
 * e2e 颜色断言共用工具（辅助模块，本身不是 e2e 测试）。
 *
 * 背景（2026-11-27 批量验收发现）：
 *  1) SPEC-island-themes（2026-11-24）把默认主题从纯黑玻璃换成亮色乳白玻璃，
 *     多个 e2e 仍写死旧色值（纯白弧 #fff、绿 #4bd682、红 #ff6b6b），长期假红。
 *  2) Chrome 把 `color-mix(in srgb, X 90%, transparent)` 算成
 *     `color(srgb 0.07 0.53 0.29 / 0.9)`（分量 0–1），不再是 `rgb()`/`rgba()`，
 *     用字符串全等比较根本读不到。
 *
 * 做法：断言不写死色值，改为「读当前主题的 token，再算 RGB 距离」。
 * 换主题、换配色都自动跟随，不再腐化。
 *
 * 两条硬纪律（踩过坑）：
 *  1) PAGE_COLOR_JS 这段源码会被拼进模板字符串、再经 CDP 传进页面执行，
 *     所以里面**不能有反引号**（会提前截断外层模板字符串），
 *     也**不能写反斜杠转义**（传输过程中会被吃掉，`\s` 变成 `s`）。
 *     一律用字符类 `[0-9.]+` 取数字。
 *  2) Node 侧比较用「距离阈值」而不是字符串全等，容纳取整与 color-mix 舍入。
 */

/** 塞进页面执行的颜色解析源码（无反引号、无反斜杠，可安全嵌入模板字符串）。 */
export const PAGE_COLOR_JS = `const __pickColor = (s) => {
  if (!s) return null
  const at = s.indexOf('color(srgb')
  if (at >= 0) {
    const seg = s.slice(at, s.indexOf(')', at) + 1)
    const n = (seg.match(/[0-9.]+/g) || []).map(Number)
    if (n.length < 3) return null
    return [n[0] * 255, n[1] * 255, n[2] * 255]
  }
  const rgAt = s.indexOf('rgb')
  if (rgAt >= 0) {
    const seg = s.slice(rgAt, s.indexOf(')', rgAt) + 1)
    const n = (seg.match(/[0-9.]+/g) || []).map(Number)
    if (n.length < 3) return null
    return [n[0], n[1], n[2]]
  }
  return null
}`

/**
 * 页面表达式：把若干 CSS 变量解析成实际 rgb 三元组。
 * getPropertyValue 拿到的是原始写法（可能是 #hex），必须挂到元素上让浏览器算成 rgb。
 * @param {string[]} names 形如 ['--ok','--danger']
 * @returns {string} 可直接喂给 CDP Runtime.evaluate 的表达式
 */
export function resolveTokensExpr(names) {
  const list = names.map((n) => `'${n}'`).join(', ')
  return `(() => {
  ${PAGE_COLOR_JS}
  const names = [${list}]
  const out = {}
  for (const n of names) {
    const p = document.createElement('span')
    p.style.color = 'var(' + n + ')'
    document.body.appendChild(p)
    out[n] = __pickColor(getComputedStyle(p).color)
    p.remove()
  }
  return JSON.stringify(out)
})()`
}

/** Node 侧：把 'rgb(1,2,3)' / 'rgba(...)' / 'color(srgb 0.1 0.2 0.3 / a)' 解析成 [r,g,b]，失败返回 null。 */
export function parseCssColor(s) {
  if (!s || typeof s !== 'string') return null
  const at = s.indexOf('color(srgb')
  if (at >= 0) {
    const end = s.indexOf(')', at)
    const seg = s.slice(at, end === -1 ? undefined : end + 1)
    const n = (seg.match(/[0-9.]+/g) || []).map(Number)
    if (n.length < 3) return null
    return [n[0] * 255, n[1] * 255, n[2] * 255]
  }
  const rgAt = s.indexOf('rgb')
  if (rgAt >= 0) {
    const end = s.indexOf(')', rgAt)
    const seg = s.slice(rgAt, end === -1 ? undefined : end + 1)
    const n = (seg.match(/[0-9.]+/g) || []).map(Number)
    if (n.length < 3) return null
    return [n[0], n[1], n[2]]
  }
  return null
}

/** 距离阈值：同一 token 渲染出来应为 0；留 60² 的余量容纳取整与 color-mix 舍入。 */
export const NEAR = 60 ** 2

/** 两个颜色是否足够接近。任一为 null（取不到色）时判 false——不做静默放行。 */
export function near(a, b, threshold = NEAR) {
  if (!a || !b) return false
  const d2 = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
  return d2 < threshold
}

/** 是否明显不是某色（取不到色时也判 false，避免「读不到」被当成「不是该色」而假通过）。 */
export function notNear(a, b, threshold = NEAR) {
  if (!a || !b) return false
  return !near(a, b, threshold)
}

/** 便于日志：把 [r,g,b] 打印成 'rgb(1, 2, 3)'，null 打印 'none'。 */
export function fmt(c) {
  if (!c) return 'none'
  return 'rgb(' + c.map((n) => Math.round(n)).join(', ') + ')'
}
