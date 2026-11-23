# zcode-helper — 设计文档

> 事实依据见 [HANDOFF.md](./HANDOFF.md)(已验证机制 / 已失败路径 / 关键实测);行为规则见 [AGENTS.md](./AGENTS.md)。
> 本文档定义"怎么做":架构、状态机、模块、数据、流程、UI。带 ⚠️ 的是可调默认值,实现前可再议。

## 1. 目标与非目标

**目标**
- 无 plan/model 时,把用户在 ZCode 对话框的输入(连同工程、会话上下文)录制下来;
- plan 可用时,把录制的消息回放进真实对话框执行;
- 对话框旁红/绿/黄点直观呈现状态;
- helper 常驻,负责以受控方式启动并监视 ZCode。

**非目标**
- 不做降级模式(无 CDP 的任何"凑合"路径);
- 不逆向 ZCode 渲染层↔后端服务的私有协议(提交只走真实 UI 管道);
- 不改动 ZCode 本体(app.asar、配置文件结构);
- 不做多实例 ZCode、多用户、远端控制;
- 不使用 TUI/终端作为操作界面——ZCode 官方交付形态是桌面 GUI(捆绑的 CLI/TUI 并非面向用户的产品界面),helper 亦为 GUI;所有 ZCode 交互均经 CDP 驱动其 GUI。

## 2. 总体架构

```
┌─────────────────────── helper(独立 Electron 应用)───────────────────────┐
│  主进程(引擎)                          渲染进程(小窗口 UI)             │
│  ├─ supervisor(spawn/保活/受控重启)     ├─ 状态面板(灯/模式/队列计数)  │
│  ├─ cdp-client(连接/重连/CDP 封装)      ├─ 队列查看(pending/sent/failed)│
│  ├─ state-machine(RECORDING/PLAYING)   ├─ 操作按钮                     │
│  ├─ interceptor(Enter/提交按钮接管)    └─ 设置(端口/时间表/路径)      │
│  ├─ snapshotter(composer 周期快照)                                     │
│  ├─ player(回放编排)                                                  │
│  ├─ indicator(圆点注入)                                               │
│  ├─ queue(pending 队列存储)                                           │
│  ├─ metadata(db.sqlite 只读副本)                                      │
│  └─ logger(JSONL)                                                     │
└──────────────────────────┬─────────────────────────────────────────────┘
                           │ CDP(127.0.0.1:9222)
                    ┌──────▼──────┐
                    │ ZCode 桌面端 │  ← 永远由 helper 带端口拉起
                    └─────────────┘
```

- helper 数据目录:`%APPDATA%\zcode-helper\`(⚠️队列/日志放 userData,不进项目源码目录;**2026-11-19 修订:开发测试阶段日志落代码库 `logs/`**——源码运行 `app.isPackaged=false` 时由 main.js 传入覆盖目录,打包后自动回 userData);
- CDP 端口:默认 9222,⚠️启动前检测占用,被占则顺延到 9223/9224…并记住本次选择。

## 3. 状态机

```
                     ┌─────────── ZCode 未运行 ───────────┐
                     │ helper spawn ZCode(带端口+工作区)  │
                     ▼                                    │
  ┌──────────────┐  连接成功   ┌─────────────────────────────────────┐
  │ UNCONTROLLED │───────────►│ CONNECTED                           │
  │(未受控:面板  │            │ 模式 = RECORDING ⇄ PLAYING(见 §4)  │
  │ 提示+重启按钮)│◄───────────│ 回放进行中 = 子状态 REPLAYING        │
  └──────────────┘  CDP 断开  └─────────────────────────────────────┘
        ▲            (app 被手动关闭/重启/未带端口)
        │
        └── 用户点击【重启受控 ZCode】→ 结束 ZCode 进程 → 带端口重启 → 自动重连
