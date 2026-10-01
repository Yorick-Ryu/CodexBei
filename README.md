# CodexBei

使用 **Tauri 2 + Rust + React / TypeScript + Vite** 的桌面配置助手。通过 BeiAPI 密钥配置 Codex CLI / ChatGPT 桌面版 / Claude Code，支持 macOS 和 Windows。桌面端不包含 Electron 或 Node.js 运行时。

## 开发与构建

需要 Node.js、Rust 1.88+。macOS 使用 Xcode Command Line Tools，Windows 使用 MSVC C++ 工具链和 WebView2。

```sh
npm ci
npm start                 # Tauri 原生开发窗口
npm run build:mac         # macOS app / dmg
npm run build:win         # Windows NSIS；在 Windows 主机执行
npm test                  # Rust 核心 + 模板服务测试
npm run test:ui           # React 交互与视觉检查
npm run check             # TypeScript / Vite / Rust Clippy
```

默认构建当前主机架构，产物在 `src-tauri/target/release/bundle/`。跨架构需先安装对应 Rust target，再通过 `npm run build -- --target ...` 构建。macOS 最低版本为 13；Windows 安装包语言为简体中文和英文，系统 WebView2 不重复打包。离线安装场景需额外分发 WebView2。
本地普通构建不等同于正式签名、公证发布；正式 macOS 入口见 [签名与公证](docs/macos-signing.md)。
应用内更新、签名密钥和后续发布流程见 [自动更新](docs/auto-update.md)。

## 功能

- ChatGPT 与 Claude Code 分别查询当前 API 的余额、密钥余额和套餐额度；查询成功才显示，套餐默认折叠，支持手动刷新、剩余天数和 BeiAPI 充值入口，不展示官方额度。

- 传输协议 HTTP / WS 分段切换，立即写入 API 提供商的 supports_websockets，不生成备份；预览与后续一键配置保留该选择。
- 一键配置、预览、同地址密钥复用、保留官方登录，并可在 API 密钥与官方额度间切换；不改写 `auth.json`。
- 自动检测 CLI 和桌面版内核、手动选择版本；Rust 调用在线模板服务，校验字段白名单、版本范围、发布序号和模板摘要，离线使用已缓存或内置模板。
- 通过当前网关请求带 `client_version` 的模型列表；网络请求均在 Rust 中执行，旧密钥不会用于新网关。
- 写入前备份、冲突检测、原子替换、还原前再次备份；最近 10 份备份保留，旧备份移至废纸篓/回收站，历史内容经过脱敏。
- `codexbei://configure/codex` 网站唤起与自动配置、单实例、防重复和过期链接处理。
- 系统/深浅主题，默认 600 × 560、最小 460 × 460。
- Windows 右上角设置内提供“问题排查”，生成包含脱敏当前配置的只读检测报告；独立脚本与检查范围见 [Windows 问题排查](docs/windows-diagnostics.md)。

Claude Code 使用内置映射，写入 `$CLAUDE_CONFIG_DIR/settings.json` 或 `~/.claude/settings.json` 的六个 `env` 字段；Opus、Sonnet、Haiku 默认跟随所选模型，也可分别选择。其他 JSON 设置保留，预览只显示脱敏后的托管字段，备份独立保存并可恢复。未安装 CLI 时也可先保存配置，安装后新会话生效。

Codex 配置默认位于 `$CODEX_HOME/config.toml` 或 `~/.codex/config.toml`，可使用原生文件选择器选择 `config.toml` 或 `*.config.toml`。应用缓存与备份位于系统本地数据目录下的 `CodexBei/`。TOML 合并保留无关配置语义，部分排版会规范化；备份保存原始字节。

网站链接参数为 `base_url`、`api_key`、`model`、`preset=codexbei-v1`，均必须唯一。API 地址仅允许无账号、查询参数和片段的 HTTPS 地址。版本服务只接收版本标识，不接收密钥、路径或配置内容。Claude 使用 `codexbei://configure/claude` 与 `preset=claude-v1`，API 地址去除末尾 `/v1`；网页按用户选择的可用分组复用密钥，没有合适密钥时创建 `CodexBei · CC`。

## 代码与验证

- `desktop/`：React 界面、主题和品牌资源。
- `src-tauri/`：Rust 本地功能、版本检测、网络、模板、配置和备份。
- `templates/bootstrap.json`：内置离线模板。
- `worker/`、`remote/`：独立的在线模板服务，部署说明见 [remote/README.md](remote/README.md)。服务端保留适用于 Cloudflare Workers 的实现，不随桌面端打包。

UI 测试使用模拟 IPC，Rust 测试使用临时文件。真实原生验证使用 Debug 构建并设置绝对路径 `CODEXBEI_TEST_ROOT`，将配置、缓存、备份全部隔离；该入口在 Release 中不存在。测试过程中不要操作真实 Codex 配置。
React 测试当前使用 macOS 的 Google Chrome，截图输出到忽略目录 `artifacts/tauri-ui/`。
