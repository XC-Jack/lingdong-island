import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppInfo, AvoidMode, CleanupItemDef, CleanupItemScan, CleanupRunResult, CleanupScope, CleanupTargetId, ClockFormat, IslandTheme, LyricQuery, LyricResult, MusicCommand, MusicState, NeteaseCdpMode, PetMode, PetSkinId, PetWindowPos, AdminCleanupId, AdminCleanupRunResult, AdminCleanupScanResult, ResidueBackup, ResidueCleanResult, ResidueScanResult, SettingsSection, ShelfItem, ShelfOpenResult, ShelfRevealResult, SoftwareResidueScanResult, ResidueCleanupRunResult, ResidueUndoResult, ResidueCleanupBackup, ResidueDiscardBackupResult, Todo, UpdateState } from '../shared/types'

export type { Todo, ShelfItem, ShelfOpenResult, ShelfRevealResult, SettingsSection, AppInfo, MusicState, MusicCommand, LyricQuery, LyricResult, UpdateState, CleanupItemDef, CleanupItemScan, CleanupRunResult, CleanupScope, CleanupTargetId, ResidueScanResult, ResidueCleanResult, ResidueBackup, SoftwareResidueScanResult, ResidueCleanupRunResult, ResidueUndoResult, ResidueCleanupBackup, ResidueDiscardBackupResult, AdminCleanupScanResult, AdminCleanupRunResult, AdminCleanupId }

/** Wi-Fi / 网线状态（收起态 US-005，与主进程 statusStore 保持一致） */
export interface WifiSnapshot {
  connected: boolean
  online: boolean
  name: string | null
  /** 连接方式：'wifi' 无线 / 'ethernet' 网线 */
  kind: 'wifi' | 'ethernet'
}

/** 收起态状态栏的数据快照（与主进程 statusStore 保持一致） */
export interface StatusSnapshot {
  battery: number | null
  charging: boolean
  /** Wi-Fi 状态；读不到时为 null（UI 不显示图标） */
  wifi: WifiSnapshot | null
}

/** 通知页数据（与主进程 notifyStore 保持一致） */
export interface NotifyItem {
  id: number
  order: number
  app: string
  /** 应用图标 PNG 绝对路径（file:// 显示）；解析失败为 null（UI 退回应用名文字徽标） */
  icon: string | null
  title: string
  body: string
  arrival: number
  /** toast 的 launch 深链（点击直达来源界面）；无属性为 null */
  launch: string | null
}

export interface NotifyListResult {
  items: NotifyItem[]
  unread: number
  /**
   * 已读水位：`item.order > lastOrder` 即未读。
   * 渲染层用它给未读条目画蓝点（美化-04），只读，不改语义。
   */
  lastOrder: number
}

/** 拖放落盘后的回调登记表（跨闭包广播，不走 ipcRenderer 事件——emit/on 参数语义容易踩坑） */
const shelfAddedCbs: ((list: ShelfItem[]) => void)[] = []

