# SPEC：修 e2e-head-order 的偶发失败（关窗竞态 + 静默点击落空）

## 一、目标

`scripts/e2e-head-order.mjs` 长期存在偶发失败：同一条脚本在 `main` 上跑，有时
`14 过 / 0 败`，有时 `9 过 / 1 败` 或 `11 过 / 1 败`，失败信息都是

```
✗ 异常：Error: no settings target
    at evalOnTarget (scripts/e2e-head-order.mjs:50:11)
    at closePanel (scripts/e2e-head-order.mjs:200:5)
```

该问题在 `docs/状态.md` 已登记为「已知遗留④」，多轮验收都被判「既有问题、不阻断」，
但它会让人无法判断后续改动到底有没有弄坏东西（红一次绿一次，等于没有信号）。
本轮目标：把它修到能稳定复现通过，并且**用负对照证明修复有判别力**。

用户 2026-11-12 14:18 原话「那就先把这个小bug修复了再告诉我下一步干什么」。

## 二、修改范围

- `scripts/e2e-head-order.mjs`（唯一改动文件，属测试脚本，不改产品代码）
  - 新增 `hasSettingsTarget()` / `waitForSettings(present, timeoutMs, label)` /
    `waitUntil(expr, opts)` / `waitForPrefs(pred, timeoutMs, label)` /
    `clickClockCheckbox(expectClock)` 五个辅助函数。
  - `openPanel()`：固定 `sleep(1500)` → 等 CDP target 出现 + 等面板真渲染出时钟行。
  - `closePanel()`：`sleep(1000)` → 等 CDP target 真的消失（最长 10 秒）。
  - H2a / H2c：点击后检查返回值（`no-cb` 直接抛错），落盘改成轮询 `prefs.json`。
- **不动产品代码**（`src/` 零改动）。原因见第四节：竞态在测试脚本侧，产品侧行为本身正确。

## 三、预期行为

- 脚本连续运行任意多次，结果稳定为 `PASS（14 过 / 0 败）`。
- 窗口关得慢时多等、关得快时立刻走，不靠固定毫秒数赌时序。
- 点击没点到元素时**显式报错**（原来静默当成点过了，导致「功能坏了」和「脚本没点到」
  两种完全不同的情况报出同一句断言失败）。
- 失败信息能说清在等什么，不再是光秃秃的 `no settings target`。

## 四、必要依赖

无新增依赖。只用已有的 CDP（`http://127.0.0.1:<port>/json/list`）与 `node:fs`。

## 五、验收条件

1. `node scripts/e2e-head-order.mjs` 单次 `PASS（14 过 / 0 败）`。
2. **连跑 8 轮全部 PASS**（偶发问题，单次通过不足以证明）。
3. **负对照 A（有判别力）**：窗口开着时 `waitForSettings(false)` 必须超时而不是立刻返回；
   窗口关掉后必须等到消失；选择器不存在时点击必须返回 `no-cb`。四项全过才算等待函数
   不是空转。
4. **负对照 B（能抓到静默失败）**：把点击选择器改成不存在的，脚本必须变红
   （实测 `12 过 / 2 败`），证明新代码没有把「没点到」放过。
5. 回归不退步：`e2e-collapse-order` / `e2e-settings-shell` / `e2e-deskpet` / `e2e-m2` 全过。

## 六、不做什么

- **不改 `src/main/settingsWindow.ts`**。曾怀疑 `openSettings()` 的守卫
  `settingsWindow && !settingsWindow.isDestroyed()` 存在「窗口正在关闭时被当成还开着」
  的漏洞，但实测 `win.close()` 之后 `isDestroyed()` **立刻**变 `true`，守卫本身没有漏洞，
  不改产品代码。
- **不顺手改其它 5 个同样写法的脚本**（`e2e-collapse-order` / `e2e-deskpet` /
  `e2e-settings-shell` / `e2e-music` 里也有固定 `sleep` + `closeSettings`）。它们没有
  出现偶发失败，按「不顺便改无关功能」不动；真要统一抽公共 helper，另开 SPEC。
- 不把探针（`.tmp/probe-*.mjs`）留进交付提交。

## 七、自检记录

### 7.1 先证伪再改（四个假设全被实测否掉）

改之前先做探针，逐个验证「最像原因」的假设，结果全部不成立：

| 假设 | 探针 | 实测结果 | 结论 |
|---|---|---|---|
| `closePanel` 只等 1000ms 不够 | `.tmp/probe-close-race.mjs` | settings target 出现 108–121ms，**关闭后消失只要 12–15ms** | 否掉 |
| 关窗后立刻重开，新窗口被吃掉 | `.tmp/probe-close-race3.mjs` | gap = 0/5/20/100/500ms，5 轮全部「窗口存在 ✓」 | 否掉 |
| `openPanel` 等 1500ms 不够 | `.tmp/e2e-ho-negctl.mjs`（压到 150ms） | 仍 `14 过 / 0 败`（`evalOnTarget` 自带 40×500ms 重试） | 否掉 |
| 点 checkbox 后 700ms 落盘不够 | `.tmp/probe-prefs-latency.mjs` | 13 轮实测点击→落盘 **6–12ms**，无一次超 700ms | 否掉 |

