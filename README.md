# CodexBei

Windows / macOS 的独立 Electron 工具。首版只配置 Codex，Claude Code 为禁用占位。

默认跟随系统自动切换石墨灰 / 雾白，顶部可手动固定主题并记住选择。

界面修改先阅读 [DESIGN.md](DESIGN.md)；Linear 风格参考原文与授权见 [设计资料](docs/design-reference/README.md)。

```sh
npm ci
npm test
npm run test:ui
npm start
npm run build:mac
npm run build:win
```

推荐配置随 Cloudflare Worker 发布，客户端提交版本，Worker 只返回匹配的模板，然后由客户端合并。维护和发布见 [远端模板](remote/README.md)。
`src/bootstrap-manifest.json` 只用于首次离线兜底，远端更新不需要重新打包。
`src/toml-patch.cjs` 按语法树范围修改推荐字段，保留其他字段、MCP、项目、供应商及注释。
冲突的 `custom.env_key` / `custom.auth` 会移除，密钥按模板写入 `experimental_bearer_token`。
会同时清理覆盖这些认证字段的旧 Authorization 请求头，其他自定义请求头保持原样。
不改 `auth.json`，不安装或自动重启 Codex。用户需重新打开 Codex 并实际发送请求验证。

路径优先级：进程的 `CODEX_HOME` → `~/.codex/config.toml`，另可手选。
GUI 进程可能不继承终端的环境变量，可在“更多设置”中查看或更改路径。
检测到默认 profile 时停止并提示选择 profile 文件；旧式内嵌 profile、符号链接和 WSL 暂不自动处理。

应用标识为 `cn.beiapi.codexbei`，数据目录为 Electron `appData/CodexBei`。
修改前将原文件完整备份至 Electron `userData/backups/<UUID>`；备份含 SHA-256、目标路径及原文件是否存在。
预览到写入之间检查文件变化；原子写入失败保留原文件。还原前备份当前状态，支持撤销还原。
备份可能包含用户原有凭据；仅保存在本机，Unix 文件权限为 600、目录为 700，Windows 使用当前用户目录的 ACL。
不同进程仍可能在最终校验与替换之间写同一文件，配置时请关闭其他配置编辑器。

网站入口位于 `../new-api/web/src/features/dashboard/components/overview/desktop-setup-dialog.tsx`。
网站弹窗选择 Agent（首版 Codex）和模型；模型来自 `/api/user/models?group=default&client_version=codexbei`，复用 `/v1/models?client_version=...` 的 Codex 目录筛选与顺序，只展示当前用户在 GPT 分组中可用的模型，优先选中可用的 `gpt-6-astra`。
确认时先分页检查当前用户密钥，复用已启用、未过期、有可用额度、绑定 `default` 分组、允许所选模型且没有 IP 限制的密钥；查完没有匹配项才创建 `CodexBei · Codex`。每次重试或换模型均重新检查，查询失败不创建。密钥与链接不存入页面状态或 localStorage。
网站依赖 `/api/token/` 创建响应中的 `data.id`，需要同步部署后端改动。
唤起协议为 `codexbei://configure/codex?base_url=...&api_key=...&model=...&preset=codexbei-v1`；四个参数必须唯一且完整。预设标识选择 CodexBei 的远端模板系列；应用时填入 API 地址、密钥与所选模型，模板不能覆盖这些用户选项。
App 支持命令行冷启动、Windows 第二实例和 macOS open-url 接收，自动填入地址和密钥；链接不能指定文件路径或触发写入，用户点击“一键配置”才会备份和写入。
首页采用紧凑布局；路径、地址编辑和可选预览位于“更多设置”，备份列表位于“还原配置”。
完整链接包含长期密钥，不应记录或分享。App 中密钥使用密码框显示，预览仅显示掩码。
无参数的 `codexbei://configure/codex` 仍可仅打开窗口，手动粘贴保留为备用方式。
网页完成状态来自用户手动确认，不冒充本机检测结果。

安装包发布后，在网站构建环境设置以下 HTTPS 下载地址：

```text
VITE_SETUP_WINDOWS_X64_URL
VITE_SETUP_WINDOWS_ARM64_URL
VITE_SETUP_MAC_ARM64_URL
VITE_SETUP_MAC_X64_URL
```

未设置时网站如实显示“安装包尚未发布”，不提供失效下载链接。
独立仓库的 `.github/workflows/build.yml` 可在原生系统上运行测试、构建四种安装包；不会自动发布。
公开分发前需要接入组织的 Windows 代码签名、macOS Developer ID 签名及 notarization，再发布安装包并设置下载地址。

测试安装包位于 `dist/`（未签名），版本以 `package.json` 为准。
配置、链接解析与网站交互测试分别见 `test/` 和网站组件的 `__tests__/`。
桌面核心测试、网站交互测试和 UI 测试覆盖配置与唤起流程。
`npm run test:ui` 在临时目录验证自动填入、设置默认收起、首屏主操作可见、一键配置、可选预览、错误重试和完整还原，并保存截图至 `artifacts/`。
测试中的原生还原确认由测试桩接受；Windows 真机安装运行、操作系统协议关联和网关真实请求仍需发布前验收。

Codex 配置字段依据：[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。