const api = {
  /** 请求主进程把窗口切到展开/收起尺寸 */
  setExpanded(value: boolean): void {
    ipcRenderer.send('island:set-expanded', value)
  },
  /** 收起态内容宽度上报（主进程按它定窗口宽，clamp 150~320） */
  setCollapsedWidth(px: number): void {
    ipcRenderer.send('island:set-collapsed-width', px)
  },
  /** 展开态内容尺寸上报（主进程 clamp 到 255~540 × 113~315 后定窗口大小）。
   *  返回主进程实际采用的尺寸：切页时渲染层等这个回执再显示新页（SPEC-switch-size-sync）。 */
  setExpandedSize(w: number, h: number): Promise<{ width: number; height: number }> {
    return ipcRenderer.invoke('island:set-expanded-size', w, h)
  },
  /** 文件拖悬停在窗口上（收起态时让主进程放大窗口） */
  dragHover(): void {
    ipcRenderer.send('island:drag-hover')
  },
  /**
   * 岛背后的桌面底图（SPEC-island-themes 第二轮，真透视）。
   * 主进程抓岛所在那块屏幕、裁成岛的大小，返回 data URL；抓不到时返回 null。
   * 图只在内存里用，不落盘。渲染层按主题/可见性决定要不要拉、多久拉一次。
   */
  islandBackdrop(): Promise<string | null> {
    return ipcRenderer.invoke('island:backdrop')
  },
  /** 窗口失焦（点了桌面或其他程序）——渲染层借此自动收回 */
  onWindowBlur(cb: () => void): void {
    ipcRenderer.on('island:window-blur', cb)
  },
  /** 打开设置窗口并落在指定分区（'general' | 'pages' | 'focus'） */
  openSettings(section: SettingsSection = 'general'): void {
    void ipcRenderer.invoke('settings:open', section)
  },
  /** 关闭设置窗口（设置窗口标题栏的 × 调它，而不是 window.close()） */
  closeSettings(): void {
    ipcRenderer.send('settings:close')
  },
  /** 最小化设置窗口 */
  minimizeSettings(): void {
    ipcRenderer.send('settings:minimize')
  },
  /** 最大化 / 还原设置窗口 */
  toggleMaximizeSettings(): void {
    ipcRenderer.send('settings:toggle-maximize')
  },
  /** 设置窗口当前是否最大化（标题栏初始化图标用） */
  settingsMaximized(): Promise<boolean> {
    return ipcRenderer.invoke('settings:is-maximized')
  },
  /** 主进程通知最大化状态变化（最大化 / 还原）。返回取消订阅函数 */
  onSettingsMaximized(cb: (value: boolean) => void): () => void {
    const h = (_e: Electron.IpcRendererEvent, value: boolean): void => cb(value)
    ipcRenderer.on('settings:maximized', h)
    return () => {
      ipcRenderer.removeListener('settings:maximized', h)
    }
  },
  /** 设置窗口：主进程要求切分区（菜单「设置…」/「页面管理…」直达）。返回取消订阅函数 */
  onSettingsSection(cb: (s: SettingsSection) => void): () => void {
    const h = (_e: Electron.IpcRendererEvent, s: SettingsSection): void => cb(s)
    ipcRenderer.on('settings:section', h)
    return () => {
      ipcRenderer.removeListener('settings:section', h)
    }
  },
  /** 偏好被任何窗口改动后广播（SPEC-settings-shell）：岛与设置窗口互相同步 */
  onPrefsChanged(cb: (p: PrefsShape) => void): () => void {
    const h = (_e: Electron.IpcRendererEvent, p: PrefsShape): void => cb(p)
    ipcRenderer.on('prefs:changed', h)
    return () => {
      ipcRenderer.removeListener('prefs:changed', h)
    }
  },
  /** 设置窗口「常规」页：版本号 + 用户数据目录 */
  appInfo(): Promise<AppInfo> {
    return ipcRenderer.invoke('settings:app-info')
  },
  /** 用资源管理器打开用户数据目录（%APPDATA%\lingdong-island） */
  openUserData(): Promise<boolean> {
    return ipcRenderer.invoke('settings:open-user-data')
  },
  /** 「关于」页：用系统浏览器打开仓库地址（地址固定在主进程） */
  openGithub(): Promise<boolean> {
    return ipcRenderer.invoke('settings:open-github')
  },
  /**
   * 「空间」页（SPEC-space-cleanup / SPEC-space-system-junk）：取某一组的清理项定义。
   * scope='app' 是灵动岛自己的缓存，'system' 是系统垃圾。只读，不含大小。
   */
  cleanupItems(scope: CleanupScope): Promise<CleanupItemDef[]> {
    return ipcRenderer.invoke('cleanup:items', scope)
  },
  /**
   * 扫描某一项的占用。逐项调用，页面可以先把快的项显示出来，
   * 慢的（比如很大的 %TEMP%）单独显示「计算中…」。只读，不改任何文件。
   */
  cleanupScanItem(scope: CleanupScope, id: CleanupTargetId): Promise<CleanupItemScan> {
    return ipcRenderer.invoke('cleanup:scan-item', scope, id)
  },
  /**
   * 「空间」页：清理某一组里选中的项目。
   * 只传分组和 id，路径由主进程按白名单决定，渲染层无法指定任意路径。
   */
  cleanupRun(scope: CleanupScope, ids: CleanupTargetId[]): Promise<CleanupRunResult> {
    return ipcRenderer.invoke('cleanup:run', scope, ids)
  },
  /**
   * 「空间」页·软件残留（SPEC-space-software-residue）：扫描服务、驱动、计划任务、
   * 运行中进程与无主目录。只读，不停止、不删除任何东西。
   */
  softwareResidueScan(): Promise<SoftwareResidueScanResult> {
    return ipcRenderer.invoke('software-residue:scan')
  },
  /** 清理选中的残留（只支持确定级服务/计划任务/空目录，SPEC-space-residue-cleanup） */
  softwareResidueCleanup(ids: string[]): Promise<ResidueCleanupRunResult> {
    return ipcRenderer.invoke('software-residue:cleanup', ids)
  },
  /** 软件残留的备份批次列表（时间倒序，SPEC-space-residue-merge） */
  softwareResidueBackups(): Promise<ResidueCleanupBackup[]> {
    return ipcRenderer.invoke('software-residue:backups')
  },
  /** 按批次撤销：重新登记服务/计划任务、重建空目录 */
  softwareResidueUndo(id: string): Promise<ResidueUndoResult> {
    return ipcRenderer.invoke('software-residue:undo', id)
  },
  /** 永久删除一批备份（不可恢复） */
  softwareResidueDiscardBackup(id: string): Promise<ResidueDiscardBackupResult> {
    return ipcRenderer.invoke('software-residue:discard', id)
  },
  /** 「空间」页·卸载残留（SPEC-space-residue）：扫描当前用户的失效卸载项与死快捷方式，只读 */
  residueScan(): Promise<ResidueScanResult> {
    return ipcRenderer.invoke('residue:scan')
  },
  /** 清理选中的残留：先备份再删，返回新的扫描结果与备份批次号 */
  residueClean(ids: string[]): Promise<ResidueCleanResult> {
    return ipcRenderer.invoke('residue:clean', ids)
  },
  /** 备份批次列表（时间倒序） */
  residueBackups(): Promise<ResidueBackup[]> {
    return ipcRenderer.invoke('residue:backups')
  },
  /** 撤销某一批备份：文件搬回原位、注册表导回 */
  residueUndo(id: string): Promise<{ ok: boolean; warnings: string[]; backups: ResidueBackup[] }> {
    return ipcRenderer.invoke('residue:undo', id)
  },
  /** 永久删除某一批备份（不可恢复） */
  residueDiscardBackup(
    id: string
  ): Promise<{ ok: boolean; warnings: string[]; backups: ResidueBackup[] }> {
    return ipcRenderer.invoke('residue:discard', id)
  },
  /** 「空间」页·系统清理（需要管理员）：只读扫描，不提权 */
  adminCleanupScan(): Promise<AdminCleanupScanResult> {
    return ipcRenderer.invoke('adminclean:scan')
  },
  /** 清理选中的系统项目：会弹一次 UAC，用户拒绝时 canceled=true 且什么都没删 */
  adminCleanupRun(ids: AdminCleanupId[]): Promise<AdminCleanupRunResult> {
    return ipcRenderer.invoke('adminclean:run', ids)
  },
  /** 自动更新（SPEC-auto-update）：当前状态快照 */
  updateGetState(): Promise<UpdateState> {
    return ipcRenderer.invoke('update:get-state')
  },
  /** 手动检查一次更新；返回检查后的状态 */
  updateCheck(): Promise<UpdateState> {
    return ipcRenderer.invoke('update:check')
  },
  /** 用户确认后下载新版本；返回状态（进度走 onUpdateState 广播） */
  updateDownload(): Promise<UpdateState> {
    return ipcRenderer.invoke('update:download')
  },
  /** 暂停下载（清掉半截文件，继续会从头下载） */
  updatePause(): Promise<UpdateState> {
    return ipcRenderer.invoke('update:pause')
  },
  /** 取消下载并清理残留，回到「可下载」状态 */
  updateCancel(): Promise<UpdateState> {
    return ipcRenderer.invoke('update:cancel')
  },
  /** 打开指定版本的安装包直链（浏览器下载），没有版本号时打开发布页 */
  updateOpenDownload(): Promise<boolean> {
    return ipcRenderer.invoke('update:open-download')
  },
  /** 退出并静默安装已下载的版本 */
  updateInstall(): Promise<boolean> {
    return ipcRenderer.invoke('update:install')
  },
  /** 降级出口：打开发布页让用户自己下载 */
  updateOpenPage(): Promise<boolean> {
    return ipcRenderer.invoke('update:open-page')
  },
  /** 更新状态变化广播（检查/下载/安装各阶段）。返回取消订阅函数 */
  onUpdateState(cb: (s: UpdateState) => void): () => void {
    const h = (_e: Electron.IpcRendererEvent, s: UpdateState): void => cb(s)
    ipcRenderer.on('update:state', h)
    return () => {
      ipcRenderer.removeListener('update:state', h)
    }
  },
  /** 主进程决定「现在该提示一次新版本」时广播（同版本每天最多一次）。返回取消订阅函数 */
  onUpdateAnnounce(cb: (version: string) => void): () => void {
    const h = (_e: Electron.IpcRendererEvent, version: string): void => cb(version)
    ipcRenderer.on('update:announce', h)
    return () => {
      ipcRenderer.removeListener('update:announce', h)
    }
  },
  /** 诊断日志（US-036 探针）：渲染层把收起判定写进 userData/collapse-log.txt */
  logDiag(line: string): void {
    ipcRenderer.send('island:log-diag', line)
  },
  /**
   * 弹出应用菜单（US-034）：岛内右键时调用，主进程在光标处弹原生菜单，
   * 里面的「退出灵动岛」是真正的进程退出。
   */
  showAppMenu(): void {
    ipcRenderer.send('app:show-menu')
  },
  /** 直接退出应用（供 e2e 验证退出链路；界面上的退出走菜单） */
  quitApp(): void {
    ipcRenderer.send('app:quit')
  },
  /**
   * 数据导出（US-029）：弹主进程原生「另存为」，把待办+日程写成 JSON。
   * 入口在设置窗口「常规 → 导出数据」（2026-11-11 起；原右键/托盘菜单项已删）。
   * 返回结果供渲染层显示与 e2e 断言用。
   */
  exportData(): Promise<ExportResult> {
    return ipcRenderer.invoke('app:export-data')
  },
  /** 界面偏好（US-032）：读 / 写。存 userData/prefs.json（localStorage 跨重启会丢，不用它） */
  prefsGet(): Promise<PrefsShape> {
    return ipcRenderer.invoke('prefs:get')
  },
  prefsSet(payload: PrefsShape): Promise<PrefsShape> {
    return ipcRenderer.invoke('prefs:set', payload)
  },
  /**
   * 桌宠独立小窗口的拖动（SPEC-deskpet-out）。
   *
   * 为什么不在渲染层直接改窗口位置：渲染层没有窗口控制权（contextIsolation），
   * 而且拖动要跟光标 60fps，跨进程只发「开始/结束」两次，中间由主进程自己读光标，
   * 比每帧发一次坐标稳得多。
   */
  petDragStart(): void {
    ipcRenderer.send('pet:drag-start')
  },
  /** 松手：主进程停跟光标，并把最终位置落盘 */
  petDragEnd(): void {
    ipcRenderer.send('pet:drag-end')
  },
  /** 宠物窗口右键菜单：主进程在光标处弹原生菜单（回到岛里 / 退出） */
  petShowMenu(): void {
    ipcRenderer.send('pet:show-menu')
  },
  /**
   * 右键菜单里点了某个动作之后，主进程把它推回来播（SPEC-deskpet-action）。
   * 返回取消订阅函数。
   */
  onPetAction(cb: (a: 'laugh' | 'roll' | 'wave') => void): () => void {
    const h = (_e: Electron.IpcRendererEvent, a: 'laugh' | 'roll' | 'wave'): void => cb(a)
    ipcRenderer.on('pet:action', h)
    return () => {
      ipcRenderer.removeListener('pet:action', h)
    }
  },
  /**
   * 自由走动方向（SPEC-deskpet-walk / SPEC-deskpet-walk-polish / SPEC-deskpet-walk-roam）：
   * 主进程在方向变化 / 走停切换时推一次，四方向 + idle（随机漫步可斜走，斜向按主导分量归到某一视图）。
   * 'idle' = 走到目标停下或没在走。返回取消订阅函数。
   */
  onPetWalk(cb: (d: 'left' | 'right' | 'up' | 'down' | 'idle') => void): () => void {
    const h = (
      _e: Electron.IpcRendererEvent,
      d: 'left' | 'right' | 'up' | 'down' | 'idle'
    ): void => cb(d)
    ipcRenderer.on('pet:walk', h)
    return () => {
      ipcRenderer.removeListener('pet:walk', h)
    }
  },
  /**
   * 音乐页（SPEC-music-page / US-031）：读当前播放快照。
   * 首次调用会懒启动主进程里的常驻 PowerShell 桥接（约 50MB），
   * 所以只在渲染层真的要显示音乐页时才调。
   */
  musicGet(): Promise<MusicState> {
    return ipcRenderer.invoke('music:get')
  },
  /**
   * 音乐控制：'toggle' 播放/暂停、'next' 下一首、'prev' 上一首，
   * 或带参数命令对象 { cmd:'seek'|'shuffle'|'repeat'|'volume', value }。返回是否已把命令发出。
   */
  musicControl(cmd: MusicCommand): Promise<boolean> {
    return ipcRenderer.invoke('music:control', cmd)
  },
  /**
   * 音源选择 / 锁定（SPEC-music-source-strategy）：传进程名锁定它，传 null 回到自动。
   * 点选即记住——主进程会把这个进程加进「已知播放器」并持久化。
   */
  musicSetSource(exe: string | null): Promise<MusicState> {
    return ipcRenderer.invoke('music:set-source', exe)
  },
  /**
   * 网易云桌面歌词开关（SPEC-music-desktop-lyric，等价于它的 Ctrl+D）。
   * 返回操作后的实际状态；没有后台控制 / 页面上找不到按钮时返回 null。
   */
  musicDesktopLyric(on: boolean): Promise<boolean | null> {
    return ipcRenderer.invoke('music:desktop-lyric', on)
  },
  /**
   * 歌词（SPEC-music-lyric）：按当前歌曲去查带时间轴的歌词。
   * 主进程先看本地缓存（`userData/lyrics/*.json`），没有才联网查 lrclib.net；
   * 查不到会返回 ok=false + 一句原因，界面照实显示，不会给出编造的歌词。
   */
  lyricGet(q: LyricQuery): Promise<LyricResult> {
    return ipcRenderer.invoke('lyric:get', q)
  },
  /** 播放状态变化推送（主进程每秒采样，字段真的变了才发）。返回取消订阅函数 */
  onMusicState(cb: (s: MusicState) => void): () => void {
    const h = (_e: Electron.IpcRendererEvent, s: MusicState): void => cb(s)
    ipcRenderer.on('music:state', h)
    return () => {
      ipcRenderer.removeListener('music:state', h)
    }
  },
  /** 待办清单：读 / 增 / 勾选切换 / 删 / 改名，全部返回最新全量列表 */
  todosList(): Promise<Todo[]> {
    return ipcRenderer.invoke('todos:list')
  },
  todosAdd(text: string): Promise<Todo[]> {
    return ipcRenderer.invoke('todos:add', text)
  },
  todosToggle(id: string): Promise<Todo[]> {
    return ipcRenderer.invoke('todos:toggle', id)
  },
  todosRemove(id: string): Promise<Todo[]> {
    return ipcRenderer.invoke('todos:remove', id)
  },
  todosRename(id: string, text: string): Promise<Todo[]> {
    return ipcRenderer.invoke('todos:rename', { id, text })
  },
  /** 收起态状态栏快照：电量、充电状态、网络（Wi-Fi / 网线） */
  statusSnapshot(): Promise<StatusSnapshot> {
    return ipcRenderer.invoke('status:snapshot')
  },
  /** 强制重读一次状态（绕过缓存）；渲染层在系统 online/offline 事件时调用 */
  statusRefresh(): Promise<StatusSnapshot> {
    return ipcRenderer.invoke('status:refresh')
  },
  /**
   * 主进程主动推送的状态快照（插拔电源、休眠恢复时推，不等 60 秒轮询）。
   * 与 statusSnapshot 同一份结构，渲染层收到直接覆盖即可。
   * 返回取消订阅函数：渲染层在 useEffect cleanup 里调用，避免重复挂载时叠加监听。
   */
  onStatusChanged(cb: (s: StatusSnapshot) => void): () => void {
    const h = (_e: Electron.IpcRendererEvent, s: StatusSnapshot): void => cb(s)
    ipcRenderer.on('island:status-changed', h)
    return () => {
      ipcRenderer.removeListener('island:status-changed', h)
    }
  },
  /** 开机自启：读状态 / 开关 */
  autostartGet(): Promise<boolean> {
    return ipcRenderer.invoke('autostart:get')
  },
  autostartSet(on: boolean): Promise<boolean> {
    return ipcRenderer.invoke('autostart:set', on)
  },
  /**
   * 自启状态被任何窗口改动后广播（SPEC-settings-shell 阻断项 B2）：
   * 岛头部胶囊和设置窗口的开关是两处独立渲染，不订阅的话改完另一边不动。
   */
  onAutostartChanged(cb: (on: boolean) => void): () => void {
    const h = (_e: Electron.IpcRendererEvent, on: boolean): void => cb(on)
    ipcRenderer.on('autostart:changed', h)
    return () => {
      ipcRenderer.removeListener('autostart:changed', h)
    }
  },
  /** 置物架：列 / 加（拖入路径数组）/ 删 / 清空 / 打开 / 显示所在文件夹 */
  shelfList(): Promise<ShelfItem[]> {
    return ipcRenderer.invoke('shelf:list')
  },
  shelfAdd(paths: string[]): Promise<ShelfItem[]> {
    return ipcRenderer.invoke('shelf:add', paths)
  },
  shelfRemove(id: string): Promise<ShelfItem[]> {
    return ipcRenderer.invoke('shelf:remove', id)
  },
  shelfClear(): Promise<ShelfItem[]> {
    return ipcRenderer.invoke('shelf:clear')
  },
  /** 网格内拖动排序：传入新的 id 顺序，返回重排后的全量列表 */
  shelfReorder(ids: string[]): Promise<ShelfItem[]> {
    return ipcRenderer.invoke('shelf:reorder', ids)
  },
  /** 取某文件名的系统图标 PNG 绝对路径（按扩展名缓存，文件夹用真实图标），失败返回 null */
  shelfIcon(name: string, path: string): Promise<string | null> {
    return ipcRenderer.invoke('shelf:icon', name, path)
  },
  shelfOpen(path: string): Promise<ShelfOpenResult> {
    return ipcRenderer.invoke('shelf:open', path)
  },
  /**
   * 在文件夹中显示。走 invoke 而不是 send：主进程注册的是 ipcMain.handle，
   * 用 send 发出去的事件没有任何监听者，按钮点了会静默无反应（既有 bug，本次一并修好）。
   */
  shelfShowInFolder(path: string): Promise<ShelfRevealResult> {
    return ipcRenderer.invoke('shelf:show-in-folder', path)
  },
  /** 拖放落盘后广播新列表（本进程内直接调用回调，无序列化歧义） */
  emitShelfAdded(list: ShelfItem[]): void {
    for (const cb of shelfAddedCbs) cb(list)
  },
  onShelfAdded(cb: (list: ShelfItem[]) => void): void {
    shelfAddedCbs.push(cb)
  },
  /**
   * 把拖入的 File 对象转成完整路径。
   * Electron 32+ 移除了 File.path 属性，官方替代就是 webUtils.getPathForFile。
   */
  filePath(file: File): string {
    return webUtils.getPathForFile(file)
  },
  /**
   * 音乐页挂载/卸载时上报「有没有人在用」（SPEC-idle-cost-reclaim）。
   * 主进程靠它算桥接子进程的空闲期：离开音乐页 2 分钟没需求就回收那 116 MB 的常驻 PowerShell。
   * 只在音乐页（MusicPanel）里调，收起态/其它页面不调。
   */
  musicDemand(on: boolean): void {
    ipcRenderer.send('music:demand', on)
  },
  /** 通知页：最近通知列表 + 未读数 */
  notifyList(): Promise<NotifyListResult> {
    return ipcRenderer.invoke('notify:list')
  },
  /** 通知页：手动刷新（切到通知页时调一次） */
  notifyRefresh(): Promise<NotifyListResult> {
    return ipcRenderer.invoke('notify:refresh')
  },
  /** 全部标记已读，返回新未读数 */
  notifyMarkRead(): Promise<number> {
    return ipcRenderer.invoke('notify:mark-read')
  },
  /** 清空通知列表（本地隐藏水位，系统库不动），返回清空后的列表与未读数 */
  notifyClearAll(): Promise<NotifyListResult> {
    return ipcRenderer.invoke('notify:clear-all')
  },
  /** 尝试打开通知来源：优先 launch 深链直达界面，映射不到兜底打开 Windows 通知设置 */
  notifyOpenSource(appName: string, launch: string | null): Promise<boolean> {
    return ipcRenderer.invoke('notify:open-source', appName, launch)
  },
  /** 新消息到岛横幅（主进程 30s 轮询发现新通知时推送；渲染层收起态显示横幅） */
  onNotifyArrived(cb: (item: NotifyItem) => void): void {
    ipcRenderer.on('island:notify-arrived', (_e, item: NotifyItem) => cb(item))
  },
  /**
   * 通知图标后台补齐后推送整份列表（SPEC-perf-no-sync-ps）。
   *
   * 图标解析会起 PowerShell，旧实现是同步的，切到通知页就冻一下；现在拆成后台队列，
   * 列表先出来（缺图的显示文字徽标），补完再推一份带图的新列表。渲染层直接套用，
   * 不重新拉 IPC、不重放淡入、不动已读水位。
   */
  onNotifyIconsUpdated(cb: (r: NotifyListResult) => void): () => void {
    const handler = (_e: unknown, r: NotifyListResult): void => cb(r)
    ipcRenderer.on('island:notify-icons-updated', handler)
    return () => {
      ipcRenderer.removeListener('island:notify-icons-updated', handler)
    }
  },
  /** 横幅显示/隐藏时通知主进程：收起态窗口只有胶囊高，横幅期主进程向上加高窗口，否则横幅渲染在窗口外看不见 */
  setBannerVisible(visible: boolean): void {
    ipcRenderer.send('island:set-banner-visible', visible)
  },
  /** US-039 验证码横幅：主进程剪贴板轮询识别到验证码时推送码字符串 */
  onCodeArrived(cb: (code: string) => void): void {
    ipcRenderer.on('island:code-arrived', (_e, code: string) => cb(code))
  },
  /** US-039 点击验证码横幅 → 复制验证码到剪贴板（渲染层 clipboard 已弃用，走主进程） */
  clipboardWriteText(text: string): Promise<boolean> {
    return ipcRenderer.invoke('clipboard:write-text', text)
  },
  /** US-041 全屏避让：主进程隐藏/恢复岛时推送（渲染层收到 hidden=true 收起面板） */
  onAvoidChanged(cb: (hidden: boolean) => void): void {
    ipcRenderer.on('island:avoid-changed', (_e, hidden: boolean) => cb(hidden))
  },
  /** US-041 手动隐藏（渲染层菜单项点击 → 状态机真正隐藏；manualHide 标志在主进程置位） */
  manualHide(): void {
    ipcRenderer.send('island:manual-hide')
  },
  /** US-041 手动隐藏后托盘唤回（托盘 click → 主进程转发给状态机） */
  manualRestore(): void {
    ipcRenderer.send('island:manual-restore')
  },
  /** US-041 横幅临时现身：通知/验证码横幅弹出时 true，收横幅时 false */
  requestTempShow(on: boolean): void {
    ipcRenderer.send('island:temp-show', on)
  },
  /** US-041 鼠标离开岛根（避让临时现身期间上报，主进程决定回隐）。
   * 注意：2026-11-18 起「摸边唤回」不再靠 4px 感应窗，主进程自己看光标坐标；
   * 这条只用于「鼠标离开岛 → 收起」。 */
  edgeLeave(): void {
    ipcRenderer.send('island:edge-leave')
  },
  /** 日程：列 / 增（文本 + 可选 'HH:mm' + 可选 'YYYY-MM-DD'）/ 勾选切换 / 删，全部返回最新全量列表 */
  scheduleList(): Promise<ScheduleItem[]> {
    return ipcRenderer.invoke('schedule:list')
  },
  scheduleAdd(text: string, time: string | null, day?: string | null): Promise<ScheduleItem[]> {
    return ipcRenderer.invoke('schedule:add', text, time, day ?? null)
  },
  scheduleToggle(id: string): Promise<ScheduleItem[]> {
    return ipcRenderer.invoke('schedule:toggle', id)
  },
  scheduleRemove(id: string): Promise<ScheduleItem[]> {
    return ipcRenderer.invoke('schedule:remove', id)
  },
  /** 编辑日程：payload 给哪个字段改哪个（text/time/day），主进程负责规范化与提醒标记重置 */
  scheduleEdit(id: string, payload: { text?: string; time?: string | null; day?: string | null }): Promise<ScheduleItem[]> {
    return ipcRenderer.invoke('schedule:edit', id, payload)
  }
}

