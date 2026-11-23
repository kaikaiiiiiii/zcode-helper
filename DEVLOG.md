## 轮次 37：ZCode 4.0.0 升级检查（2026-11-24 00:50）

3.19.1 → **4.0.0.10870**（更新器自动下载安装；3.19.1 的 exe 在待更新期间已无法启动，所以没能补存 3.19 全量快照）。

结果：**选择器零漂移**。

1. 冒烟 `npm run smoke:dom --panel`：**21/21 通过**——输入框、会话列表（15 个）、附件行、chat-loading、
   workspace、项目展开、新会话判定、侧栏（490px）、模型触发器（`haspopup=dialog`）、额度横幅、probeModel、
   settingsBack、模型面板（`composer-model-panel`，10 项）、供应商列表（悬停/点击都能出）、「管理模型」按钮，全部可用。
2. 端到端真实发送：目标会话 `sess_ba290359`（触发器为「选择模型」）→
   `session-switch → model-refresh → model-cache-hit(OpenCode Go / glm-5.3-flash) → sent → session-started`，
   队列状态 `sent`，`idleGuardSeconds` 临时调 0 后又恢复为 5。
3. 快照：`npm run snapshot:dom -- --tag 4.0.0` → `logs/dom/snap-4.0.0-2026-11-23T16-43-16-719Z.json`（232 KB），
   含 composer / sidebar / 15 条会话 / 模型面板 / 供应商面板 / 设置页 HTML 与适配层各表达式返回。
4. 测试：单元 61、DOM 74 全绿（夹具未改）。
5. 小观察：4.0 的模型触发器文案可能同时拼出「glm-5.3-flash 最高 选择模型」这种过渡文本；
   判定早已改为只看 `data-model-current-value`，因此不受影响。

结论：4.0 可直接用，无需改适配层。

## 轮次 36：改名与发布准备（2026-11-23 21:00，v0.5.34）

按"界面显示的品牌一律 ZCode / ZCode Helper"统一：

