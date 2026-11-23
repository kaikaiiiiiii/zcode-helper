# zcode-helper — 探索交接文档

> 来源:2026-11-19 在 ZCode 草稿工作区完成的可行性探索会话(sess_8252cf59,标题"zcode 定时任务是否需要 coding plan")。
> 本文档是该会话的全部已验证结论,供本项目任何新会话直接接续。

## 1. 产品定义(用户构想)

**zcode-helper**:一个伴随 ZCode 桌面端运行的 helper 工具。

- helper 启动 ZCode,保持常驻监控;
- **无 plan/model 可用时(录制态)**:用户在 ZCode 对话框输入的文字被 helper 保存,同时记录对应工程、session 等上下文;
- **有 plan/model 可用时(播放态)**:回放录制的消息让其执行;免费 plan 固定模型 GLM-5.3-Flash,可先写死,未来有新 plan 再改;
- UI:对话框旁 **红点 = 录制,绿点 = 播放**。

## 2. 用户环境与约束

- Windows,ZCode 桌面端 3.18.2(scoop 安装)。**官方交付形态是桌面 GUI 应用**(未提供面向用户的 TUI/终端界面),helper 的所有 ZCode 交互都是 GUI 操作、经 CDP 驱动;
- `ZCode.exe`:`C:\Users\kaikai\scoop\apps\zcode\current\ZCode.exe`;安装目录内捆绑 `resources\glm\zcode.cjs`(探索期仅用于核验事实,helper 设计不依赖);
- Start Plan(ZCODE GLOBAL BUILD token 包)**23:00 生效,白天 key 失效**:白天查不到 key 下任何 model,模型列表为空且无法选择(VM 实测提示:"当前没有可用模型。请开通编程套餐或配置自定义模型。");
- 免费 plan 模型名固定 → 可盲选/写死。

## 3. 已验证的机制(可直接依赖)

| 机制 | 验证结论 |
|---|---|
| CDP 调试端口 | 打包版不拦截 `--remote-debugging-port`(app.asar 无覆盖代码;开发版自身就 appendSwitch 9229)。启动:`ZCode.exe --remote-debugging-port=9222 --remote-allow-origins=* [工作区路径]` |
| 工作区参数 | 目录路径作为 ZCode.exe 参数,冷启动与 second-instance 都会打开对应工作区(`handleOpenWorkspacePath`);另有 `zcode://` 深链协议 |
| CDP 客户端 | `GET http://127.0.0.1:9222/json` 列 targets → WebSocket 连 `webSocketDebuggerUrl` → `Runtime.evaluate` / `Input.insertText` / `Input.dispatchKeyEvent`。Electron 运行时是 Node 24,自带全局 WebSocket,**零第三方依赖** |
| 对话框注入 | `Input.insertText` 走真实输入管道(React 可收到事件),随后 Enter keyDown/keyUp 发送 |
| Playwright | app.asar 内置 Playwright——厂商内部同款做法 |
| db.sqlite | `~/.zcode/cli/db/db.sqlite`:表 `session`(id, project_id, workspace_id, directory, path, title…)、`message`、`part`、`session_input`、`local_setting`。**先拷贝副本再只读打开**(WAL) |
| 工程→session 映射 | `session.directory/path` 存工作区路径;`local_setting` 的 project id 由路径派生(`proj_d-coding-hotswork` 格式) |
| 捆绑 CLI(探索期事实记录,helper 不使用) | 内部存在 headless 模式(`-p/--json/--resume` 等)与 `app-server`(ZCode Protocol stdio JSON),但 CLI/TUI 均非官方交付的用户界面;helper 全部经 CDP 驱动桌面 GUI |
| bot control(远程对话控制) | app.asar 内置 Telegram/Feishu 客户端与资源;zcode.cjs 定义 provider 枚举 `["telegram","webhook","feishu","lark","weixin","discord","wecom"]`、绑定 schema(provider/botId/providerUserId/chatType)与会话流式卡片。机制:聊天平台消息 → 官方中继(zcode.z.ai)→ 本地会话。**其中 `webhook` provider 是否可作为 helper 的官方回放入口,待核验** |
| 会话存储 | 会话持久于 db + `~/.zcode/cli/` 下;可跨进程并发访问;app 重启后可恢复 |