/** 日程条目（与主进程 scheduleStore 保持一致） */
export interface ScheduleItem {
  id: string
  text: string
  day: string // 'YYYY-MM-DD'
  time: string | null
  done: boolean
  reminded: boolean
  createdAt: number
}

/** 导出结果（与主进程 exportStore.ExportResult 保持一致） */
export interface ExportResult {
  ok: boolean
  canceled?: boolean
  path?: string
  reason?: 'canceled' | 'empty' | 'failed'
  detail?: string
}

/** 界面偏好（US-032，与主进程 prefsStore 保持一致） */
export interface PagesCustom {
  pages: number[]
  collapsed: Record<'pet' | 'clock' | 'battery' | 'net' | 'todo' | 'bell', boolean>
  /** 收起态组件从左到右的顺序（美化-02） */
  order: ('pet' | 'clock' | 'battery' | 'net' | 'todo' | 'bell')[]
}

export interface PrefsShape {
  pagesCustom?: PagesCustom
  shelfView?: 'lg' | 'md' | 'sm' | 'list'
  /** 音乐页一次性补入标记（SPEC-music-page）；老用户升级后补过就置 true，不再补第二次 */
  musicIntro?: boolean
  /** 桌宠皮肤 id（SPEC-deskpet-skin）；缺失=默认 capsule，保持升级前的老形象 */
  petSkin?: PetSkinId
  /** 桌宠出现模式（SPEC-deskpet-skin）；缺失=island */
  petMode?: PetMode
  /** 桌宠独立小窗口位置（SPEC-deskpet-out）；缺失=首次出现在主屏右下角 */
  petWindowPos?: PetWindowPos
  /** 全屏避让策略（SPEC-avoid-mode-and-latency）；缺失=maximized（最大化与真全屏都避让） */
  avoidMode?: AvoidMode
  /** 网易云后台控制三档（SPEC-netease-cdp-mode）；缺失=auto */
  neteaseCdpMode?: NeteaseCdpMode
  /** 时钟显示档位（SPEC-clock-date-format）；缺失=time（仅时间） */
  clockFormat?: ClockFormat
  /** 岛的主题（SPEC-island-themes）；缺失=glass-light（亮色乳白玻璃） */
  islandTheme?: IslandTheme
  /** 「词」第二下是否召唤桌面歌词（SPEC-desktop-lyric-setting）；缺失=true */
  desktopLyricEnabled?: boolean
}
contextBridge.exposeInMainWorld('island', api)

export type IslandApi = typeof api
