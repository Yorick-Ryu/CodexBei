# CodexBei 远端模板

发布源是 [manifest.json](manifest.json)，随 `codexbei-config` Cloudflare Worker 打包发布，不依赖 R2 或 KV。接口为 `POST https://codexbei.beiapi.cn/config/v1/resolve`。发布是否成功以 HTTPS 实际返回的 `release` 为准。

同一个 Worker 还提供应用下载和自动更新，见 [应用自动更新](../docs/auto-update.md)。部署前必须保留完整的 `dist-downloads` 静态资源目录，避免移除已发布安装包。

## ChatGPT macOS 镜像

Worker 每天 03:00（UTC，北京时间 11:00）从 `CHATGPT_MAC_ARM64_URL` 和 `CHATGPT_MAC_X64_URL` 下载未经修改的官方 DMG 到 R2，下载地址为 `/mirror/arm64/ChatGPT_aarch64.dmg`、`/mirror/x64/ChatGPT_x64.dmg`，清单为 `/mirror/manifest.json`。每次覆盖对应架构的固定对象，只保留最后一次成功同步的安装包，不保留历史版本。Apple 芯片使用官方 `Codex.dmg`（arm64），Intel 使用官方 `Codex-latest-x64.dmg`（x64），不可共用同一安装包。两个上游地址通过 Worker var 配置，上游地址变化时更新变量即可。手动同步使用 `POST /mirror/sync` 并携带 `Authorization: Bearer <MIRROR_SYNC_TOKEN>`。首次启用前创建 `codexbei-mac-mirror` R2 bucket，并配置 `MIRROR_SYNC_TOKEN` 与两个上游 URL。

下载页源码在 [download-page/index.html](download-page/index.html)、[style.css](download-page/style.css) 和 [app.js](download-page/app.js)。运行 `node scripts/stage-app-downloads.cjs <发布目录> dist-downloads` 生成页面，再用 `python3 -m http.server 0 --bind 127.0.0.1 --directory dist-downloads` 本地预览；本地生成不部署。架构默认 Mac Apple 芯片 / Windows x64；外观支持跟随系统、深色、浅色，并在浏览器保存选择。

客户端启动、点击配置和手动更新模板时检查远端。应用安装检测与模板检查独立：启动时识别 CLI／桌面版；两者都未安装且已进入安装流程时，每 10 秒及窗口重新聚焦时重试；本次运行识别到任一应用后停止安装检测，配置、导入和模板更新复用检测结果。下载失败、超时、格式损坏或倒退版本均保留最近有效缓存；首次离线使用随客户端分发的已验证模板。下载和检查只更新缓存，不修改 Codex。新版本通过「更新配置」按钮提示，点击才备份并写入。

## 模板维护

- `schemaVersion`：协议版本，当前为 1。
- `release`：整个清单的递增整数。每次发布递增，包括回滚。
- `publishedAt`：ISO 8601 时间。
- `templates[].id` / `version`：模板名称和语义版本；修改内容、范围或删除规则时提升版本。相同版本内容不可变。
- `default`：必须且只能有一个 `true` 的默认模板，其 `targets` 为空；适用所有版本。专用模板设为 `false` 并填写版本范围。原生模型发现模板额外要求 CodexBei 客户端版本满足 `>=0.1.3`。
- `targets[].kind`：`cli` 或 `desktop`；`runtimeRange` 匹配各自实际运行的 Codex 内核版本。桌面版可额外设置 `appRange: {"min":"26.900.0","maxExclusive":"26.902.0"}`，按数字逐段比较（保留 Windows 第四段），不会把 App 版本当成内核版本。
- `set`：托管字段的嵌套 JSON。密钥必须为 `$api_key`、模型为 `$model`、地址为 `$base_url`；不会接收真实凭据或模板指定的默认模型。
- `remove`：为协议兼容保留，但必须为空数组。模板只增加或替换字段；不在 `set` 中的已有字段保持不变，客户端和服务端拒绝删除规则。

