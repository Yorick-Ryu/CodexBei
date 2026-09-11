# CodexBei 远端模板

发布源是 [manifest.json](manifest.json)，随 `codexbei-config` Cloudflare Worker 打包发布，不依赖 R2 或 KV。接口为 `POST https://codexbei.beiapi.cn/config/v1/resolve`。发布是否成功以 HTTPS 实际返回的 `release` 为准。

同一个 Worker 还提供应用下载和自动更新，见 [应用自动更新](../docs/auto-update.md)。部署前必须保留完整的 `dist-downloads` 静态资源目录，避免移除已发布安装包。

## ChatGPT macOS 镜像

Worker 每周日 03:00（UTC）从 `CHATGPT_MAC_ARM64_URL` 和 `CHATGPT_MAC_X64_URL` 下载未经修改的官方 DMG 到 R2，下载地址为 `/mirror/arm64/ChatGPT_aarch64.dmg`、`/mirror/x64/ChatGPT_x64.dmg`，清单为 `/mirror/manifest.json`。这两个上游地址通过 Worker secret/var 配置，不写入仓库；上游地址变化时更新变量即可。手动同步使用 `POST /mirror/sync` 并携带 `Authorization: Bearer <MIRROR_SYNC_TOKEN>`。首次启用前创建 `codexbei-mac-mirror` R2 bucket，并配置 `MIRROR_SYNC_TOKEN` 与两个上游 URL。

下载页源码在 [download-page/index.html](download-page/index.html)、[style.css](download-page/style.css) 和 [app.js](download-page/app.js)。运行 `node scripts/stage-app-downloads.cjs <发布目录> dist-downloads` 生成页面，再用 `python3 -m http.server 0 --bind 127.0.0.1 --directory dist-downloads` 本地预览；本地生成不部署。架构默认 Mac Apple 芯片 / Windows x64；外观支持跟随系统、深色、浅色，并在浏览器保存选择。

客户端启动、点击配置、每 4 小时和离开超过 5 分钟后重新聚焦时检查远端。下载失败、超时、格式损坏或倒退版本均保留最近有效缓存；首次离线使用随客户端分发的已验证模板。下载和检查只更新缓存，不修改 Codex。新版本通过「更新配置」按钮提示，点击才备份并写入。

## 模板维护

- `schemaVersion`：协议版本，当前为 1。
- `release`：整个清单的递增整数。每次发布递增，包括回滚。
- `publishedAt`：ISO 8601 时间。
- `templates[].id` / `version`：模板名称和语义版本；修改内容、范围或删除规则时提升版本。相同版本内容不可变。
- `default`：必须且只能有一个 `true` 的默认模板，其 `targets` 为空；适用所有版本。专用模板设为 `false` 并填写版本范围。没有客户端版本限制。
- `targets[].kind`：`cli` 或 `desktop`；`runtimeRange` 匹配各自实际运行的 Codex 内核版本。桌面版可额外设置 `appRange: {"min":"26.900.0","maxExclusive":"26.902.0"}`，按数字逐段比较（保留 Windows 第四段），不会把 App 版本当成内核版本。
- `set`：托管字段的嵌套 JSON。密钥必须为 `$api_key`、模型为 `$model`、地址为 `$base_url`；不会接收真实凭据或模板指定的默认模型。
- `remove`：为协议兼容保留，但必须为空数组。模板只增加或替换字段；不在 `set` 中的已有字段保持不变，客户端和服务端拒绝删除规则。

更新时保留原有 MCP、项目、其他服务商、额外请求头和注释。API 通道固定使用默认供应商标识 `custom`，避免改变本地对话关联的供应商。保存时更新 `model_providers.custom` 并清理其中冲突的认证字段，其他供应商保持不变。正在使用的密钥从本机现有配置读取，不上传、不写入模板缓存、不传给界面；模型沿用用户选择。