## 4. 已失败路径(不要重试)

**headless CLI 的模型选择无法本地预设**(7 种手段全部实测无效):
1. `v2\provider_config.json` 写 `defaultModelSelection`(builtin:/account: 前缀都试过)
2. `~/.zcode/cli/config.json` 顶层 `defaultModelSelection`
3. `db.sqlite` `local_setting` 表插入 user/model/defaultModelSelection 行
4. `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 环境变量
5. `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` + `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 双件套(复用桌面端 264KB `zcode-builtin.json`)
6. prompt 内嵌 `/model` 斜杠命令
7. `--surface desktop` 路由

根因:**模型可用性与套餐硬绑定**。无套餐时模型列表为空、连"选默认模型"这一步都做不了。helper 不走 headless 路线(全部经 CDP 与桌面端真实 UI),此门槛不影响本方案。
另有杂音:`-p` 输出重定向到文件时 CLI 报 `Unknown option '-N'`(疑似自身参数解析 bug);ERA 版本协商错误为次生噪音。

## 5. 无 plan 时的输入行为:用户实测为"暂存"(2026-11-19 修正)

用户在 VM 实测:**无 plan/model 时,输入框可以打字但 Enter 不会提交**(提交即触发模型调用,无模型被 UI 阻止)。暂存状态真实持久:
- 切到其它对话再切回,暂存文字仍在(暂存按会话隔离);
- 退出 ZCode 再启动,暂存文字仍在(有持久化,位置未验证)。

由此 HANDOFF 的关键未知点修正为两个:

**5a. 暂存的持久化位置——问题已随"无降级模式"决策移除**
helper 只依赖 CDP(连不上即提示受控重启),不存在无 CDP 的录制路径,因此不再需要关心 app 把暂存存在哪;暂存一律经 composer DOM 周期快照 + 会话切换快照捕获。

**5b. 回放语义 = helper 接管提交(设计已定)**
录制态:helper 在 document 上挂 capture 阶段 keydown 拦截 Enter(composer 聚焦时)+ 提交按钮点击拦截,`preventDefault` 后截获内容入队列;app 侧不发生任何提交。播放态:完全放行,helper 将队列消息注入 composer 并派发真实 Enter(等价于用户亲手提交,走完整 UI 管道)。

必须处理的细节:
1. 拦截只在录制态生效,模式切换防竞态(判断在 helper 侧);
2. 截获内容与 app 暂存的去重:回放前比对 composer 当前内容,一致则替换、不一致则两条都留(旧截获+新快照);
3. "打了字没按 Enter 就切走"的场景靠周期快照补漏,与截获队列合并去重;
4. 截获后给用户可见反馈:红点计数徽标或 composer 上方注入横幅"已暂存 N 条,待回放"。

没有公开的"直接提交"接口;渲染层↔后端服务的私有协议不建议逆向。CDP 模拟真实输入(`Input.insertText` + 真实 Enter)就是正式提交路径。回放里真正脆弱的是**切到目标会话**:切工作区已解决(路径参数),切会话需点会话列表 DOM(待 VM 摸结构);可策略性降级为"回放进该工作区当前会话/新会话"。

**5c. 备选回放通道:官方 bot control(2026-11-19 评估,已关闭)**
官方功能"Start and steer ZCode from WeChat, Feishu, or Telegram"经代码级核验:
- 绑定存储:`~/.zcode/v2/bot-config.v3.json`(`{version:3, bots:[]}`,本机为空,从未绑定);schema 含 id/name/provider/enabled/credentialRef/webhookSecretRef/webhookUrl/webhookAuthHeaderName/feishuAppId/providerUserId/displayName/**allowedWorkspaces**/allowedCommands/replyMode;
- **webhook provider 是出站通知,不是入站提交**:app.asar 中该 provider 的 `test`/`send` 均为 ZCode 向 `webhookUrl` POST(认证头 `x-zcode-bot-secret` 或自定义,事件类型 `zcode.bot.test` / `zcode.bot.message`)——即 ZCode 把回复推给你的系统,方向与回放相反;
- 入站只能走聊天平台(telegram/feishu 等):helper 需扮演聊天平台客户端(平台凭据、第三方客户端合规、延迟),且消息路由到 bot 绑定的 `allowedWorkspaces` 首个工作区(`firstAllowedWorkspace`),目标会话粒度不可控;
- **结论:关闭 bot 回放路线**,回放维持 CDP 注入主方案(录制本来就需要 CDP)。bot control 与 helper 互补不冲突:用户仍可用它从手机远程指挥 ZCode,helper 管本地录制/回放。

