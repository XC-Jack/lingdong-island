import { app, ipcMain } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LyricLine, LyricQuery, LyricResult } from '../shared/types'

/**
 * 歌词数据源（SPEC-music-lyric）。
 *
 * 为什么不从播放器里直接读：Windows SMTC 只给 歌名/歌手/专辑/进度/时长/播放状态/封面，
 * 没有歌词字段；汽水音乐的 LunaCacheV2 是私有压缩二进制，解不开、也随版本失效。
 * 所以歌词只能另外去公开歌词库查。
 *
 * 为什么用 lrclib.net：公开、免费、不用注册也不用 key，直接 GET 就返回 JSON，
 * 而且带 LRC 时间轴（`syncedLyrics`），正好能对上进度滚动。
 *
 * 三级降级（用户 m05013「可以按你的来」已确认）：
 *   1. 本地缓存优先——`userData/lyrics/*.json`，断网可用、秒出、不再联网；
 *   2. 没有就联网查 lrclib（只在换歌时查一次，只发 歌名/歌手/专辑/时长 四个字段）；
 *   3. 都拿不到就返回 ok=false + 一句具体原因，界面显示「暂无歌词」。
 *      **任何情况下都不编造歌词文本**——这是 SPEC 里写死的红线。
 */

/** 联网超时：超过就放弃这次查询，界面显示原因，不卡住界面 */
const FETCH_TIMEOUT_MS = 6000
/** 同名不同版本的时长容差（秒）：差超过这个数基本不是同一版，宁可显示暂无也不张冠李戴 */
const DURATION_TOLERANCE = 8

const LRC_API = 'https://lrclib.net/api'

/**
 * 缓存格式版本。改了歌词解析逻辑就要 +1，让旧缓存整体失效。
 *
 * 用户 m05794 那次：`parseLrc` 漏剥逐字时间标记 `<00:00.352>`，把陈年乱码写进了缓存文件；
 * 只改解析不改版本号的话，同一首歌永远读回那堆带尖括号的旧数据。
 */
const CACHE_VERSION = 2

/**
 * 把 歌名/歌手/专辑/时长 压成一个稳定缓存键。
 * 用哈希而不是拼接后的文件名：中文、斜杠、问号、超长歌名都可能出现，直接当文件名会出事。
 */
function cacheKey(q: LyricQuery): string {
  const norm = [q.title.trim(), q.artist.trim(), q.album.trim(), String(Math.round(q.duration))]
    .join('\u0001')
    .toLowerCase()
  return createHash('sha1').update(norm, 'utf8').digest('hex')
}

function cacheDir(): string {
  const dir = join(app.getPath('userData'), 'lyrics')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function readCache(key: string): LyricResult | null {
  try {
    const file = join(cacheDir(), `${key}.json`)
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      version?: number
      result?: LyricResult
    }
    // 版本对不上就当没有：旧版本解析出来的歌词可能本身就是坏的（见 CACHE_VERSION 注释）
    if (raw?.version !== CACHE_VERSION) return null
    const r = raw?.result
    // 只认「查到了歌词」的缓存；没查到的下次换歌再试（网络可能只是当时断了）
    if (!r || !r.ok || !Array.isArray(r.lines) || r.lines.length === 0) return null
    return { ...r, source: 'cache' }
  } catch {
    // 缓存坏了就当没有，不能让一个坏文件挡住整个功能
    return null
  }
}

function writeCache(key: string, result: LyricResult): void {
  try {
    const file = join(cacheDir(), `${key}.json`)
    writeFileSync(
      file,
      JSON.stringify({ version: CACHE_VERSION, savedAt: Date.now(), result }, null, 2),
      'utf8'
    )
  } catch {
    // 写不进去（磁盘满/权限）不影响这次显示，只是下次还得联网，静默即可
  }
}