更新时保留原有 MCP、项目、其他服务商、额外请求头和注释。API 通道固定使用默认供应商标识 `custom`，避免改变本地对话关联的供应商。保存时更新 `model_providers.custom` 并清理其中冲突的认证字段，其他供应商保持不变。正在使用的密钥从本机现有配置读取，不上传、不写入模板缓存、不传给界面；模型沿用用户选择。

CLI 使用 `codex --version`；桌面版单独调用其内置 Codex 的 `--version`，并读取应用元数据。macOS 检查标准路径与 Spotlight；Windows 检查 PATH、npm 原生二进制和 Store/用户安装目录。无法确定版本或尚未安装时使用默认模板，也可以手动选择安装或填写版本以匹配专用模板。自动模式优先选择覆盖所选全部安装的专用模板，否则使用默认模板；多个专用模板匹配时选择模板版本最高的，同版本冲突不自动应用。专用模板包含完整推荐配置，不是字段补丁；其优先级始终高于默认模板。默认模板为 `codex-default`，当前版本和发布批次以线上 resolve 接口为准。

客户端拒绝超出允许范围的写入，即使 JSON 有效。支持的托管字段和参数边界以 [Rust 客户端模板规则](../src-tauri/src/templates.rs) 和 [服务端模板规则](../worker/lib/template-policy.cjs) 为准；新增管理范围需要客户端审查升级。模板是数据，不支持脚本、任意文件路径、任意下载地址或自动执行命令。

## 请求与版本

```json
{"clientVersion":"0.1.3","targets":[{"kind":"cli","runtimeVersion":"0.153.4"},{"kind":"desktop","runtimeVersion":"0.153.4","appVersion":"26.901.51231"}]}
```

请求仅含版本标识，不发送密钥、模型、地址、路径或现有配置。HTTP 请求被拒绝。成功返回 `schemaVersion`、`release`、规范化后的 `request` 和单个 `template`；没有专用规则时返回默认模板；专用规则同版本冲突时 HTTP 404 且 `template: null`，不返回完整清单。非法请求返回 400；配置源无效返回 503。

CLI/桌面内核使用 SemVer，如 `0.153.4`，GitHub 标签 `rust-v0.153.4` 中的 `rust-v` 不属于运行时版本。预览版如 `0.154.0-alpha.3`、`0.153.0-alpha.5.1` 保留完整后缀，专用模板只有显式预览版范围才能匹配，否则使用默认模板。桌面应用版本另行读取；官方更新日志出现 `26.305`、`26.401` 等版本，本机元数据可能包含更长构建编号，不能据此推断内核版本。

`clientVersion` 从 CodexBei 构建版本自动读取，使用严格 SemVer；旧客户端可省略，服务端不会在响应的 `request` 中补字段。原生模型发现要求客户端主、次、补丁版本不低于 `0.1.3`，包括该版本及后续版本的 alpha、beta、rc；缺失或低于门槛时仍匹配兼容模板。它与 `targets[].runtimeVersion`（Codex 内核版本）独立，内核预览版仍按模板显式范围匹配。

模板缓存文件为 `templates-v2.json`，按 CodexBei 版本及所选安装的完整版本组合隔离，最多保留 20 组。在线未匹配结果也会缓存，不能回退成另一版本的配置；网络失败使用同一组合的缓存或内置模板。旧缓存不会被套用到新客户端版本；未知内核版本为 null，无安装为 `targets: []`。不提供旧清单接口。完整备份及已应用模板标识位于 `backups/`。

## 发布

`codex-native-catalog` 模板（1.0.4）仅当所选 CLI／桌面内核全部满足 `>=0.156.0` 时选择，即以最低内核版本为准；未知版本、旧内核和未显式覆盖的预览版继续默认模板 1.0.3。客户端再次检查内核门槛，不以桌面应用版本号判断。

客户端预发布版本的兼容规则修复同时提升清单批次，并保持 `remote/manifest.json` 与 `templates/bootstrap.json` 一致，使旧批次缓存失效；不放宽同批次响应不可变和防回退校验。