1. **UI 文案**：面板/队列/设置窗口标题 →「ZCode Helper」「设置 — ZCode Helper」「队列 — ZCode Helper」；
   托盘 tooltip、设置里的「ZCode Helper 启动时自动拉起 ZCode」「ZCode Helper 拉起 ZCode 时打开」、
   数据目录提示 `%APPDATA%\ZCode Helper\`。
2. **应用名**：`app.setName('ZCode Helper')` → userData 变为 `%APPDATA%\ZCode Helper`；
   `migrateUserData()` 扩展为从 `zcode-freeplan-helper` / `zcode-helper` 两个旧目录迁移 config/queue/logs。
3. **打包**：`productName: "ZCode Helper"`，产物 `ZCode-Helper-Setup-<ver>-<arch>.exe` / `ZCode-Helper-Portable-...`。
4. **踩到一个坑**：productName 带空格会让 electron-builder 生成 `ZCode Helper.exe`，而这个 exe
   **启动即静默退出（exit 0）**——同样的 app.asar 用 `electron.exe` 或改名为 `ZCodeHelper.exe` 都正常。
   → 加 `build.executableName: "ZCodeHelper"`：exe 文件名无空格，显示名仍是「ZCode Helper」。
5. **迁移顺序的坑**：`migrateUserData()` 按数组顺序遍历旧目录、目标已存在就跳过——先遍历 `zcode-freeplan-helper`（更早的一份）
   会把 `zcode-helper` 里的新配置挡掉，导致新目录里 `idleGuardSeconds`/`modelRefreshSeconds`/`modelBestMatch` 全丢。
   → 改成**从新到旧**遍历（`zcode-helper` 优先），并删掉新目录里那份错的 config 重新迁移，值已恢复。
6. **README**：标题/头图 alt/产物名/版权/英文段全部改名；新增「已测试的 ZCode 版本：3.18.x ~ 3.19.x」；
   修正过时描述（模型两层判断、供应商扫描+缓存、刷新列表会短暂切页面、删掉"只读 SQLite"那段）。
   图片重新生成：hero（标题改成 ZCode Helper）、panel、queue（lightbar 无品牌文字，未动）。
6. 验证：单元 60 / DOM 74 / 冒烟 21 全绿；`build:dir` 与完整 `build` 均成功，
   解包 exe（ZCodeHelper.exe）能正常启动、窗口标题「ZCode Helper」、CDP 连接正常。

## 轮次 35：3.19.1 端到端跑通（2026-11-23 20:15，v0.5.34）

用户要求"走一遍"整条链路。用一条真实队列消息（目标会话 `sess_4c4a414f`，它的触发器正好是「选择模型」）跑完：

```
19:57:21 replay/batch-start
19:57:21 supervisor/open-workspace  → D:\Coding\hash2cdn
19:57:22 cdp/workspace-switch
19:57:24 replay/session-switch      → 切到目标会话
19:57:24 probe/model-refresh        → 选择模型 → 面板 → 管理模型 → 设置页 → 返回工作区
19:57:32 probe/provider-scan        → DeepSeek API（无白名单）
19:57:44 probe/model-state minimax-m3.1-flash（切供应商时的自动选中）
19:57:45 probe/model-state glm-5.3-flash（切到 OpenCode 后命中白名单）
19:57:45 probe/model-cache-save     → OpenCode Go (Chat) API / glm-5.3-flash
19:57:49 replay/sent
19:57:51 replay/session-started     → 会话真的开跑
19:57:51 replay/batch-end           queue: status=sent
```

过程中发现并修掉两个真问题：

1. **`_refreshModelList` 在一次大段替换里被误删**，导致 `_probeTick` 每轮抛 `is not a function`，
   整条排空链路静默停摆（不报错、不发消息、日志只有 probe）。
   → 恢复方法；同时给 `_probeTick` 加 try/catch + 限流 `tick-error` 日志（以后这类异常不会再静默）。
2. **触发器过渡态**：切换会话/供应商后文案会短暂变成「选择模型 glm-5.3-flash 最高」这种混合文本。
   → `_ensureModelReady` 的快照判定改为**只看 `data-model-current-value` 有没有值**，不再依赖文案。
3. 供应商子菜单是 hover 弹出，时机敏感 → `_openProviderMenu` 与冒烟脚本加"点击兜底"。

结果：冒烟 21/21、DOM 74/74、单元 60/60；`idleGuardSeconds` 临时调 0 后已恢复 5；
`modelBestMatch` 已落盘为 `OpenCode Go (Chat) API / glm-5.3-flash`。

## 轮次 34：适配 3.19.1 的模型面板（2026-11-23 19:55，v0.5.32）

供应商重新配置后发现：**3.19.1 把模型面板从 Radix Menu 换成了 Popover**。

| 元素 | 3.18.2 | 3.19.1 |
|---|---|---|
| 一级面板 | `[role="menu"]` | `div[role="dialog"][data-testid="composer-model-panel"]` |
| 二级面板 | `[role="menu"]` | `div[role="dialog"][data-testid="composer-provider-panel"]` |
| 模型项 | `[role="menuitemradio"]` + `aria-checked` | `button[role="option"]` + **`aria-selected`** |
| 供应项 | `div[role="menuitemradio"]` | `button[role="option"]` + `aria-selected` |
| 「管理模型」 | `div[role="menuitem"]`（无 testid） | `button`（无 testid、无 role） |
| 触发器 | `aria-haspopup="menu"` | `aria-haspopup="dialog"` |

改动：
1. `modelMenuSrc` 容器选择器 → `[data-testid="composer-model-panel"], [role="menu"], [data-radix-menu-content]`；条目兼容 `[role="option"]`；`checked` 兼容 `aria-selected`。
2. `modelListSrc` / `modelProviderListSrc` 的 `checked` 同样兼容 `aria-selected`。
3. `modelPanelManageSrc` → 在 `[data-testid="composer-provider-panel"]` / `[role="menu"]` / `[role="dialog"]` 里找文案为「管理模型」的 `button`/`menuitem`/`option`。
4. 供应商子面板靠 **hover** 弹出，`_openProviderMenu` 和冒烟脚本改成"先移到附近再移到目标"两次 mouseMoved（否则时有不触发）。
5. 新 fixture `test/fixtures/model-panel-dialog.html`（3.19.1 结构）+ 6 条断言；旧的 `model-panel.html`（3.18 结构）保留，两边都测。
6. 新增单元用例：扫描全部供应商 → 全量清单 → 按白名单顺序全局匹配。

结果：**冒烟 21/21、DOM 74/74、单元 60/60**；实机 v0.5.32 正常（灯条「助手工作中」0/2）。

## 轮次 33：ZCode 3.19.1 升级检查（2026-11-23 19:25）

升级到 **3.19.1.10833**（19:16 安装器拉起，没带调试参数 → 用户手动点「重启受控 ZCode」后 19:22:40 连上）。

结果：
1. **CDP + 注入正常**：`inject-boot 0.5.31` ×2、`mode-ack`、`probe` 都回来了。
2. **DOM 冒烟 16/16 通过**：输入框、会话列表（17 个）、附件行、chat-loading、workspace、项目展开、
   新会话判定、`openProjectNewTask`、侧栏（490px）、模型触发器、额度横幅、probeModel、settingsBack 全部可用。
3. **升级把模型供应商配置清空了**：横幅 `model_config_missing`「当前没有可用模型。请开通编程套餐或配置自定义模型。」
   → 触发器回到 `管理模型`，所以**模型面板（供应商/模型列表/管理模型项）这条路径这轮没验证到**。
4. 离线测试：单元 59 / DOM 68 全绿。

待办：用户重新配好供应商后，跑 `npm run smoke:dom`（带 --panel）验证面板结构。

## 轮次 32：补齐 DOM 覆盖（2026-11-23 19:40，v0.5.31）

上一轮审计发现 8 个表达式零覆盖，这轮全部补上：

1. 新 fixture：
   - `test/fixtures/model-panel.html`：模型触发器 + 一级面板（供应商触发器 / 3 个模型项，含一个 `aria-disabled` / 思考强度）+ 二级面板（2 个供应商 + 「管理模型」）。
   - `test/fixtures/settings-page.html`：`settings-back-button`。
2. 新增 10 条断言：`modelTriggerStateSrc`（text/value/haspopup/坐标）、`modelListSrc`（名字/选中/禁用/坐标）、
   `modelItemPickSrc`（命中 + 不存在）、`modelProviderCurrentSrc`、`modelPanelProviderSrc`、`modelProviderListSrc`（checked 标记）、
   `modelPanelManageSrc`（管理模型项）、`settingsBackSrc`（在设置页 / 不在设置页）。
3. 结果：DOM 58 → **68**；单元 59 不变。全绿。
4. 现在的覆盖：适配层 34 个表达式里，除 `debugDomSrc`（调试用）外都有断言或冒烟覆盖。

## 轮次 31：DOM 冒烟脚本（2026-11-23 19:20）

升级 ZCode 前的准备：DOM 单元测试跑的是**静态 fixture**（8 个页面、58 条断言），验证的是适配层逻辑，
**抓不到真实 DOM 漂移**。因此新增 `scripts/dom-smoke.js`：

- 对着正在运行的 ZCode 逐个跑适配层表达式，检查返回形状；
- 默认只读；`--panel` 会打开模型面板读模型列表 / 供应商 / 管理模型项，读完 Esc 关闭；
- 结束时若发现自己把界面带到了设置页，会点「返回工作区」还原（脚本自己开的自己关）；
- 退出码 0/1，失败项逐条列出。

`npm run smoke:dom`（含面板）/ `npm run smoke:dom:read`（只读）。

升级前基线（ZCode 3.18.2）：**17/17 passed**。

## 轮次 30：最佳模型缓存（2026-11-23 18:55，v0.5.30）

1. 新增配置项 `modelBestMatch`（持久化）：`{ provider, providerTid, model }`，记录上次匹配成功的最佳选择。
2. 发送前（`选择模型` 分支）顺序变为：
   - **先试缓存**：面板里切到缓存的供应商（已是当前就不用切）→ 列表里找同名模型 → 找到直接点它，**不扫描**；
   - 供应商没了 / 该供应商下模型名没了 → 记 `probe/model-cache-invalidate`，清空缓存，走全量扫描；
   - 扫描命中 → 写入缓存（`probe/model-cache-save`）。
3. 与"无模型"（`管理模型` → 刷新列表）是两条独立路径：缓存失效只影响"选哪个模型"，不影响"有没有列表"。
4. 测试：单元 59（新增：缓存命中不点击、模型消失失效、供应商消失失效、写入/读取/清空），DOM 58。

## 轮次 29：跨供应商全局匹配 + 还原（2026-11-23 15:10，v0.5.29）

1. **先扫全量、再按白名单顺序匹配**：`_scanAllProviders()` 依次切到每个供应商，收集
   `{provider, providerTid, name, text, checked}` 全量清单；`_matchWhitelistGlobal()` 按白名单**顺序**在清单里找，
   命中后才 `_switchProvider(hit.providerTid)` 并点中该模型。
   —— 这样就解决"先切到 Zhupu 就匹配到 GLM-5.3-Flash、但白名单第一项其实是 opencode 的 glm-5.3-flash"的问题。
2. **扫描前记录、结束时还原**：记 `originalProvider` + `originalModel`；没命中或点选失败时
   `_restoreProviderModel()` 切回原供应商并重新点回原模型（供应商切换会自动选中第一个模型，所以模型也要还原）。
3. 设置项文案：`模型可用性检测：` → **`允许助手使用的模型：`**。
4. 测试：单元 57（新增：全局匹配按白名单顺序、命中项带供应商），DOM 58。

## 轮次 28：跨供应商找白名单模型（2026-11-23 14:55，v0.5.28）

1. 面板结构（实测，两个供应商）：
   - 主菜单：`composer-provider-trigger`（当前供应商）+ 该供应商的模型列表 + 思考强度；
   - 鼠标移到供应商上 → 右侧二级菜单：供应商列表 `chat-model-select-group-registry-provider:<id>`（`aria-checked` 标当前）+「管理模型」；
   - **点供应商会就地切换模型列表**，并且**自动选中该供应商的第一个模型**（触发器变成「选择模型」但 value 有值）。
2. 实现：`_ensureModelReady` 的第二层改成
   - 打开面板 → 读当前供应商模型列表 → 白名单命中就直接点；
   - 没命中 → `_pickAcrossProviders()`：悬停供应商 → 逐个点未选中的供应商 → 读列表比对白名单；
   - 找到就点它；**没找到则切回原供应商**再判定 `no-whitelist`（避免把用户的模型改掉）。
3. 新增表达式：`modelListSrc` / `modelProviderCurrentSrc` / `modelProviderListSrc`。
4. 实测（DeepSeek API 为当前供应商，白名单 `glm-5.3-flash,GLM-5.3-Flash`）：
   - DeepSeek 列表：`deepseek-flash / deepseek-v4-pro` → 无命中；
   - 切到 OpenCode Go：命中 `glm-5.3-flash` → RESULT hit = glm-5.3-flash。
5. 测试：单元 56，DOM 58。

## 轮次 27：侧边栏折叠检测（2026-11-23 14:35，v0.5.27）

1. ZCode 的侧边栏可以收起：收起时 `aside` 宽度只剩 **6px**、`[data-testid="task-list"]` 不可见，
   但项目/会话的 DOM 仍在（只是被裁掉），所以**所有基于矩形的点击都会失准**。
   展开按钮：`[data-testid="desktop-top-logo-sidebar-toggle"]`（`aria-label="切换侧边栏"`，固定在左上角）。
2. 新增 `sidebarStateSrc`（`expanded` = aside>100px 或 task-list>40px + 按钮坐标）和 `player._ensureSidebar()`：
   收起时点一次展开、等 600ms，仍未展开再点一次。
3. 调用点覆盖所有侧栏相关逻辑：`_switchSession`（最外层）、`_ensureSessionVisible`、`_openNewSession`。
4. 实测：把侧栏收起后插一条指向不存在会话的测试条目 → 日志 `replay/sidebar-expand asideW=6` → 然后才
   `session-not-visible` / `fail`（预期失败，用来验证"先展开再定位"的顺序）。
5. 测试：单元 56（新增 `_ensureSidebar`：收起→点一次；已展开→不点），DOM 58（新增折叠/展开判定）。

## 轮次 26：设置项与"成对刷新"（2026-11-23 14:30，v0.5.26）

1. **数字输入框可打字**：设置里四个数字项（会话数 / 防打扰 / 刷新周期 / 保留天数）从 `type=number` 改成
   `type=text inputmode=numeric`，保存时剥掉非数字再转 Number。实测：聚焦后键入 `17` → 值变成 `17`。
2. **CDP 端口不再是设置项**：ZCode 固定 9222，`cdpPort` 只留作内部默认值（配置里仍存在，但不对外暴露）。
3. **刷新成对**：新增 `_helperOpenedSettings` 标志——只有 helper 自己打开的模型设置页，才会替用户点「返回工作区」；
   用户在设置页里时（探测到 `settings-back-button` 但标志为 0）直接跳过，不代点。
   刷新路径两条：
   - 触发器是 `管理模型` → 点它直接进设置页 → 点返回；
   - 触发器显示模型/选择模型 → 点出面板 → 点供应商项 → 子菜单里的 `管理模型` → 进设置页 → 点返回。
4. 实测（14:2x）：面板 → 供应商「OpenCode Go (Chat) API」→ `管理模型`（无 testid，`role=menuitem`，文案精确等「管理模型」）
   → `settings:true` → 点 `settings-back-button` → 回到对话，触发器仍是 `glm-5.3-flash 最高`。
5. 测试：单元 55，DOM 56。

## 轮次 25：正式版模型可用性判断（2026-11-23 13:45，v0.5.24）

按用户定稿的两层判断重写（workaround 已撤）：

1. **两层判断**
   - 第一层「有没有可用列表」：触发器 `管理模型`（无 `aria-haspopup`）= 没有列表 → 不可用；
   - 第二层「列表里有没有白名单模型」：`选择模型` 时点开面板，按设置里的白名单**顺序、完整相等、区分大小写**匹配，命中才可用；
   - 快照模型名（触发器显示模型）= 直接用该模型发，不挑。
2. **刷新列表**：`管理模型` 时点触发器 → 进「模型设置」页 → 点 `settings-back-button`「返回工作区」→ 回到对话。
   周期 `modelRefreshSeconds`（默认 60，0=关闭，进设置面板），**优先级低于防打扰**，且只在"有积压"时才刷；
   刷新后仍是 `管理模型` → 进冷却（`_modelHoldUntil`，至少 30s），避免每秒重试和反复跳设置页。
3. **发送前**（切到目标会话之后、注入文字之前）执行 `_ensureModelReady()`：
   管理模型→刷新一次；选择模型→面板里白名单挑一个并点中；快照→直接用。
   失败只**停批**、条目保持 pending（不标 failed），冷却到点后再试。
4. **滤网**：`管理模型` → 不可用；`选择模型` → 只有"白名单已确认"（capacity.modelOk）时才算可用；模型名 → 可用。
5. 设置项：`模型可用性检查周期` 改为 `模型列表刷新周期（秒）`（`modelRefreshSeconds`，0–3600）。
6. 测试：单元 55（新增白名单匹配顺序/大小写/禁用、刷新节奏、冷却排空），DOM 56（新增 选择模型+已确认列表/未确认）。
7. 实机：当前 ZCode 没有配置供应商（横幅 `model_config_missing`），刷新后仍是「管理模型」→ 60s 一次刷新 + 冷却，
   队列 2 条保持 pending（`replay/model-unavailable-skip why=no-list`）。

## 轮次 24：可用性判定临时 workaround（2026-11-23 10:30，v0.5.18）

背景：按"客户端只在设置页刷新套餐/模型列表"的正确理解，模型可用性无法从静态 DOM 判定；
但基于旧（错误）理解写的 helper 是可用的，所以先打一个**最小 workaround** 让可用状态保持，正确方案后续再定。

改动（只动判定，不动流程）：

1. `probeModel`：触发器 `aria-haspopup="menu"` 且文本为「选择模型 / 管理模型」→ **视为有列表可用**
   （只是本会话没选模型），并且此时**忽略残留的 `ZCODE_RUNTIME_MODEL_UNAVAILABLE` 横幅**（那多半是上次发送失败留下的）。
   无 `haspopup` 时仍按文本判不可用。
2. `_verifyModelByMenu`：候选模型名匹配改为**不分大小写**（`glm-5.3-flash` 能匹配 `glm-5.3-flash 视觉`）。
3. 设置里 `模型可用性检测` 改为 `glm-5.3-flash`。
4. 测试：单元 55，DOM 56（新增/改写：haspopup 有→可用、无→不可用、haspopup+残留横幅→可用）。

## 轮次 23：模型不可用的反向样本 + 额度横幅判定（2026-11-23 09:10，v0.5.14）

1. 采集（免费期 09:00 结束）：`scripts/capture-model-transition.js` 每 25s 点开模型菜单采样，`limit-probe.js` 被动录 DOM。
   产物：`logs/model-transition-2026-11-23T00-55-36.jsonl`、`logs/model-menu-single-2026-11-23T00-53-44-639Z.json`、
   `logs/limit-probe-2026-11-23T00-55-41.jsonl` + 截图。
2. **关键反直觉结论**：额度用完后的 ~3.5 分钟里，模型菜单里 **模型仍在且不置灰**——菜单判断会误判"可用"。
   真正的即时信号是对话框上方的 `v4-session-quota-banner`（**没有 data-error-code**），文案
   「体验套餐可用额度已用完，请切换到 Coding Plan 订阅或等待额度恢复。」；
   直到 09:03:30 ZCode 才自己翻成 `管理模型` + `ZCODE_RUNTIME_MODEL_UNAVAILABLE` 横幅 + 空菜单。
3. 修复：`probeModel` 先认额度横幅（`quota-banner:` evidence）；`_verifyModelByMenu` 里横幅优先于菜单。
   实测 0.5.14：灯条「无可用模型」、`capacity.modelOk=false`，队列挂起不发送。
4. 顺带验证：红点自动「继续」两次真实触发（09:00:00 / 09:00:06），但在盲窗口里被判"可用"而真的发了出去
   （必然失败）→ 修复后这类条目会一直挂到额度恢复。
5. 测试：单元 55，DOM 54（新增：额度横幅在 → 判定不可用）。

**修正（2026-11-23 09:30）**：上述时间线被操作污染——采样期间用户点了模型菜单/供应商/设置页（probe 点击流 09:00:50–09:03:40 可见），
所以"3 分钟后自动变管理模型"是**用户触发的刷新**，不是自动行为。真实结论：客户端只在用户操作时核对资格，
"显示有模型 + 下拉可选 + 发送被拒"可以长时间保持。菜单/横幅都是缓存态，权威信号只有**请求结果**。
据此增加（v0.5.15）：发送后 3 秒内若新出现额度/模型横幅 → 该条标 `failed`（`model-unavailable: …`）并停批，不再谎报 sent。

## 轮次 22：文件类附件（压缩包）丢失（2026-11-23 01:55，v0.5.13）

1. 现象：截获带 `.rar/.zip` 的消息，回放时压缩包没进对话框。
2. 根因：文件类附件的卡片结构是 `img[alt=""]`（material 图标 `./material-icons/zip.svg`）+ 名字在 `span[title]` 上；
   旧代码一律用 `img[alt]` 当文件名 → 名字为空 → 按名字匹配不到暂存的 File → 没有路径 →
   `_attachFiles` 的 `filter(a => a.path || a.dataUrl)` 把它静默过滤掉，消息照发不误。
3. 修复：`attachmentName()` 按 kind 取名（image→`img[alt]`；file→`span[title]`；video→无）；
   文件类不再把图标 img 当内容；拿不到路径且没有 dataUrl 的附件标 `unresolved`，
   **回放时直接抛错**（`attachment-unresolved`），绝不静默少发附件。
4. 测试：单元 55，DOM 53（新增：压缩包从 `span[title]` 取名并带出原始路径）。实机 0.5.13 验证
   `.zip` → `{kind:"file", name:"zfh-test.zip", path:"C:\\…\\zfh-test.zip", size:117, mime:"application/x-zip-compressed"}`。

## 轮次 21：新建会话的第一条消息（2026-11-23 01:10，v0.5.10）

1. 现象：在「新建会话」窗口截获的消息，`sessionId` 是字面量 `"draft"`，侧栏没有对应条目 → 回放报 `session-not-found`。
2. 实测判定：新建会话窗口的特征是 `[data-testid="chat-empty"]` 存在（无历史）；所属项目读输入框顶部的 `[data-testid="composer-workspace-trigger"]`（如 `action-Downloader`，或「选择项目」表示归到"任务"类）。
3. 捕获：`newConversation` 时 `sessionId/title` 置空，记 `newSession: true` + `draftProjectName`；项目 id / 工作区路径从对应的 `section[data-project-name]` 和它的 li key 反推。
4. 回放：`item.newSession` 时跳过"点侧栏会话"，改为在 `section[data-project-name]` 里点 `[data-testid="virtual-project-create-task"]` 现开一个会话，等 `chat-empty` + 项目 chip 对上，再塞附件、注入文字、回车。项目为「选择项目」时明确失败（不乱发）。
5. 测试：单元 55，DOM 52（新增：新会话 sessionId 置空/项目名、定位新建任务按钮、就绪判定）。实机 0.5.10 验证
   `getSessionInfo()` → `{newConversation:true, sessionId:null, draftProjectName:"action-Downloader", workspacePath:"D:\\Coding\\action-Downloader"}`，
   并实测点「新建任务」后 `newSessionReadySrc` 返回 `{empty:true, chip:"action-Downloader", match:true}`。

## 轮次 20：多模态消息（附件路径）+ 队列附件预览（2026-11-22 21:30，v0.5.8）

1. 实测：附件在 DOM 里是 `div[data-composer-attachment-kind]`；图片靠 `img[alt]` 带文件名，视频是 `<video src=blob:>`（无名字）；隐藏 `input[type=file]` 在 app 摄取后被清空；`fetch(blob)` 能读到真实字节（4.9GB 视频 = 5,283,738,235 B，MP4 头 `ftypmp42`），blob 是**文件引用**不是拷贝。
2. 关键发现：ZCode 把**绝对路径**写进模型输入（model-io 里的 `source.path` 与 `[Image: source: C:\…]` 文本），所以恢复成 helper 目录下的副本会改变模型看到的信息。
3. 解法：页面暴露了 `window.zcode.getPathForFile(file)`（Electron `webUtils` 桥）。注入层在 `change/drop/paste` 捕获阶段暂存 File 引用，拦截时按 文件名+大小 取回**原始绝对路径**；粘贴类无路径 → 读成 data URL 内联存队列。
4. 队列条目新增 `attachments: [{kind,name,path,size,mime,dataUrl?}]`；入队后清空输入框里的附件（点 `button[data-composer-attachment-remove]`）。
5. 回放：切会话 → chat-loading → 模型核验 → **塞附件**（`DOM.setFileInputFiles`；data URL 先落临时文件）→ 等 `data-upload-status=ready` → 注入文字 → 回车。
6. 队列窗口按上屏效果显示附件：`<img src="file:///…">` / `<video>`；文件不存在时不做特殊处理，交给 Chromium 显示破图（与 ZCode 一致）。
7. 测试：单元 55，DOM 49。实机 0.5.8 验证 `readAttachments()` 返回真实绝对路径。

## 轮次 19：纯 DOM 化（删 db）+ 上屏前检查顺序（2026-11-22 19:30，v0.5.6）

1. **删除 SQLite 依赖**：删掉 `src/metadata.js`、engine 里的 `Metadata` 实例与三处查询、`zfh:sessions` IPC；
   会话标题/工作区/项目全部来自 DOM。
2. **项目信息在捕获时顺手记录**（不再轮询、不再补全）：`getSessionInfo` 从 `li` 最近的
   `section[data-project-id]` 取 `projectId` 与 `data-project-name`；队列条目新增 `projectId`。
3. **发送时按 projectId 定位项目**：`expandProject(key)` 先按 `section[data-project-id]` 精确匹配，
   其次按项目名，最后兜底展开所有收起的；配合 `data-state=open/closed` 判断是否需要点开。
4. **上屏前检查顺序修正**（按用户要求）：切工作区 → 展开项目 → 切会话 → 校验 sid →
   **读 chat-loading（正在跑就跳过，留在队列）** → **模型菜单核验（此时菜单属于目标会话）** →
   检查草稿 → 注入 → 再校验 sid → 回车 → 校验已清空。
5. working 计数改为 sid 去重集合：侧栏 spinner ∪ 当前会话 chat-loading ∪ 回放时观察到的"正在跑"（5s 内）。
6. 测试：单元 54，DOM 45（新增项目 id/标题解析、按 projectId 展开）。

## 轮次 18：设置面板文案与布局（2026-11-22 18:05，v0.5.5）

1. 输入框不再被「浏览…」按钮挤成两行（按钮 nowrap + 行内 30px 高）；原生滚动条换成覆盖式（不占宽，滚动时变亮）。
2. 去掉「输出延后条件」「防打扰」「模型恢复核验」三个组标题；文案按用户给定改写：
   「允许同时进行的会话数：」「防打扰：」「模型可用性检查周期：」「模型可用性检测：」。
3. **`fixedModelId` 语义扩展为候选列表**（半角逗号分隔，如 `GLM-5.3-Flash, GLM-4.6`）：
   `_modelCandidates()` 解析；菜单核验时"任一候选在列且未禁用"即为可用；状态名取第一个候选。
   保存时统一成 `, ` 分隔，空项忽略，全空回退默认。
4. 测试：单元 54（新增候选解析），DOM 43。

## 轮次 17：防打扰闸门 + 红点自动「继续」+ 模型菜单核验（2026-11-22 16:10，v0.5.3）

1. **防打扰闸门**：新增配置 `idleGuardSeconds`（默认 5，0–60，设置面板可调）。判定用 Electron 的
   `powerMonitor.getSystemIdleTime()`——**系统级键鼠空闲秒数**，在别的软件里操作也算。空闲不足 N 秒时：
   不自动发消息、不弹模型菜单、不切会话。只在"有积压"时才记 `state/idle-suppressed`（每分钟最多一条）。
2. **模型核验变成发消息的前置动作**（v0.5.4 调整节奏）：
   - 记录为「可用」：每批发送前核验，**冷却固定 60s**（一分钟内连发只核验第一次）；
   - 记录为「不可用」：每 `modelRecoverCheckSeconds`（默认 60，设置面板可调）核验一次等恢复；
   - 核验 = 点开模型菜单 → 读 items/hints → Esc 关闭；不可用 → `modelState=None` → 灯条黄「无可用模型」且不发送；
   - 菜单结论**优先于每秒的 DOM 探针**（探针不再覆盖它），直到下一次菜单核验。
3. **红点 → 队列最前插入「继续」**：`sessionStatesSrc` 增加 `key`（项目路径）；引擎按 `data-error-indicator` 检红点，
   同 session 已有 pending「继续」则跳过；红点消失才复位"已处理"标记；**每 session 5 分钟内最多 3 条**。
   `queue.addFront()` 插到全局队首（中断任务优先于普通待发）。
4. 设置窗口加「防打扰」字段，窗口高度 640 → 700。
5. 测试：单元 51（新增配置钳制、闸门、红点去重/优先级），DOM 43。

## 轮次 16：工作区守护 + 项目收起（2026-11-22 13:40，v0.5.2）

1. **实测侧栏结构**：项目头是 `button[data-testid="virtual-project-toggle"][aria-expanded]`（文本=项目显示名），会话是 `li[data-testid="task-item-<sid>"][data-task-item-key="<路径>:<sid>"]`；**项目收起时该项目的会话 li 直接从 DOM 移除**（实测折叠后 1 → 0 个 li），所以"找不到会话"必须先展开项目。
2. 注入层新增：`currentProjectName()`（composer 工作区 chip）、`workspaceNameOf(path)`（路径末段）、`expandProject(name)`（按名展开；名字对不上则展开所有收起的）；`getSessionInfo` 增加 `workspaceName`。
3. 队列条目新增 `workspaceName`（截获时记录、老条目用路径末段补全），项目收起后仍能找回会话。
4. player：`_ensureSessionVisible()` 在切会话前先展开项目；**提交前最后一道闸**——重新读当前会话 id，与目标不符直接 `session-mismatch` 中止。
5. 顺手修了一个模板字符串转义坑：`src/inject/bootstrap.js` 整体是 template literal，里面 `\s` 会被吃成 `s`、`[\\/]` 会变成 `[\/]`，新代码改用 `normText()` / 四重反斜杠。
6. 测试：单元 47（新增 4 条 `_ensureSessionVisible`，含"永不出现则返回 false"），DOM 43（新增 3 条：按名展开、名字对不上时兜底展开、无 chip 时用路径末段）。
7. 实测：live 页面折叠 `hide-blog` → `expandProject('hide-blog')` 展开成功；`workspaceNameOf('D:\Coding\hide-blog')='hide-blog'`、`currentProjectName()='k40s-control'`。

## 轮次 15：GitHub Actions 自动打包发布（2026-11-21 21:40，v0.5.0）

1. 新增 `.github/workflows/release.yml`：`push` 标签 `v*` 触发，matrix 并行构建 Windows x64 / arm64，跑 `npm run test:unit` 后 `electron-builder --win --<arch>`，artifact 汇总后由 `softprops/action-gh-release` 创建/更新 Release（首页右侧 Releases 可见）。
2. electron-builder 配置加 `artifactName`：`zcode-helper-Setup-<ver>-<arch>.exe` / `zcode-helper-Portable-<ver>-<arch>.exe`，避免两个架构同名互相覆盖（原先默认名不含 arch）。
3. 本机验证两个架构都打包通过：x64 直接构建成功；arm64 因本机下载 electron 压缩包超时，改为手动下载官方 `electron-v45.3.4-win32-arm64.zip` 并用 `-c.electronDist=` 指向本地解压目录后构建成功（CI 上由 runner 正常下载，不需要这一步）。
4. 手动触发（workflow_dispatch）只构建不发布；tag 与 package.json 版本不一致时给 warning。

## 轮次 14：改名 zcode-helper（2026-11-21 21:05，v0.5.0）

1. 去掉 `-freeplan-`：产品名/包名/窗口标题/托盘 tooltip/灯条 tooltip/文档标题统一为 **zcode-helper**，appId 改 `com.zcode.helper`；run.bat（GBK 编码）同步替换 6 处。
2. **userData 迁移**：`%APPDATA%\zcode-freeplan-helper\` → `%APPDATA%\zcode-helper\`，首次启动自动复制 `config.json` / `queue.jsonl` / `logs\`（目标已存在不覆盖）。实测：4 条队列与配置完整迁移。
3. 版本 0.4.9 → 0.5.0（注入脚本版本同步，灯条 tooltip 随之更新）；README 头图重做，文案改为"模型不可用或并发已满时排队"，不再绑定免费套餐。
4. 内部前缀 `zfh`（注入全局 / CDP binding / localStorage 键 / 日志文件名）保持不变——它是稳定的内部标识，不影响对外品牌。

## 轮次 13：GitHub 版 README + 配图（2026-11-21 20:40，v0.4.9）

1. README 重写为 GitHub 风格：居中头图 + 徽章 + 一句话定位 → 为什么需要它 / 特性 / 界面截图 / 工作原理（mermaid）/ 快速开始 / 使用 / FAQ / 架构 / 测试 / 打包 / 已知限制 / Roadmap / 贡献 / 许可 / English 摘要。
2. 新增配图（`docs/images/`）：`hero.png`（1280×340 合成头图）、`lightbar.png`（真实页面渲染的灯条）、`panel.png`、`queue.png`（用 `scripts/readme-shots.js` + 假数据在 Electron 里渲染后截图，2x）。
3. 仓库整理：新增 `LICENSE`（MIT）、`.gitignore`（node_modules/dist/logs）、package.json 补 description/keywords/license/author；删除临时脚本 `scripts/tmp-cdp-verify.js`。
4. README 里的 `git clone` 地址仍是 `<you>` 占位，发布前替换成实际仓库地址。

# DEVLOG — 开发测试现场记录（恢复锚点）

> 用途：本机实测期间 helper/ZCode 可能重启（会话持久化 + restoreSession=true 会自动恢复本会话）。
> 本文件是恢复后的"我读到哪了"锚点。测试轮次结束后再归档精简。

## 轮次 12：滤网模型 + 灯条（2026-11-21 15:00，v0.4.0）

按用户第 37~39 轮定义重构：**入永远开，唯一可定义的是「出」**。

1. **滤网（页面侧同步判定）**：Enter / 发送点击时读 `ZFH.capacity`（helper 每 5s 推送）：
   助手暂停 → 放行；模型不可用 → 暂存(model)；`working ≥ N` 且本会话空闲 → 暂存(quota)；其余放行。
   **放行不 preventDefault**（零延迟）；只有暂存才拦截。当前会话工作中 → 放行（ZCode 自己排队）。
2. **两个开关**：`暂停助手`（= 暂停记录，滤网放行）与 `暂停输出`（= 队列不排空）。删除 recording/replayOn/
   自动回放/时间窗/录制默认值等一整套旧状态；`_drainTick` 在队列变化、探针、开关变化时触发排空。
3. **注入标记**：排空/回放发送前 `ZFH.injectingUntil = now+1.5s`，页面把紧接着的 Enter 放行一次，
   于是「边录边放」成立（用户新消息仍会被滤网判定）。
4. **灯条**：替换原来的圆点徽标，ZCode 对话区右侧常显小面板（不再有动画）：输出状态、`工作中 N / N`、
   待发（含草稿）、模型、等待原因、最近事件；点击切换 helper 面板。`setLightBar(payload)` 一个入口，
   payload 同时把 capacity 回写给页面滤网。
5. **面板 = 5 个按钮**（无 tooltip）：暂停助手 / 暂停输出 / 查看队列(n) / 设置 / 重启受控 ZCode（未受控时）。
   实时信息不进面板、不进托盘菜单；托盘菜单只剩操作。
6. **设置**：删除自动回放段落，新增「输出延后条件 working ≥ N」（默认 2，1~20）。
7. 队列条目新增 `holdReason`（model/quota），队列窗口显示「等待名额 / 等待模型」。
8. 测试：单测 43（重写状态机用例）、DOM 29（灯条 + 滤网用例）、冒烟 12，全绿。
9. **15:30 细化**（v0.4.1，按用户反馈）：
   - 灯条去掉模型行（少一行高度）；"工作中"→"工作进程"、"待发"→"队列消息"；
   - 灯色重定义：绿=输出中，黄=等待名额（有积压且名额满/模型不可用），**红=输出已暂停**（原来是黄），灰=助手已暂停；
     不再有"未受控"状态（未受控时灯条根本不存在）。
   - 面板："继续助手"→"启动助手"；删掉「暂停输出」大按钮，改为 **CDP 徽标左侧的小 switch**（debug 功能，标签「暂停」，可在设置里隐藏）；
     按钮区变为 暂停助手 / 设置 / 查看队列(n) / 重启受控 ZCode（受控时置灰，不再隐藏）。
10. **灯条拖动 + 八向停靠**（v0.4.6）：pointer 拖动，松手时**角优先**（四角 ≤100px → 吸角），否则最近的边（≤100px），都超出则**留在原地**；位置存 localStorage（`zfh-lightbar-pos`，`{mode,anchor,x,y}`），刷新/重启还原；灯条宽度 172 → **144**（`box-sizing:border-box`）。
11. **并发闸门与灯条计数不一致**（v0.4.8 后修复）：闸门原本用"侧栏有点就算工作中 + 点会话消点"，会把带未读点的会话反复算成 working（还会每秒切一次用户窗口），而灯条用"侧栏 spinner + 当前会话 chat-loading"，于是出现"灯条 1/2 但队列不动"。现在两者同源（不再点会话），探针周期 5s → **1s**，等待轮询 10s → 2s。
12. **resize 后灯条消失修复**（v0.4.6）；v0.4.7 起 resize 还会按**锚点重算**（角/边吸附在窗口放大时继续贴边，free 只夹紧）：旧版本存的 `{side,top}` 格式让 resize 夹紧整段跳过，灯条停在屏幕外。现在 resize 按**当前 rect** 夹回可视区、`setLightBar` 每轮再兜底、旧格式位置丢弃并清 storage、`clampBar` 处理 offsetWidth=0。

## 轮次 11：模型陈旧态（恢复可用但会话残留"不可用"）2026-11-21 08:53，v0.3.0

实测（快照 `logs/dom/stale-model-*.json`、`stale-model-repair-2026-11-21T00-51-11-775Z.json`）：
- 陈旧态三件套：`[data-testid="chat-model-select-trigger"]` 的 `data-model-current-value=""` + 可见文本「选择模型」
  + `[data-testid="chat-error-banner"][data-error-code="ZCODE_RUNTIME_MODEL_UNAVAILABLE"]`（无关闭按钮）。
- **手动修复路径已实测**：点触发器 → 菜单 `[role="menu"]` 里点
  `[data-testid="chat-model-select-item-custom:account%3Abigmodel-start-plan:GLM-5.3-Flash"]`（menuitemradio）
  → `data-model-current-value` 回填、横幅消失；**但可见文本仍残留「选择模型」**（app 没刷新 label）。
- 因此 `probeModel` 改为 **value 优先**：`data-model-current-value` 非空 → 可用；为空才看文本/错误横幅。
  否则"已选中但文本陈旧"会被误判为不可用（这正是本次 bug）。
- 测试 48 单测 + 28 DOM（新增：陈旧文本+已回填 value→可用；value 空+横幅→不可用）。
- 待做：见 [`TODO.md`](./TODO.md) —— 反向样本需**周一 09:00 免费期结束后**采集（`scripts/capture-model-menu.js`）；
  功能侧待做：可用性二次确认（点开菜单）+ 陈旧态自动修复（打开菜单→选模型）。

## 轮次 10：录制记录「项目 + 对话」（2026-11-21 07:20，v0.2.9）

1. 实测：侧栏会话项 `li[data-testid="task-item-<sid>"]` 带 `data-task-item-key="<workspace>:<sid>"` →
   录制时即可知道会话所属工作区，不必依赖 engine 缓存。
2. `bootstrap.snapshot().session` 新增 `workspacePath`（并暴露 `ZFH.workspaceOfSession` 便于测试）；
   interceptor 入队时优先用页面报来的工作区，engine 缓存兜底。
3. 队列窗口每条显示 `项目：<basename>`（tooltip 全路径）与 `对话：<标题>`；老条目缺 workspacePath 时
   由 `engine.fillQueueWorkspaces()` 用 db 只读副本补全（`queueView()` 时触发并持久化）。
4. 验证：07:17:51 用户手动提交跨 workspace 消息成功——日志 `workspace-resolved(D:\Coding\Bighub)` →
   `session-switch matchedBy=exact-sid verified=true` → `sent`；随后 07:18:47 用户「清空已发送」把队列清空（非数据丢失）。
5. 测试 48 单测 + 25 DOM（新增 workspace 解析用例）。

## 轮次 9：回放发错会话事故 + 修复（2026-11-21 06:50）

1. **事故**：用户点「提交」一条 failed 消息，目标会话在**别的 workspace**（`D:\Coding\Bighub`），侧栏只列当前
   workspace 的会话 → `locateSession` 失败 → 旧逻辑"降级当前会话"把「继续」发进了用户正开着的另一个会话。
2. 修复（`src/player.js`）：
   - **定位失败即中止**：`session-not-found` 错误，条目回到 failed，绝不发进当前会话；
   - **两次点击都验证不通过也中止**（只有"页面完全读不到会话身份"时才信任定位）；
   - **工作区补全**：条目没记 `workspacePath` 时，用 db 只读副本的 `session.directory` 补全（`resolveSessionWorkspace`），
     先切工作区（`_ensureWorkspace`）再按 sid 定位 → 跨 workspace 也能送达。
3. 顺带修：`submitQueueItem` 此前的 `not-pending` 守卫让 failed 条目无法手动重发（「提交」按钮无反应）。
4. 测试 47（新增：找不到会话必须中止且不注入/不点击；workspace 补全路径）。v0.2.8。

## 轮次 8：消息分「提交/草稿」两类（2026-11-20 13:25，v0.2.8）

1. 新数据模型：队列条目加 `type`：`submit`（提交，自动回放只跑这类）| `draft`（草稿，永不自动发送）。
   旧条目按 `source==='draft'?draft:submit` 兼容；`counts()` 单列 `draft`。
2. 回放遇到"输入框里有别的草稿"（`decideComposerAction` 返回 `move-draft`）：
   **把草稿存进队列末尾（type=draft）→ 清空输入框 → 继续提交本条**。不还原回对话框（提交后工程可能变了，留框里会误判状态）。
3. 队列窗口：每条显示类型标签（提交/草稿）；草稿类按钮「上屏」（切到所属会话 → 清空 → 注入草稿文本，成功后移出队列），
   提交类按钮「提交」（单条手动发送，期间临时关闭录制，不受自动回放 FIFO 约束）。筛选新增「草稿」。
4. 引擎新增 `submitQueueItem(id)` / `screenDraftItem(id)`；`setReplay`/自动回放的空队列判断改用 `pendingSubmits()`。
5. 测试：单测 43（新增类型过滤、手动提交、草稿上屏）、DOM 24、冒烟 12，全绿。

## 轮次 7：去掉快照兜底 + 回放草稿冲突（2026-11-20 12:55，v0.2.8）

1. **删除周期快照（snapshotter）**：用户确认 ZCode 自己会按会话保留输入框草稿（实测 localStorage：
   `zcode-v4-composer-project-drafts:v1:[…]` / `zcode-pending-task-draft:v1:[…]` / `zcode-composer-workspace-scope:v1:[…]`），
   切走再回来、甚至没进 sidebar 的新会话也在。helper 不再做 `draft-snapshot` 兜底，只认 Enter/发送按钮截获。
   删除 `src/snapshotter.js`、`config.snapshotIntervalMs`、设置窗口对应字段；日志不再有 `draft-snapshot` 事件。
2. **同时修掉一个 bug**：反馈弹窗（`[role="dialog"]` 里的 textarea 自动聚焦）曾被 `findComposer()` 当成聊天输入框，
   弹窗模板被快照入队。现在 `findComposer` 只认 `.chat-composer-region` 里的编辑器，回退路径排除弹窗控件；
   发送按钮也限定在输入区内；`composerRectSrc/composerFocusSrc` 统一走注入侧 `findComposer`。新增 5 条 DOM 回归用例。
3. **回放遇到输入框已有内容**（`decideComposerAction`）：
   - 空 → 清空后注入；
   - 内容正好是本条消息 → 直接回车提交（不重复输入）；
   - 有**别的草稿** → 跳过本条并标 failed（`composer-has-draft`），**绝不覆盖** ZCode 的草稿；
     失败清理（`_dropLeftover`）也只在"本轮确实注入过"时才执行。删除 `_rescueComposer`（把草稿当消息入队是错的）。
4. **冒烟测试改为完全隔离**：临时 userData + 临时日志目录，且 `_startupConnect` 在 smoke 模式下不探测/不接管现有 ZCode
   （之前会连上真实页面）。可重复跑，`12/12` 稳定。
5. 测试现状：单测 38、DOM 用例 24、冒烟 12，全绿。

## 轮次 6：测试体系 + 若干交互修正（2026-11-20 08:15，v0.2.7）

1. **测试体系**：`npm test` = `test:unit`（node --test，35 项：config/queue/state/player/interceptor/dom-adapter 表达式）+ `test:dom`（Electron 渲染进程，19 项：用真实采集的 ZCode 页面片段跑适配层与注入脚本）。
   - 夹具 `test/fixtures/`（composer 无模型/有模型、会话列表四态、指令弹层片段、chat-loading），由 `scripts/build-fixtures.js` 从 `logs/dom/*.json` 生成；ZCode 升级后的重采集流程见 README「测试」。
   - 为可测试性：`bootstrap` 暴露 `ZFH.findComposer / ZFH.suggestionsOpen`；`player` 注入 `timing`（startDelay/waitConcurrency/blocked）。
2. **ZCode 不再随 helper 退出**：`supervisor.spawnZCode` 改 `detached: true` + `unref()`（实测：强杀 helper 后 ZCode 与 9222 端口存活）。
3. 托盘左键 = 切换面板显示/隐藏；托盘移除「导出诊断包」与「自动回放设置…」。
4. 导出诊断包入口移到设置窗口；导出后打开所在文件夹 + 弹窗告知路径；诊断包新增 `logFile`。
5. 面板「开始录制」左侧改为红点（`.rec-dot`）。
6. 版本号统一：package.json 与 `helperVersion` 均为 0.2.7（有单测守着一致性）。

## 轮次 5：功能重定义（2026-11-20 07:37，v0.2.6 已实现）

1. **录制** = 截获消息入队（`/` 指令也算消息内容，只是 Enter 行为细分：弹层开着时放行选指令，见轮次 4/5）。录制是手动开关。
2. **模型状态** `modelState`：`None` 或模型名（探针从 `data-model-current-value` 取，如 `GLM-5.3-Flash`）。
3. **连上后的录制默认值**：`_applyRecordingDefault` —— 首次探到结论时，有模型 → 录制默认关；无模型 → 默认开；用户手动切过（`_userTouchedRecording`）就不再自动改。
4. **回放是状态**（不是一次性动作）：`engine.setReplay(on)`，面板/托盘「开始回放 ↔ 停止回放」。
   - 调度：FIFO 扫描 pending，`working >= 2` 就等；目标会话自己在跑就跳过它、先发后面其它会话的（即允许"插队"）；队列跑空自动结束。
   - 每条发送后 `_confirmStarted` 确认会话真的进入 working，避免同会话下一条被误放行。
5. **回放覆盖录制**：开回放时记住 `recording` 并强制关；回放结束（队列空/手动停）恢复原值。录制关 → 回放关后仍是关。
6. **自动回放**（替代原 23:05 单点）：**总开关** `autoReplayEnabled`（面板/托盘「自动回放：开/关」）+ 两个"且"条件，
   总开关关 → 条件满足也不回放；开 → 勾选的条件全部满足时把回放状态打开（触发一次后 `_autoArmed=false`，条件不再满足才重新武装）：
   - `autoReplayModel` + `autoReplayModelId`（默认 GLM-5.3-Flash）
   - `autoReplayTime` + `autoReplayFrom`/`autoReplayTo`（默认 23:05~08:55，跨午夜）
   - 条件都不勾 = 条件恒真（等价只看总开关）。
7. 实现：`engine` 的 `setReplay/_finishReplay/_autoReplayTick/_modelMatches/_inTimeWindow/_applyRecordingDefault`；
   `player.replay` 改为调度循环（移除 `_runGroups/_gateForItem/_failAll`）；设置窗口新增自动回放双条件区。
8. 测试：引擎状态机 12/12（模型状态、录制默认值、手动优先、回放覆盖/恢复、时间窗跨午夜、自动回放触发与不重触发）；
   调度桩测 1/1（顺序 a1→b1→a2→b2，证明同会话跳过与 2 并发上限）；`--smoke` 12/12。

## 轮次 4：会话工作状态判定（2026-11-20 06:30，待实现）

用于回放队列的并发闸门（方案 A：发送前 `working >= 2` 就等）与同会话串行。**实测信号与陷阱：**

1. **sidebar 不可信**：`li[data-testid^="task-item-"]`（sid = testid 去掉前缀；`data-task-item-key` 前半段是工作区路径）的状态位
   - 工作中：`span.animate-spin > svg.lucide-loader-circle`
   - 未读蓝点：`span[data-unread-indicator="true"].size-[7px].bg-icon-blue`
   - 出错红点：`span[data-error-indicator="true"].h-1.5.w-1.5.bg-destructive`
   - 空闲：空 `span`
   - **陷阱（2026-11-20 06:27 实证，见 `logs/dom/stale-dot-evidence-20261120-0627.json`）**：当前正在跑的会话，侧栏只显示未读蓝点、**没有** animate-spin；切过去才暴露它还在工作（蓝点自动变回转圈）。CSS 里不存在 icon-green / success-indicator，"绿点"实际是蓝点。
2. **对话区可信但只覆盖当前会话**：`[data-zcode-chat-loading-slot]` / `[data-testid="chat-loading"][role="status"][aria-label="加载中..."]` 存在 = 工作中；`.tabular-nums` 计时器文本递增可确认活着。与 icon/文案无关，抗美术调整。
3. **消点协议（用户命名）**：侧栏出现 蓝点/红点/绿点 = "疑似结束"，必须切到该会话读 chat-loading 定论；切过去会消费掉未读点，若仍在工作侧栏会变成 animate-spin。**先消点，再数 working**；只有"两个圈圈同时存在"才能直接判定两个会话在工作中。
4. 实现要点：**只对「有点」的会话切换过去消点**——没点的会话不切（无点即视为空闲），当前打开的会话也不切（直接读 chat-loading）。因此无点时消点成本为零，闸门检查可以在**每条发送前**都跑一次全量判定。消点会消费未读点并可能让侧栏变回转圈，属预期副作用。
5. 顺带：切会话可改为精确匹配 `li[data-testid="task-item-<sid>"]`（比标题模糊匹配可靠），标题匹配降为兜底。

**实现（2026-11-20 07:05，v0.2.4 代码已改完）**：`src/dom-adapter.js` 新增 `sessionStatesSrc / chatLoadingSrc / sessionItemRectSrc`；`src/player.js` 新增
`_clickSessionItem / _currentSessionWorking / _sessionWorking / _workingSessions / _gateForItem / _confirmStarted`。
每条发送前跑 `_gateForItem`：`working>=2` 或目标会话自己在跑 → 等待（同会话等 5s、并发等 10s，上限 30min）；
发送成功后 `_confirmStarted` 确认该会话真的进入 working（20s 内），避免同会话下一条被误放行。切会话优先按 sid 精确点击。
单测：桩 CDP 6/6（空闲放行、双会话等待、同会话等待、消点仍在跑计为 working、消点已结束不计、当前会话直接计入）；
真实页面 dry-run：无点时代价 7ms、零点击。

## 轮次 3：交互改版（2026-11-19 15:00，仍为 v0.2.1）

用户新交互定稿，**旧的"探针/时间表自动翻模式 + 到点自动回放"已下线**（代码保留 scheduler.js 但引擎不再使用）：

1. **录制 = 纯手动开关**：面板/托盘「开始录制 ↔ 停止录制」，按一下开、再按一下关。开=注入侧 recording（回车被截获入队），关=注入侧 paused（回车正常发送）。默认开。
2. **回放 = 触发式**：按「回放全部」才跑；逐条按条目记录的会话自动切过去 → 清空 composer → 注入 → 真实回车。单条失败只标 failed，**继续发下一条**（不再中止整轮）。
3. **夜间自动回放 = 独立开关**：到 `nightReplayAt`（默认 23:05）先探针检测模型可用性，`probeSignal === 'available'` 即自动回放队列全部消息；每天只触发一次，日志 `state/night-arm`、`state/night-fire`。开关即 config `autoReplay`（设置窗口里也能改，入口在面板/托盘）。
4. 实现细节：`engine.recording` 取代 `recPaused`/`modeOverride`；`_injectedMode()` 只看 connState/replaying/recording；`_nightTick()` 挂在探针 tick 上（探针每轮回来都判一次）。
5. 已用临时 userData 做过 10/10 单测（开关翻转、注入模式、到点武装、模型可用即触发、状态字段齐全），Node 级 `Engine.start()/stop()` 通过。

## 轮次 2：本机实测（2026-11-19 08:35 起，v0.2.0）

### 实测确认已生效
- 受控重启按钮：杀旧 ZCode → 带端口拉起 → CDP CONNECTED ✓
- 模型探针：`probe available "GLM-5.3-Flash最高"` → 自动翻 PLAYING ✓（本机当前 plan 可用，白天也生效）
- 锁定录制：`mode-override RECORDING` → 拦截生效，draft 捕获正常（"g?"→"现在是本机测试"）✓
- 会话标题捕获：`sessionTitle: "zcode 录制回放浮窗助手程序"`（titleSource heading）✓
- 队列/去重/晋升（panel-manual flush）✓
- domDebug 证据自动落日志 ✓

### 实测暴露 + 已定位根因（修复已写入代码，v0.2.1）
1. **composer 是 Lexical**（`data-lexical-editor="true"`, `data-testid="v4-composer-input"`）：
   `execCommand('delete')` 清空无效 → 回放报 `composer pre-clear failed (not emptied)`。
   **修复**：player 改用 CDP 真实按键 Ctrl+A → Backspace（×3 次尝试 + execCommand 兜底）——真实输入管道 Lexical 必响应。
2. **会话标题匹配命中聊天正文**（locate 返回 x:711 = 正文元素而非侧栏项；本会话正文恰好包含会话标题字符串）：
   **修复**：locateSession 限定候选在会话主容器 `[data-session-id]` **之外**，且 `[class*="task-item" i]` 优先（实测真实类名）；返回值带过程计数（dbg）供失配诊断。
3. **会话容器带真实 `data-session-id="sess_xxx"`**（与 db.sqlite session.id 同格式）：
   **修复**：getSessionInfo 增加该候选（取可见面积最大者）→ 录制即可捕获真实 sessionId；docTitle 恒为 "ZCode" 已跳过。
4. **08:36 locate 失败当时侧栏项可见且现在同参复现匹配成功** —— 瞬态原因不可复现；新方案加了**切换后验证（容器 sid / 标题比对）+ 重试一次 + 失败自动 dump**，瞬态失败会被兜住并留下证据。
5. **注入脚本幂等守卫会阻止升级**：`if (window.__zfh) return` 导致 helper 重启也无法替换活页面里的旧闭包。
   **修复（v0.2.1）**：版本比较热升级——旧实例 mode 冻结为 uncontrolled（旧监听器永久失活），新实例整体重建。helper 重连即完成升级，无需页面导航。

### 重启顺序（已按此执行）
1. `taskkill /IM electron.exe /F`（杀 helper；**ZCode 是独立进程预期存活**——08:26 已验证过一次；即使死亡，下一步自动重拉）
2. `npx electron . --smoke`（需单实例锁，故必须先停常驻 helper；12 项全过）
3. `run.bat`（helper 重启：ZCode 活 → adopt 接管；死 → autoLaunch 重拉，restoreSession=true 恢复本会话）
4. CDP 验证 `window.__zfh.version === "0.2.1"` + `snapshot().session.sessionId === "sess_..."`（热升级是否落地）

### 状态恢复事实（已验证）
- ZCode 会话持久：08:35 受控重启杀过一次 ZCode，本会话（sess_29f20b61）自动恢复，对话无损继续。
- helper 被杀不影响队列/日志（队列在 %APPDATA%，日志在仓库 logs/）。
- helper 启动三路分支：已有 CDP → 接管；无 CDP 在跑 → 未受控（面板按钮）；没在跑 → 受控拉起。

### 重测清单（v0.2.1 重启后）
1. 锁定录制 → 输入 → Enter → 检查截获入队 + composer 清空（修复 #3）
2. 锁定播放（或恢复自动）→ 重发队列里的 `q_20261119_083645_1ce6`（"现在是本机测试"，failed 状态）→ 检查：清空 → 注入 → 提交 → sent（修复 #4/#2）
3. 多会话回放：在另一个会话里录制一条 → 回放 → 观察日志 `session-switch` + `verified:true`（修复 #5）
4. 恢复自动后：探针应保持 PLAYING（模型可用）

### 待办/注意
- 队列中遗留 1 条 failed 条目可复用。
- `scripts/tmp-cdp-debug*.js` 是本轮只读调试工具（连 9222 CDP），测试期保留，归档时删。
- helper 单实例锁：跑 smoke 前必须停常驻 helper。
