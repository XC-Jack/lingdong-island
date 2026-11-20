import type { AdminCleanupId } from '../shared/types'

/**
 * 「系统清理（需要管理员）」的白名单与提权脚本模板（SPEC-space-admin-cleanup）。
 *
 * 单独放一个模块的原因有两个：
 * 1. 脚本内容只由这里生成，输入只有 id 和固定路径，**不接受任何外部文本**；
 * 2. 它是纯字符串拼接，可以脱离 Electron 单独编译、用假目录跑一遍验证语法与语义。
 */

export interface AdminTarget {
  id: AdminCleanupId
  label: string
  hint: string
  /** 统计与清理的目录；null = 交给系统接口，看不到大小 */
  dirs: string[] | null
}

export function adminTargets(windir: string, programData: string): AdminTarget[] {
  const joinWin = (...p: string[]): string => [windir, ...p].join('\\')
  const joinPd = (...p: string[]): string => [programData, ...p].join('\\')
  return [
    {
      id: 'win-update-cache',
      label: 'Windows 更新缓存',
      hint: '可以删。系统下载更新时留下的安装包；清理时会短暂停止 Windows 更新服务，删完自动恢复，正在下载的更新会重新开始。',
      dirs: [joinWin('SoftwareDistribution', 'Download')]
    },
    {
      id: 'win-temp',
      label: '系统临时文件',
      hint: '可以删。系统级临时目录里各种程序用完的文件；正在被使用的会自动跳过。',
      dirs: [joinWin('Temp')]
    },
    {
      id: 'wer-system',
      label: '系统错误报告',
      hint: '可以删。系统和驱动崩溃时生成的报告；普通权限看不到完整大小，清理时要管理员授权。',
      dirs: [
        joinPd('Microsoft', 'Windows', 'WER', 'ReportArchive'),
        joinPd('Microsoft', 'Windows', 'WER', 'ReportQueue'),
        joinPd('Microsoft', 'Windows', 'WER', 'Temp')
      ]
    },
    {
      id: 'delivery-optimization',
      label: '传递优化缓存',
      hint: '可以删。Windows 更新与应用商店下载用的 P2P 缓存；由系统自己的接口清理，清理前不显示大小，清完会报释放了多少。',
      /**
       * 目录不给（提权前也读不到），大小也不靠目录统计：用系统接口
       * `Get-DeliveryOptimizationPerfSnap` 的 `CacheSizeBytes` 读，清理前后各读一次。
       */
      dirs: null
    }
  ]
}

function psq(p: string): string {
  return `'${p.replaceAll("'", "''")}'`
}

/** 递归统计一组路径的占用（PowerShell 表达式） */
function sizeExpr(paths: string[]): string {
  return `(Get-ChildItem -LiteralPath @(${paths.map(psq).join(', ')}) -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum`
}

/** 清空一组目录的内容（不删目录本身） */
function removeChildrenExpr(paths: string[]): string {
  return paths
    .map(
      (p) =>
        `Get-ChildItem -LiteralPath ${psq(p)} -Force -ErrorAction SilentlyContinue | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }`
    )
    .join('\n  ')
}

function buildBlock(t: AdminTarget): string {
  const header = `# --- ${t.label} ---`
  const name = `'${t.id}'`

  if (t.id === 'delivery-optimization') {
    // 大小走系统接口而不是目录：缓存放在 NetworkService 的私有目录里，普通权限列不出来；
    // 读不到就留 -1（界面按「没统计到」处理），不影响清理本身。
    const readSize = (varName: string): string[] => [
      `${varName} = -1`,
      `try { ${varName} = [double](Get-DeliveryOptimizationPerfSnap -ErrorAction Stop).CacheSizeBytes } catch { }`
    ]
    return [
      header,
      '$w = @()',
      ...readSize('$before'),
      'try { Delete-DeliveryOptimizationCache -Force -ErrorAction Stop }',
      "catch { $w += ('清除失败：' + $_.Exception.Message) }",
      ...readSize('$after'),
      "if ($after -gt 0) { $w += ('还有 {0:N1} MB 没清掉。' -f ($after / 1MB)) }",
      `[void]$results.Add([pscustomobject]@{ id = ${name}; before = $before; after = $after; warnings = @($w) })`
    ].join('\n')
  }

  const dirs = t.dirs ?? []
  const lines: string[] = [header, '$w = @()']

  if (t.id === 'win-update-cache') {
    lines.push(
      '$svc = @{}',
      "foreach ($n in @('wuauserv','bits')) {",
      '  $s = Get-Service -Name $n -ErrorAction SilentlyContinue',
      "  $svc[$n] = ($null -ne $s) -and ($s.Status -eq 'Running')",
      '}'
    )
  }

  lines.push(`$before = ${sizeExpr(dirs)}`, 'if ($null -eq $before) { $before = 0 }', 'try {')
  if (t.id === 'win-update-cache') {
    lines.push(
      "  if ($svc['wuauserv']) { Stop-Service -Name wuauserv -Force -ErrorAction SilentlyContinue }",
      "  if ($svc['bits']) { Stop-Service -Name bits -Force -ErrorAction SilentlyContinue }"
    )
  }
  lines.push(`  ${removeChildrenExpr(dirs)}`, '}')
  lines.push("catch { $w += ('删除时出错：' + $_.Exception.Message) }")
  // 先量「清理后」，再恢复服务：服务一启动，Windows 更新可能立刻重新下载，
  // 量到的就不是这次删掉多少，而会误报「还有 X MB 没清掉」。
  lines.push(
    `$after = ${sizeExpr(dirs)}`,
    'if ($null -eq $after) { $after = 0 }',
    "if ($after -gt 0) { $w += ('还有 {0:N1} MB 没清掉，可能正被占用。' -f ($after / 1MB)) }"
  )
  if (t.id === 'win-update-cache') {
    lines.push(
      'try {',
      "  if ($svc['wuauserv']) { Start-Service -Name wuauserv -ErrorAction Stop }",
      "  if ($svc['bits']) { Start-Service -Name bits -ErrorAction Stop }",
      "} catch { $w += ('更新服务没能重新启动：' + $_.Exception.Message + '，请在「服务」里手动启动。') }"
    )
  }
  lines.push(
    `[void]$results.Add([pscustomobject]@{ id = ${name}; before = [double]$before; after = [double]$after; warnings = @($w) })`
  )
  return lines.join('\n')
}

/** 生成完整脚本：按 ids 顺序拼块，最后把每项结果写成 JSON 文件 */
export function buildAdminScript(
  ids: AdminCleanupId[],
  targets: AdminTarget[],
  resultPath: string
): string {
  const blocks = ids
    .map((id) => targets.find((t) => t.id === id))
    .filter((t): t is AdminTarget => Boolean(t))
    .map(buildBlock)
  return [
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "$ErrorActionPreference = 'Continue'",
    '$results = New-Object System.Collections.ArrayList',
    ...blocks,
    '$json = ConvertTo-Json -InputObject $results.ToArray() -Depth 4 -Compress',
    `[System.IO.File]::WriteAllText(${psq(resultPath)}, $json, (New-Object System.Text.UTF8Encoding($false)))`
  ].join('\n')
}
