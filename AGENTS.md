# AGENTS.md — zcode-helper

本项目是一个伴随 ZCode 桌面端运行的 helper 工具:无 plan 时录制用户输入,有 plan 时回放。

## 必读

任何会话开始工作前,先读 [`HANDOFF.md`](./HANDOFF.md)(前期探索的完整交接:已验证机制、已失败路径、关键实测)与 [`DESIGN.md`](./DESIGN.md)(设计定稿:架构、状态机、模块、数据模型、流程、UI、里程碑)。HANDOFF 回答"为什么这么设计",DESIGN 回答"具体怎么做";两者冲突时以 DESIGN 为准并回头修订 HANDOFF 相应事实。

## 硬规则

1. **不要重试 headless CLI 的模型预设**——7 种手段已实测全部失败(见 HANDOFF.md 第 4 节),根因是模型可用性与套餐硬绑定,属于产品行为。
2. **helper 无降级模式**:录制/回放/圆点/接管全部依赖 CDP,CDP 不可用即为"未受控"——面板提示并提供【重启受控 ZCode】按钮,由用户确认任务完结后手动触发;不要给 helper 设计"无 CDP 也能凑合工作"的路径。`db.sqlite` 只读副本仅用于 session↔workspace 等元数据补充(需要写库时先关闭 ZCode 桌面端)。
3. 与 ZCode 桌面端交互一律走 CDP(`--remote-debugging-port=9222 --remote-allow-origins=*` 启动),DOM 选择器集中放一个适配层,应对 app 升级漂移。
4. **Enter/提交拦截只在录制态生效**,播放态完全放行;模式切换的判断在 helper 侧,不依赖 app 状态。
5. 免费 plan 模型按固定名写死(GLM-5.3-Flash),预留配置项给未来新 plan。
6. 用户环境:白天 Start Plan key 失效、无任何可用模型;23:00 后生效。涉及"验证模型可用"的测试安排在该时段或用 VM。
7. **日志纪律**:所有状态翻转、截获、暂存快照、回放必须落结构化 JSONL 且单条自足可读——它是 VM 无 plan 测试与 host 开发之间唯一的复现桥梁(规范见 HANDOFF.md 第 6.5 节)。
8. **纯 GUI**:ZCode 官方交付形态是桌面 GUI(未提供面向用户的 TUI/终端界面),helper 也是 GUI——独立 Electron 应用 + 小窗口(状态与录制/回放/队列查看按钮)。所有 ZCode 交互经 CDP 驱动其 GUI;helper 自身不借用 ZCode 的 Electron runtime 运行。

## 待验证事项

1. 在 VM 上做 DOM 摸底(composer 结构 + 会话列表结构)——回放时"切到目标会话"依赖会话列表 DOM,是已知最脆弱的环节(见 HANDOFF.md 第 5b 节)。

(备选回放通道 bot control 已于 2026-11-19 评估并关闭:webhook 为出站通知、方向与回放相反,结论见 HANDOFF.md 第 5c 节;除非官方未来开放入站接口,不要再提。)
