<p align="center">
  <img src="docs/images/hero.png" alt="ZCode Helper" width="100%" />
</p>

<h1 align="center">ZCode Helper</h1>

<p align="center"><b>给 ZCode 桌面端加一个队列：发不出去的消息先存着，能发的时候自动送进正确的会话。</b></p>

<p align="center">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white" />
  <img alt="electron" src="https://img.shields.io/badge/Electron-45-47848F?logo=electron" />
  <img alt="node" src="https://img.shields.io/badge/Node.js-%E2%89%A5%2022-339933?logo=node.js" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue" />
</p>

> 非官方工具，与 ZCode 官方无关。它只是替你点按钮、按回车，不修改 ZCode 的任何文件。

## 它能做什么

- **并发满了先排队**：同时工作的会话达到你设定的上限时，新消息先入队；有空位再按顺序自动发出。
- **没模型时先存着**：模型不可用（没套餐 / 额度用完）时只入队不发送，恢复后自动继续。
- **出错自动「继续」**：会话因异常中断（侧栏出现红点）时，自动在队首补一条「继续」。同一会话 5 分钟内最多 3 条。

## 安装

**下载安装包（推荐）**

到 [Releases](https://github.com/<you>/zcode-helper/releases) 下载：

| 文件 | 说明 |
|---|---|
| `ZCode-Helper-Setup-<版本>-<x64\|arm64>.exe` | 安装版 |
| `ZCode-Helper-Portable-<版本>-<x64\|arm64>.exe` | 免安装便携版 |

exe 没有签名，首次运行 Windows 会弹 SmartScreen：点「更多信息 → 仍要运行」。

**从源码运行**

```bat
git clone https://github.com/<you>/zcode-helper.git
cd zcode-helper
npm install
npm start
```

要求：Windows 10/11、Node.js ≥ 22、已安装并登录 ZCode；支持 **ZCode 3.18.x ~ 3.19.x**。
也可以双击仓库里的 `run.bat`（首次会自动 `npm install`）。

## 使用

### 灯条

嵌入在 ZCode 页面右侧，显示实时状态。拖动可换位置，松手自动吸附到最近的角或边，下次启动保持原位。

| 灯色 | 文字 | 含义 |
|---|---|---|
| 🟢 | 助手工作中 | 已连接，无积压，消息正常放行 |
| 🟡 | 限额缓冲 | 有积压但暂时发不出去（并发满 / 模型不可用） |
| 🔴 | 消息阻断 | 手动开启了「消息阻断」，只入队不发送 |
| ⚪ | 助手已暂停 | 消息直接进 ZCode，等于暂停记录 |

下面三行分别是：工作进程数、队列长度、当前会话里下一条要发的内容。单击灯条可以开关主面板。

<p align="center"><img src="docs/images/lightbar.png" alt="灯条" width="380" /></p>

### 主面板

<p align="center"><img src="docs/images/panel.png" alt="主面板" width="380" /></p>

- **暂停 ZCode 助手**：暂停记录，消息不再入队（同时失去并发保护）；
- **设置**：见下；
- **查看队列(n)**：n 只统计「待发送 + 草稿」；
- **重启受控 ZCode**：ZCode 没带调试端口启动时用来接管；会话内容不会丢；
- 右上角 **消息阻断**：调试用，强制只入队不发送。

### 队列

<p align="center"><img src="docs/images/queue.png" alt="队列窗口" width="720" /></p>

每条消息都带**项目**和**对话**，分两类：

- **提交**：可手动「提交」，或等自动排空；自动「继续」也在这里，插在队首；
- **草稿**：发送时从输入框里救出来的内容，点「上屏」放回输入框，不会自动发送。

**新建会话的第一条消息也能排队**：这种会话在侧栏还没有条目，排队时记下输入框上方选的项目；回放时去该项目点「新建任务」现开一个会话再发。项目显示为「选择项目」时无法自动定位，会明确失败而不是乱发。

**附件**：图片 / 视频 / 文件跟着消息一起存。来自磁盘的只记绝对路径，回放时塞回同一个路径，模型看到的和原来一致；粘贴的图片没有原文件，存成内联数据。队列里照上屏后的样子显示缩略图。

其他按钮：失败全部重发、清空已发送、导出诊断包。

### 设置

- **ZCode 可执行文件路径**：留空会自动在 LocalAppData / Program Files / Scoop 里找，找不到就点「浏览…」手动选；
- **允许同时进行的会话数**：超过就排队；
- **防打扰**：检测整个系统的键鼠活动，你停手 N 秒后助手才开始自动发送；0 = 关闭；
- **模型列表刷新周期**：模型不可用时，按这个周期点进「模型设置」再返回，让 ZCode 重新拉取列表；0 = 关闭（只在你空闲时执行）；
- **允许助手使用的模型**：只选这些模型，避免误用收费模型。逗号分隔、按顺序、区分大小写，例如 `glm-5.3-flash, GLM-5.3-Flash` 会优先选小写的那个。

## 注意事项

- 只支持 Windows；
- 适配 **ZCode 3.18.x ~ 3.19.x**，ZCode 改版后可能需要更新本工具；
- 完全依赖 ZCode 的界面结构：ZCode 关闭或没带调试端口时，助手会显示「未受控」并提供重启按钮；
- 不上传任何数据，没有遥测。

## 许可

[MIT](LICENSE) © ZCode Helper contributors

---

<details>
<summary><b>English</b></summary>

**ZCode Helper** is an unofficial Windows companion for [ZCode](https://zcode.z.ai). It queues messages that cannot be sent right now — the model is unavailable, or the concurrent-session limit is reached — and delivers them into the right conversation once they can go through. It also re-sends "continue" when a conversation ends with an error.

Tested with ZCode 3.18.x – 3.19.x. MIT licensed; Windows x64 / arm64 builds are on GitHub Releases.

</details>