CLI 使用 `codex --version`；桌面版单独调用其内置 Codex 的 `--version`，并读取应用元数据。macOS 检查标准路径与 Spotlight；Windows 检查 PATH、npm 原生二进制和 Store/用户安装目录。无法确定版本或尚未安装时使用默认模板，也可以手动选择安装或填写版本以匹配专用模板。自动模式优先选择覆盖所选全部安装的专用模板，否则使用默认模板；多个专用模板匹配时选择模板版本最高的，同版本冲突不自动应用。专用模板包含完整推荐配置，不是字段补丁；其优先级始终高于默认模板。默认模板为 `codex-default`，当前版本和发布批次以线上 resolve 接口为准。

客户端拒绝超出允许范围的写入，即使 JSON 有效。支持的托管字段和参数边界以 [Rust 客户端模板规则](../src-tauri/src/templates.rs) 和 [服务端模板规则](../worker/lib/template-policy.cjs) 为准；新增管理范围需要客户端审查升级。模板是数据，不支持脚本、任意文件路径、任意下载地址或自动执行命令。

## 请求与版本

```json
{"targets":[{"kind":"cli","runtimeVersion":"0.153.4"},{"kind":"desktop","runtimeVersion":"0.153.4","appVersion":"26.901.51231"}]}
```

请求仅含版本标识，不发送密钥、模型、地址、路径或现有配置。HTTP 请求被拒绝。成功返回 `schemaVersion`、`release`、规范化后的 `request` 和单个 `template`；没有专用规则时返回默认模板；专用规则同版本冲突时 HTTP 404 且 `template: null`，不返回完整清单。非法请求返回 400；配置源无效返回 503。

CLI/桌面内核使用 SemVer，如 `0.153.4`，GitHub 标签 `rust-v0.153.4` 中的 `rust-v` 不属于运行时版本。预览版如 `0.154.0-alpha.3`、`0.153.0-alpha.5.1` 保留完整后缀，专用模板只有显式预览版范围才能匹配，否则使用默认模板。桌面应用版本另行读取；官方更新日志出现 `26.305`、`26.401` 等版本，本机元数据可能包含更长构建编号，不能据此推断内核版本。

缓存为 `cache/resolved-templates.json`，按所选安装的完整版本组合隔离，最多保留 20 组。在线未匹配结果也会缓存，不能回退成另一版本的配置；网络失败使用同一组合的缓存或内置默认模板。请求不包含 CodexBei 版本；未知内核版本为 null，无安装为 `targets: []`。不提供旧清单接口或旧缓存迁移。完整备份及已应用模板标识位于 `backups/`。

## 发布

模型列表直接请求 NewAPI 的 `/v1/models?client_version=<Codex 内核版本>`，读取 `models[].slug`，仅显示 `visibility: "list"` 且 `supported_in_api: true` 的条目并保留接口顺序。版本沿用所选安装或手动版本；自动模式优先 CLI，其次桌面版内核，不传桌面 App 构建号或 CodexBei 版本。未知时提示手动选择，不伪造版本。非对话和压缩模型由 NewAPI Codex 接口过滤，客户端不维护额外名单，模型列表不依赖 Worker。Worker 提供配置模板、应用更新检查和下载。

所需权限：beiapi.cn 所属账户的 Workers Scripts Edit，以及 beiapi.cn 的 Zone/DNS Read（用于核对资源归属）。当前使用 Worker 自定义域名，不使用按路径配置的 Workers Routes。令牌存放在权限为 600 的独立文件，不写入源码。

```sh
npm test
npm run test:ui
npm run worker:check
node scripts/publish-templates.cjs --token-file /absolute/path/to/cloudflare-token --apply
```

不加 `--apply` 只本地校验并打包，不访问 R2。修改模板时同时递增 `release` 和模板 `version`，重新发布 Worker 即可，无需重发客户端。发布前保留旧源文件；回滚配置时使用旧内容并分配新的 release/version，不能降低版本号。

参考：[Codex 版本识别](https://learn.chatgpt.com/docs/reference/troubleshooting)、[Codex CLI 发布](https://github.com/openai/codex/releases)、[Codex 更新日志](https://learn.chatgpt.com/docs/changelog)、[Worker 自定义域名](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。