/**
 * 解析 LRC 时间轴。返回按时间升序、去掉空行的歌词。
 *
 * 支持：
 *  - 一行多个时间标记 `[00:12.30][00:15.00]同一句`
 *  - 元信息行 `[ti:]` `[ar:]` `[al:]` `[by:]` `[offset:]` → 丢掉
 *  - 时间格式 `[mm:ss.xx]` / `[mm:ss.xxx]` / `[mm:ss]`
 *  - 逐字时间轴（Enhanced LRC / word-level）：`[00:00.00]<00:00.000>美<00:00.352>人…`
 *    用户 m05794 报「一些歌的歌词直接就是乱码」，真源就是这种格式：
 *    行首 `[...]` 剥掉后，后面 `<00:00.352>` 这一串逐字标记被原样当成歌词文字显示出来。
 *    这些尖括号标记只标「这个字从第几秒开始唱」，对逐行滚动没用，全部删掉、保留字本身。
 */
function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = []
  const timeRe = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
  const wordRe = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g
  for (const rawLine of lrc.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    timeRe.lastIndex = 0
    const times: number[] = []
    let m: RegExpExecArray | null
    let lastEnd = 0
    while ((m = timeRe.exec(line)) !== null) {
      const min = Number(m[1])
      const sec = Number(m[2])
      const fracRaw = m[3] ?? '0'
      // 小数位按位数换算：`.5` 是 500ms、`.50` 是 500ms、`.500` 也是 500ms
      const frac = Number(fracRaw) / Math.pow(10, fracRaw.length)
      times.push(min * 60 + sec + frac)
      lastEnd = m.index + m[0].length
    }
    if (times.length === 0) continue // 纯元信息行或本来就没时间的行
    // 先剥逐字标记再取文字：`<mm:ss.xxx>` 之间夹的是真正的字，只能删标记、不能丢整行
    const text = line.slice(lastEnd).replace(wordRe, '').trim()
    if (!text) continue // 时间标记后面没字（常见于纯间奏标记），丢掉
    for (const t of times) out.push({ time: Math.round(t * 100) / 100, text })
  }
  out.sort((a, b) => a.time - b.time)
  return out
}

/** 歌名归一化：小写、去掉括号里的版本说明、去掉空白和常见标点，便于做相似度比较 */
function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[（(【\[].*?[)）】\]]/g, '')
    .replace(/[\s\-_·、,，.。!！?？'"“”‘’]/g, '')
    .trim()
}

interface LrclibItem {
  id?: number
  trackName?: string
  artistName?: string
  albumName?: string
  duration?: number
  instrumental?: boolean
  plainLyrics?: string | null
  syncedLyrics?: string | null
}

/**
 * 给一条 lrclib 结果打分，挑最可能是「同一首歌、同一版本」的那条。
 *
 * 三个信号（用户已确认的匹配思路）：
 *  - 歌名：归一化后相等给 60，互相包含给 40，否则 0；
 *  - 歌手：归一化后相等给 25，互相包含给 15，否则 0；
 *  - 时长：差 ≤3 秒给 20，≤8 秒给 12，超过 8 秒给 0 并**直接判为不是同一版**。
 */
function scoreItem(item: LrclibItem, q: LyricQuery): number {
  const mineName = normName(q.title)
  const itemName = normName(item.trackName ?? '')
  if (!mineName || !itemName) return -1

  const durDiff = Math.abs((item.duration ?? 0) - q.duration)
  // 时长差太多一定不是同一版：DJ 版、现场版、remix 经常同名同歌手但完全不同
  if (q.duration > 0 && item.duration && durDiff > DURATION_TOLERANCE) return -1

  let score = 0
  if (mineName === itemName) score += 60
  else if (mineName.includes(itemName) || itemName.includes(mineName)) score += 40
  else return -1

  const mineArtist = normName(q.artist)
  const itemArtist = normName(item.artistName ?? '')
  if (mineArtist && itemArtist) {
    if (mineArtist === itemArtist) score += 25
    else if (mineArtist.includes(itemArtist) || itemArtist.includes(mineArtist)) score += 15
  }

  if (item.duration && q.duration > 0) {
    if (durDiff <= 3) score += 20
    else if (durDiff <= DURATION_TOLERANCE) score += 12
  }

  return score
}

async function fetchJson(url: string): Promise<unknown | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        // lrclib 要求带上能识别客户端的 UA，否则部分 IP 会被限流
        'User-Agent': 'lingdong-island/0.1.0 (https://github.com/; local desktop widget)',
        Accept: 'application/json'
      }
    })
    if (!res.ok) return null
    return (await res.json()) as unknown
  } catch {
    // 断网、超时、被墙都走这里：返回 null，交给上层给一句原因
    return null
  } finally {
    clearTimeout(timer)
  }
}