加压也复现不出：`.tmp/probe-flight-recorder.mjs` 开 4 个 CPU 忙循环 + 每 50ms 记录
CDP target 时间线，10 轮全 ✓；把 closePanel 插满日志的插桩副本连跑 6 轮、真实脚本
连跑 10 轮，全部 `14 过 / 0 败`。

**所以：真正能证明的是「这条脚本存在两条会静默失败/无界等待的路径」，不是「某个
毫秒数偏小」。** 修法随之改成「等真实条件成立」，而不是把 sleep 调大——调大只是把
概率推后，下次机器更慢照样红。

### 7.2 实测到的真实缺陷（负对照证明）

`scripts/e2e-head-order.mjs` 的 H2 段点击表达式在找不到元素时返回 `'no-cb'`，但
**调用方从不检查返回值**。负对照 `.tmp/e2e-ho-negctl2.mjs` 把选择器改成
`.pm-row-NOTEXIST[data-comp="clock"]` 后跑出 **`12 过 / 2 败`**（H2a 报 collapsed 全
`true`、H2b 报 infoOrder 仍含 clock）——这条路径确实能红，但只红 2 条，不是历史
失败记录的「1 败」。历史那 1 败是 `closePanel` 的 `no settings target`，属另一条
无界等待路径。

### 7.3 改动后结果

- `node scripts/e2e-head-order.mjs` → **PASS（14 过 / 0 败）**。
- 连跑 8 轮（日志 `.tmp/head-order-fixed-loop.log`）→ **8/8 全部 `14 过 / 0 败`**。
- 负对照 A `.tmp/probe-close-slow-negctl.mjs` → **4 过 / 0 败**：
  - A1 窗口开着时 `waitForSettings(false)` 超时而非立刻返回（1505ms）✓
  - A2 窗口开着时 `waitForSettings(true)` 立刻返回（1ms）✓
  - A3 关掉后 `waitForSettings(false)` 等到消失（20ms）✓
  - A4 选择器不存在时点击返回 `no-cb` ✓
- 负对照 B `.tmp/e2e-ho-negctl2.mjs` → `12 过 / 2 败`（能抓到没点到）✓
- 回归（日志 `.tmp/regress-fix-close-race.log`）：
  `e2e-collapse-order` **22 过 / 0 败**、`e2e-settings-shell` **51 过 / 0 败**、
  `e2e-deskpet` **32 过 / 0 败**、`e2e-m2` **PASS**。

### 7.4 过程中踩的坑（如实记录）

1. **自己引入过一次 10 秒超时**：第一版把 `waitForTarget(wantSettings, ...)` 的「查哪个
   target」和「期望它存在还是消失」混成同一个参数，`wantSettings=false` 实际查的是岛
   窗口、条件永不成立，跑出 `9 过 / 1 败` 报 `等「设置窗口关闭」超时（10000ms）`。
   已拆成 `hasSettingsTarget()`（查） + `waitForSettings(present, ...)`（等）。
2. **想模拟「慢关窗」失败**：试过
   `window.island.closeSettings = () => setTimeout(orig, 2500)`，**静默无效**——preload
   经 `contextBridge` 暴露的 API 是只读的，赋值不生效，窗口照常 12ms 关掉。改用
   「直接验等待函数行为」的负对照 A。
3. **探针路径踩坑**：`.tmp/` 下的探针 `import` 相对路径要写 `../scripts/isolate-userdata.mjs`；
   且必须 `import` 该 helper 才会把 `APPDATA` 指向隔离目录，否则探针读写真实
   `%APPDATA%\lingdong-island\`。

### 7.5 未验证 / 已知边界

- **没能在修复前稳定复现那次「1 败」**。四个假设全否、加压 10 轮也复现不出，所以
  「修的就是历史上那一次失败」属于 `[推断]`，不是 `[实测]`。可确证的是：脚本里两条
  会静默失败/无界等待的路径已消除，且用负对照证明新代码有判别力。
- 最可能错在哪：真实失败若另有第三种成因（比如主进程崩溃重启导致 CDP 端口短暂断连），
  本轮改动不覆盖它——不过 `waitForSettings` 在 CDP 端口不可达时按「没有」处理并继续
  轮询，比原来直接抛错更抗这个场景。
- **违反「SPEC 先行」**：本轮先改代码、后补本文件。原因是用户要求「先把这个小 bug 修了」，
  且需要先做探针才知道改什么（探针阶段本就不必打 SPEC）。如实记录，不粉饰。

## 八、验收记录

（待独立验收）