原生模板将 `$model_catalog_url` 绑定到规范化 API 地址后追加 `/models`，写入当前 provider，并启用 `features.api_key_model_discovery`。配置、导入、启动同步与通道切换均不再下载本地目录；“刷新”只同步原生配置并刷新 CodexBei 下拉候选，不强制刷新已运行的 Codex。迁移撤下工具托管的 `model_catalog_json`，不删除旧目录；用户自行设置的静态目录会阻止迁移并提示处理。原设置保存在所选文件旁的 `<配置文件主名>.native.previous.json`，切回官方或旧方案时仅恢复仍由工具管理的设置。以下本地目录流程仅适用于旧方案。

发布顺序：先发布支持可选 `clientVersion` 分流的 Worker 与配套清单，再交付新客户端。旧客户端不带字段，继续收到兼容模板及原格式响应；新客户端同时通过客户端版本和全部所选内核版本门槛才收到原生模板。清单仍使用同一递增 release，不降低客户端防回退校验。旧线上服务尚不接受该字段、本地内置批次又高于线上时，本地预览版仍会提示暂时无法检查更新；完成配套部署后再验收在线检查，不用放宽校验掩盖部署差异。

切换通道立即保存并返回，切到 API 后异步同步模型目录；网络失败不撤销通道切换，也不覆盖已有目录。请求期间不持有模板服务锁；完成后检查配置版本，用户已切换通道或改配置则丢弃迟到结果。

启动时，如果当前已保存的配置使用 API 通道，客户端检查一次模型目录；内容一致时不写文件，后台失败保持原样。模型旁的「刷新」同步当前已保存 API 的模型目录并刷新下拉列表；地址或密钥已修改时提示先保存。未配置 API 或处于官方通道时仅刷新候选列表。更新成功提示重新启动 Codex。旧版无自定义目录的配置在首次成功同步时自动补齐；官方通道跳过自动同步。

模型列表直接请求 NewAPI 的 `/v1/models?client_version=<Codex 内核版本>`，读取 `models[].slug`，仅显示 `visibility: "list"` 且 `supported_in_api: true` 的条目并保留接口顺序。版本沿用所选安装或手动版本；自动模式优先 CLI，其次桌面版内核，不传桌面 App 构建号或 CodexBei 版本。未知时提示手动选择，不伪造版本。非对话和压缩模型由 NewAPI Codex 接口过滤，客户端不维护额外名单，模型列表不依赖 Worker。Worker 提供配置模板、应用更新检查和下载。

配置 API、导入配置链接或切换到 API 时，客户端获取完整 Codex 目录，成功后覆盖所选配置文件旁的 `models_cache_bei.json`，将绝对路径写入顶层 `model_catalog_json`。目录保留模型能力和指令字段，不保存密钥；获取失败或空目录不更新目录文件和路径，通道切换仍独立生效。配置或导入操作获取失败则保留整份原配置。`models_cache_bei.previous.json` 记录接管前的目录设置。切回官方时仅撤下本工具管理的目录，恢复原设置；兼容旧版摘要路径，用户自行替换的路径保留。Codex 在启动时读取目录，已运行的客户端需要重新启动才能可靠生效。此功能需要更新客户端，不能仅发布远端模板实现。

所需权限：beiapi.cn 所属账户的 Workers Scripts Edit，以及 beiapi.cn 的 Zone/DNS Read（用于核对资源归属）。当前使用 Worker 自定义域名，不使用按路径配置的 Workers Routes。令牌存放在权限为 600 的独立文件，不写入源码。

```sh
npm test
npm run test:ui
npm run worker:check
node scripts/publish-templates.cjs --token-file /absolute/path/to/cloudflare-token --apply
```

不加 `--apply` 只本地校验并打包，不访问 R2。修改模板时同时递增 `release` 和模板 `version`，重新发布 Worker 即可，无需重发客户端。发布前保留旧源文件；回滚配置时使用旧内容并分配新的 release/version，不能降低版本号。

参考：[Codex 版本识别](https://learn.chatgpt.com/docs/reference/troubleshooting)、[Codex CLI 发布](https://github.com/openai/codex/releases)、[Codex 更新日志](https://learn.chatgpt.com/docs/changelog)、[Worker 自定义域名](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。