function pickLines(item: LrclibItem): LyricLine[] {
  if (item.syncedLyrics) {
    const parsed = parseLrc(item.syncedLyrics)
    if (parsed.length > 0) return parsed
  }
  // 没有时间轴的就当没有：歌词滚不起来，硬塞进右栏反而误导（用户要的是跟着播放走）
  return []
}

/**
 * 联网查一次 lrclib。先走精确接口 `/api/get`（歌名+歌手+专辑+时长，最准），
 * 不成再走 `/api/search` 拿一堆结果按打分挑最好的一条。
 */
async function lookupRemote(q: LyricQuery): Promise<LyricResult> {
  const fail = (reason: string): LyricResult => ({
    ok: false,
    title: q.title,
    artist: q.artist,
    source: 'none',
    lines: [],
    reason
  })

  if (!q.title.trim()) return fail('当前歌曲没有歌名，查不了歌词')

  const params = new URLSearchParams({
    track_name: q.title.trim(),
    artist_name: q.artist.trim()
  })
  if (q.album.trim()) params.set('album_name', q.album.trim())
  if (q.duration > 0) params.set('duration', String(Math.round(q.duration)))

  // 第一优先：精确接口。404 表示没收录，其余错误（断网/超时）当作网络问题
  const exact = await fetchJson(`${LRC_API}/get?${params.toString()}`)
  if (exact && typeof exact === 'object' && !Array.isArray(exact)) {
    const item = exact as LrclibItem
    if (item.instrumental) return fail('纯音乐，没有歌词')
    const lines = pickLines(item)
    if (lines.length > 0) {
      return { ok: true, title: q.title, artist: q.artist, source: 'lrclib', lines, reason: '' }
    }
  }

  // 第二优先：搜索。中文翻唱 / DJ 版经常精确接口查不到，但搜索能搜到同曲
  const searchQ = [q.title.trim(), q.artist.trim()].filter(Boolean).join(' ')
  const search = await fetchJson(`${LRC_API}/search?q=${encodeURIComponent(searchQ)}`)
  if (!Array.isArray(search)) {
    return fail('连不上歌词库（lrclib.net），请检查网络后重试')
  }
  const items = (search as LrclibItem[])
    .map((it) => ({ it, score: scoreItem(it, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)

  if (items.length === 0) {
    return fail('lrclib 上没收录这首歌（中文翻唱、DJ 版常常没有）')
  }
  const best = items[0].it
  if (best.instrumental) return fail('纯音乐，没有歌词')
  const lines = pickLines(best)
  if (lines.length === 0) {
    return fail('找到这首歌但没有带时间轴的歌词，滚不起来')
  }
  return { ok: true, title: q.title, artist: q.artist, source: 'lrclib', lines, reason: '' }
}

/** 同一首歌的并发请求合并成一次，避免列表滚动/重渲染时连发好几次 */
const inflight = new Map<string, Promise<LyricResult>>()

async function getLyrics(q: LyricQuery): Promise<LyricResult> {
  const key = cacheKey(q)
  const hit = readCache(key)
  if (hit) return hit

  const running = inflight.get(key)
  if (running) return running

  const task = (async (): Promise<LyricResult> => {
    try {
      const r = await lookupRemote(q)
      if (r.ok) writeCache(key, r)
      return r
    } catch {
      return {
        ok: false,
        title: q.title,
        artist: q.artist,
        source: 'none',
        lines: [],
        reason: '查歌词时出错了，稍后换一首歌再试'
      }
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, task)
  return task
}

export function setupLyricStore(): void {
  ipcMain.handle('lyric:get', async (_e, q: LyricQuery): Promise<LyricResult> => {
    if (!q || typeof q.title !== 'string') {
      return { ok: false, title: '', artist: '', source: 'none', lines: [], reason: '没有可查的歌曲信息' }
    }
    return getLyrics({
      title: String(q.title ?? ''),
      artist: String(q.artist ?? ''),
      album: String(q.album ?? ''),
      duration: Number(q.duration) || 0
    })
  })
}