```

- **UNCONTROLLED**:helper 与 ZCode 的 CDP 连接不可用(含"ZCode 先于 helper 启动且无端口")。面板明示,不进行任何录制/回放;
- **受控重启按钮**:点击前置条件是用户自行确认 ZCode 内无进行中的对话任务;点击后 helper 结束 ZCode → 带端口重启 → 自动重连 → 恢复 CONNECTED;
- RECORDING ⇄ PLAYING 的翻转由 §4 的模式信号驱动,判断全部在 helper 侧完成。

## 4. 模式判定(何时录制、何时回放)

主方案:**时间表**(⚠️配置项,默认 23:00 生效)——免费 plan 生效时刻固定,最简单、零消耗;到点翻转为 PLAYING,失效时刻(可配置,如次日 0:00)翻回 RECORDING。

预留接口:**探针**(可选增强,后续再加)——CDP 读模型选择器 DOM / 配额展示区域(零消耗、纯 GUI 路径),用于 plan 生效时间不固定的场景。

⚠️辅助信号:回放失败若因"无可用模型"(面板可见报错),立即翻回 RECORDING 并保留队列,防止空转。

## 5. 模块设计

| 模块 | 职责 | 要点 |
|---|---|---|
| supervisor | spawn/保活/受控重启;ZCode 进程退出检测 | ZCode 由 helper 拉起;非受控退出→UNCONTROLLED |
| cdp-client | CDP 连接、JSON-RPC 封装、Runtime/Input 域、断线检测 | 复用探索期已验证的裸 WebSocket 方案;断线 3s 内上报状态机 |
| dom-adapter | 所有 DOM 选择器/注入逻辑的唯一出处 | 选择器随 ZCode 升级漂移的隔离层;每个选择器带 `data-zfh-*` 探测函数与版本注释 |
| interceptor | 录制态接管 Enter(capture)+ 提交按钮点击;截获入队;注入可见反馈 | 仅录制态生效,判断在 helper 侧;播放态完全放行 |
| snapshotter | composer 周期快照(⚠️2s,变化才记)+ 会话切换快照 | 补漏"打了字没提交就切走";与截获队列按 (sessionId, 内容) 合并去重 |
| player | 回放编排:按 workspacePath 分组 → 打开工作区 → 定位会话 → 注入 + 真实 Enter → 校验清空 → 标记 sent | 失败标记 failed 不自动重试;面板显示失败原因可手动重发 |
| indicator | 注入 🔴录制 / 🟢播放 / 🟡回放中 圆点 + 暂存计数徽标 | UNCONTROLLED 时 ZCode 内无圆点(状态只在 helper 窗口) |
| metadata | db.sqlite 只读副本:session↔workspace 映射、会话标题 | 只读,拷贝后查询;辅助回放定位与队列归档 |
| logger | JSONL 事件流 + export 打包 | 规范见 HANDOFF §6.5 |

## 6. 数据模型

**队列条目**(pending 队列,存储为 JSONL,逐行追加):
```json
{
  "id": "q_20261119_230501_a1b2",
  "ts": 1763503501000,
  "workspacePath": "D:\\Coding\\miscJar",
  "sessionId": "sess_xxx",
  "source": "intercept | snapshot",
  "text": "编译通过后发布到 github",
  "status": "pending | sent | failed",
  "sentAt": null,
  "error": null
}
```
- `source: snapshot` 的条目在截获条目覆盖同一会话且内容相同时自动合并(去重规则见 HANDOFF §5b);
- 状态只能单向推进 pending → sent / failed;failed 允许手动重置为 pending。

**日志事件**(JSONL,单条自足):`mode-flip` / `capture` / `draft-snapshot` / `cdp` / `replay` / `supervisor`,均带 `ts` 与上下文字段。

**配置**(config.json,同 userData 目录):
```json
{
  "zcodeExePath": "C:\\Users\\kaikai\\scoop\\apps\\zcode\\current\\ZCode.exe",
  "cdpPort": 9222,
  "modeSchedule": { "activeFrom": "23:00", "activeTo": "23:59" },
  "fixedModelId": "GLM-5.3-Flash",
  "snapshotIntervalMs": 2000
}
```

## 7. 关键流程

**启动(helper 先行,正常路径)**
1. helper 启动 → 读配置 → spawn ZCode(带端口 + 默认工作区)→ 连 CDP → CONNECTED → 按时间表进入模式。

**启动(helper 后行,ZCode 已存在)**
2. 尝试 CDP:成功 → 接管;失败 → UNCONTROLLED,面板提示 + 重启按钮。

**录制(RECORDING)**
3. 用户输入 → Enter/按钮被拦截 → `capture` 事件入队 → 圆点徽标 +1;
4. 用户没提交就切走 → `draft-snapshot` 入队 → 去重合并。

**翻转(RECORDING → PLAYING)**
5. 时间表到点 → `mode-flip` → 面板变绿 → 自动开始回放(⚠️可配置"到点自动回放"或"到点后手动点回放",默认自动)。

**回放(PLAYING/REPLAYING)**
6. 队列按 workspacePath 分组 → `ZCode.exe <工作区路径>`(second-instance 打开)→ 定位目标会话 → `Input.insertText` 注入 → 真实 Enter → 校验 composer 已清空 → 标记 sent;
7. 单条失败(切会话失败/发送失败/模型报错)→ 标记 failed → 中止本轮回放 → 面板显示;若因模型不可用,触发翻回 RECORDING(§4 辅助信号)。

**备选回放通道:官方 bot control(已评估,关闭——见 HANDOFF §5c)**
代码级核验:webhook provider 为出站通知(ZCode→用户系统,事件 `zcode.bot.test`/`zcode.bot.message`),方向与回放相反;聊天平台入站需 helper 扮演平台客户端,成本高于收益。回放维持 CDP 注入单一通道(player 的 `replayChannel` 抽象保留,固定 `cdp`,应对未来官方开放入站接口)。

**退出**
8. helper 退出默认保留 ZCode 运行(它已带端口,helper 重启后直接重连即回 CONNECTED);⚠️托盘菜单提供"退出并同时关闭 ZCode"。

## 8. 小窗口 UI

```
┌─ zcode-helper ──────────────────── ─ □ ✕ ┐
│  ● 录制中            [受控 ✓  CDP 9222]           │
│  ──────────────────────────────────────────────── │
│  模式: 🔴 RECORDING(至 23:59)                    │
│  队列: pending 3   sent 12   failed 0             │
│                                                   │
│  [ 立即回放 ]  [ 暂停录制 ]  [ 查看队列 ]          │
│  [ 重启受控 ZCode ](仅未受控时可用)              │
│  ──────────────────────────────────────────────── │
│  最近事件: 23:00:02 mode-flip → PLAYING           │
└───────────────────────────────────────────────────┘
```
- 固定小尺寸、可置顶、最小化到托盘;队列查看弹出列表(内容/会话/状态/失败原因,可手动重发 failed);
- 状态灯语义:**🔴录制 / 🟢播放 / 🟡回放进行中 / ⚪未受控**(ZCode 内圆点只在受控时存在,未受控状态只体现在本窗口)。

## 9. 边界与风险

| 风险 | 对策 |
|---|---|
| ZCode 升级导致 DOM 漂移 | dom-adapter 单点适配;每个选择器带探测函数,失配时面板报"适配层需更新"而非静默失效 |
| 模式翻转瞬间用户正回车 | 拦截判断每次实时读 helper 状态;翻转有 500ms 静默窗(⚠️)不拦截新提交 |
| 回放时 plan 配额中途耗尽 | 立即中止,剩余条目保持 pending,面板提示 |
| CDP 端口被其它进程占用 | 启动探测顺延端口;配置可写死 |
| 会话列表 DOM 定位失败 | 降级为"当前会话/新会话"回放(策略见 HANDOFF §5b),条目标注 note |
| 用户手动重启 ZCode | supervisor 检测到→UNCONTROLLED→面板按钮流程 |
| 队列堆积过大 | 面板计数提示;sent 条目滚动归档(⚠️保留 7 天) |

## 10. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 | Electron 骨架 + supervisor + cdp-client + 状态窗口 | helper 拉起受控 ZCode,窗口显示 CONNECTED;手动重启 ZCode 后正确进入 UNCONTROLLED 并可用按钮恢复 |
| M2 | dom-adapter + indicator | VM 上完成 composer/会话列表 DOM 摸底,圆点注入成功 |
| M3 | interceptor + snapshotter + queue | 无 plan 环境下提交被截获入队、切走快照补漏、去重正确 |
| M4 | state-machine + player | 时间表翻转;有 plan 环境回放真实执行并标记 sent |
| M5 | logger + export + 端到端 | VM 全流程跑通,export 文件可在 host 复现 |

测试全程在 VM(无 plan)进行,回放链路在 host 23:00 后真实验证。
