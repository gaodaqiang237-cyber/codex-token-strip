# Codex Token Strip

[English](README.en.md) · Windows x64 · MIT · 无第三方运行时包依赖

在官方 Codex 窗口旁显示一条简洁的 Token 状态浮条：**会话消耗、全部本地会话消耗、估算 tok/s、缓存命中率**。可以拖到输入框下面，也可以放到窗口内其他位置。

![浮条示意，使用虚构示例数据](docs/preview.png)

这是独立的 Windows 小工具，不是 OpenAI 官方插件。它使用独立浮窗，不修改 Codex 安装文件、不注入客户端，也不需要 API key。无遥测，不上传聊天或用量数据。

## 安装与启动

需要 Windows 10/11 x64、.NET Framework 4.8，以及 **Node.js 22 或更新版本**。当前窗口识别适用于 Microsoft Store 版 Codex；其他安装方式尚未支持。已在 Codex `26.1013.4894.0` 验证，日志格式变化可能需要适配。

1. 安装 [Node.js](https://nodejs.org/)，安装后重新打开终端，确保 `node --version` 可用。
2. 在 [Releases](https://github.com/gaodaqiang237-cyber/codex-token-strip/releases) 下载 Windows x64 ZIP，完整解压。
3. 双击解压目录中的 `app/overlay/TokenStrip.exe`。
4. 切回官方 Codex，拖动浮条调整位置。右键可切换浅色/深色、恢复默认位置或退出。

整个解压目录都需要保留，只有 EXE 无法完成统计。如果 Node.js 安装在自定义位置，可在解压目录运行 `node scripts/launch.cjs`，它会自动保存当前 Node.js 路径。

浮条使用 Windows 自带 .NET Framework 编译，发布的 EXE 未购买代码签名证书。它与 Codex 官方客户端的签名和更新相互独立。

## 从源码运行

```sh
git clone https://github.com/gaodaqiang237-cyber/codex-token-strip.git
cd codex-token-strip
npm test
npm run build
npm start
```

不需要执行 `npm install`；所有 Node.js 模块都来自标准库。Windows 构建脚本直接调用系统 .NET Framework C# 编译器，不需要 Visual Studio、PowerShell 脚本或全局 npm 工具。`npm stop` 退出本项目浮条；后台统计服务停止被访问约 15 分钟后自行退出。

## 数字代表什么

| 指标 | 口径 |
| --- | --- |
| 会话 | 当前识别到的本地聊天累计 API 等价美元消耗，旁边为累计输入 + 输出 Token；缓存输入已包含在输入中 |
| 总计 | 本机可读取的全部会话及归档累计消耗，包含当前会话；不是本周、不是账号云端总账 |
| ≈ tok/s | 最近完成请求的输出 Token / 估算响应时间，结束后更新；含推理和等待的影响，不是逐 Token 的实时解码速度 |
| 缓存命中 | 最近一次请求的缓存输入 / 输入，不含输出 Token |
| ≈$ / ≥$ | 估算金额 / 数据或价格不全时已知部分的下限 |

**美元是按公开 API 价格折算的估值，不是订阅实际扣款、余额或官方周限。** 未知模型和无法还原的旧日志不会被当成免费。缺失 service tier 时按 Standard 估算，悬浮提示中可查看模型分项。

输入、缓存命中、缓存写入和输出分别计价；推理 Token 已在输出中，不重复相加；同一 response ID 跨分叉与归档只计一次。模型价格、长上下文规则与速度倍率保存在 [`app/pricing.json`](app/pricing.json)，当前价格表核对日期为 **2026-10-19**。价格需要人工维护，来源为 [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)。这些规则用于 API 等价估算，不是订阅内用量倍率。

## 自动跟随与已知限制

- 浮条仅在识别到官方 Codex 前台窗口时显示，跟随窗口移动，并保存拖动位置。它没有修改或嵌入输入框本身。
- 当前聊天 ID 从桌面诊断日志中的 `ownerRoutePath` 读取，不靠“最后有活动的聊天”猜测。该内部日志不是稳定公开接口；如果没有相应事件、日志不可读或更新后格式变化，会显示缺失状态。
- 部分版本中，这类导航事件与内置浏览器侧栏同步有关。第一次使用或无法跟随时，可以在 Codex 打开内置浏览器标签，再切换聊天；仍无数据时请检查日志兼容性。
- 同一进程中有多个无法区分的主窗口时，不会强行绑定某个聊天。
- 云端聊天可识别身份，但本机没有 Token 日志时会显示“云端未上报”。远程主机、其他电脑、普通 ChatGPT 聊天的用量不在本机统计范围内。
- 旧日志可能只有累计 Token，没有独立请求价格或可靠时间点；金额、速度会保留为缺失或不完整。
- 不额外绘制上下文占用圆圈，可以使用 Codex 自带的上下文指示器。

## 本地文件与隐私

默认只读：

- `%USERPROFILE%/.codex/sessions/` 与 `archived_sessions/`：会话用量和时间边界。
- `%LOCALAPPDATA%/Packages/OpenAI.Codex_2p2nqsd0c76g0/LocalCache/Local/Codex/Logs/`：导航元数据。

程序会读取日志文件字节；统计过程中可能解析消息事件以识别工具结束时间，但不保存消息正文，也不把正文提供给 HTTP 接口。不读取 `auth.json`，不需要账号凭证，不向外网发请求。

设置和运行诊断保存在 `%LOCALAPPDATA%/CodexTokenStrip/`，包含窗口位置、进程 ID、聊天 ID、汇总数字和错误信息。**这些诊断文件仍可能包含个人元数据，提交 issue 前请先脱敏；不要上传会话日志或凭证。** 本地服务仅监听 `127.0.0.1:23957`，拒绝其他 Host 和跨站 Origin；同机有权限的其他程序仍可访问该端口，不应暴露到局域网。

高级设置：退出浮条后，把 [`settings.example.json`](settings.example.json) 复制为上述目录中的 `settings.json`，再按需设置 `NodePath`、`Port`、`CodexHome`、`LogRoot`。`CODEX_HOME` 也可覆盖默认会话目录。测试时可用 `CODEX_TOKEN_STRIP_DATA_DIR` 和 `CODEX_TOKEN_STRIP_PORT` 隔离运行数据与端口。

## 开发与发布

```sh
npm test
npm run build
npm run package
```

ZIP 及 SHA-256 校验文件输出到 `dist/`。打包使用明确文件白名单，不收录运行状态、日志或本地设置。CI 在 Windows/Linux、Node.js 22/24 上测试，并在 Windows 编译浮条。界面示意图由 `TokenStrip.exe --demo <输出路径>` 使用虚构数据生成。

欢迎提交 bug 和兼容性改进。报告问题时，请说明 Windows / Codex / Node.js 版本、是否为本地聊天及可复现步骤；使用合成日志片段代替真实聊天。参与方式见 [CONTRIBUTING.md](CONTRIBUTING.md)，漏洞报告见 [SECURITY.md](SECURITY.md)。

本项目采用 [MIT License](LICENSE)，与 OpenAI 没有关联或背书。
