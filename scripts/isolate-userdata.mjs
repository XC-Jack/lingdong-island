/**
 * e2e 数据隔离 helper（辅助脚本，本身不是 e2e 测试）。
 *
 * 背景：33 个 e2e 脚本都自己 spawn 一个 dev electron，默认会读写
 * %APPDATA%\lingdong-island\ 里的真实用户数据（todos.json / prefs.json /
 * shelf.json / schedule.json / notif-read.json 等）。本模块在【模块顶层】
 * 把 APPDATA 指向 .tmp/e2e-userdata 这个伪 Roaming，并给每个 electron
 * 启动参数追加 --user-data-dir，使「脚本读文件路径」与「主进程写文件路径」
 * 一起落到同一个隔离目录，真实用户数据不再被 e2e 碰到。
 *
 * 实测依据（2026-11-09，.tmp/ 一次性探针，不进交付提交）：
 *  - 只设环境变量 APPDATA / ELECTRON_USER_DATA / CHROME_USER_DATA_DIR /
 *    XDG_CONFIG_HOME / LINGDONG_USER_DATA 都无效：Electron 在 Windows 走
 *    CSIDL，app.getPath('userData') 仍是 C:\Users\honor\AppData\Roaming\<name>；
 *  - --user-data-dir=<path> 有效，能把整个 Chromium profile 搬走，
 *    app.getPath('userData') 直接返回该 path；
 *  - name=lingdong-island 的探针 app 带 --user-data-dir 启动、建隐藏窗口让
 *    Chromium 子系统真起来后，真实 %APPDATA%\lingdong-island 跑前跑后
 *    114 个文件零变化（added/removed/changed 全空）；
 *  - 同时改 APPDATA + 加 --user-data-dir（本 helper 的真实行为）复测，
 *    真实目录同样零变化，隔离目录里正常生成 Cache/Local State/Preferences 等。
 *
 * 用法：把脚本里的
 *   import { spawn, execSync } from 'node:child_process'
 * 改成
 *   import { spawn, execSync } from './isolate-userdata.mjs'
 * 即可，spawn 调用行不用动。需要隔离目录路径的脚本可额外 import { USER_DATA }。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 透传 execSync / execFileSync / spawnSync 等；本地显式导出的 spawn 优先于这里的同名项。
export * from 'node:child_process'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FAKE_ROAMING = join(ROOT, '.tmp', 'e2e-userdata')
export const USER_DATA = join(FAKE_ROAMING, 'lingdong-island')

// 顶层同步执行：ESM 依赖先求值，故各脚本模块体里
// `const USER_DATA = join(process.env.APPDATA, 'lingdong-island')`
// 会读到这里的伪 APPDATA，自动落到隔离目录。
mkdirSync(USER_DATA, { recursive: true })
process.env.APPDATA = FAKE_ROAMING

/**
 * 包一层 spawn：只给「启动 dev electron」的那次调用追加 --user-data-dir，
 * 判据是参数数组含 --remote-debugging-port（全部 32 个 electron 启动都带）。
 * 其它 spawn（powershell / taskkill / 子进程 node）原样透传，不加参数。
 */
export function spawn(file, args, options) {
  if (
    Array.isArray(args) &&
    args.some((a) => String(a).startsWith('--remote-debugging-port')) &&
    !args.some((a) => String(a).startsWith('--user-data-dir'))
  ) {
    args = [...args, `--user-data-dir=${USER_DATA}`]
  }
  return nodeSpawn(file, args, options)
}