## 6. 架构骨架(建议)

```
zcode-helper(独立 Electron 应用:一个小窗口展示自身状态与操作按钮——录制/回放/队列查看;引擎跑在 helper 主进程)
├─ launcher   spawn ZCode.exe --remote-debugging-port=9222 [工作区]
│             连接管理:ZCode 已存在则先试 CDP;连不上 → 面板提示 + 【重启受控 ZCode】按钮
│             (用户确认任务完结后点击 → 结束进程 → 带端口重启 → 自动重连)
├─ state      RECORDING ⇄ PLAYING
│             状态信号:时间表(23:00,最简)为主;可选增强为 CDP 读模型选择器 DOM(零消耗)
├─ recorder   CDP 拦截提交 + composer 周期快照(变化才记)
│             → pending 队列:{ts, workspacePath, sessionId, text, status}
│             db.sqlite 只读副本仅用于 session↔workspace 映射等元数据补充
├─ intercept  录制态接管 Enter/提交按钮(capture 拦截),截获入队并给可见反馈
├─ player     按 workspacePath 分组逐条回放 → 注入 composer + 真实 Enter → 标记 sent
└─ indicator  CDP 注入 fixed 定位圆点:🔴录制 / 🟢播放 / 🟡回放中
```

## 6.5 日志与可复现性(VM 测试 ↔ host 开发的桥梁)

开发在有 plan 的 host、测试在无 plan 的 VM,日志必须让"无 plan 场景"回到 vibe coding 时可复现:

- **结构化 JSONL**,每行独立可读(含时间戳、workspacePath、sessionId):
  - `mode-flip` 状态机翻转及原因(探针结果/时间表);
  - `capture` 截获的提交(全文);
  - `draft-snapshot` 暂存快照(全文 + 所属 session,变化才记);
  - `db-poll` 库变化增量;
  - `cdp` 连接/断开/重连及原因;
  - `replay` 每条回放的注入内容、目标会话、结果。
- 周期快照存全文而非 diff(消息短,空间不敏感);
- **export 动作**:日志 + 当前队列 + app 版本 + 状态机轨迹打包成单文件,供拷回 host 丢给有 plan 的会话复现问题。

## 7. 部署形态与连接管理(无降级模式)

`--remote-debugging-port` 是 Chromium 启动期参数,进程运行后无法补开;单实例锁下第二个带参进程只转发工作区路径、不转发端口开关。**不做任何降级模式:helper 的全部功能(录制/回放/圆点/接管提交)都以 CDP 连接为前提,连不上即"未受控"状态。**

- helper 常驻(开机自启/托盘),正常路径:helper 先启动 → 由它带端口拉起 ZCode;
- helper 启动时发现 ZCode 已存在:先尝试 CDP 连接;
  - 连上 → 直接接管,正常工作;
  - 连不上(实例未带端口)→ 面板提示"ZCode 未受控,需重启以建立连接",并提供【重启受控 ZCode】按钮;
- 用户确认当前正在运行的对话任务都已完结后点击按钮 → helper 结束 ZCode 进程 → 带端口重新拉起(会话持久可恢复)→ 自动重连 CDP;
- 运行期间 CDP 断开(app 被手动重启等)同样回到"未受控"提示态;
- 可选辅助:一次性给用户快捷方式补端口参数(更新后可能被重写,只作辅助,降低需要点按钮的概率)。

设计取舍:录制以 **db 为主**(结构化、可靠),DOM 只兜底"已输入未落盘"的增量;圆点/界面交互挂 DOM(选择器会随 app 升级漂移,需适配层);不写活库(需要写时先关闭 app)。

## 8. 一次性的手工步骤(无法自动化,产品硬绑定)

有 plan 生效后(23:00 后)做一次:在桌面端模型选择器里把目标会话的模型确认/固定(免费 plan 模型名固定,可盲选输入)。此后该会话沿用此选择,CDP 回放无需再管模型。未来可探索由 helper 经 CDP 代点模型选择器完成这一步(未验证)。
