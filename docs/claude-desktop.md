# Claude 桌面版

入口：Claude 桌面版 Tab。默认填写密钥即可一键配置 BeiAPI，首次配置自动获取并选择原生 Claude 模型。API 地址、默认模型、模型发现和 1M 位于“更多设置”，不修改 CLI 配置。列表中存在模型不代表当前密钥分组一定有可用上游；最终需实际消息验证。

进入页面时先检测 Claude 桌面版是否安装。macOS 检查系统和用户“应用程序”目录，并通过 Spotlight 查找其他位置的 Claude 应用，忽略挂载安装镜像中的副本；Windows 检查常见传统安装目录和当前用户已注册的 MSIX/商店包。残留配置目录不算已安装。未安装时显示与其他页面一致的引导卡，提供“下载桌面版”和“重新检测”；每 10 秒及返回窗口时重新检测，找到应用后开放配置并停止轮询。检测失败会明确显示错误，允许重试。

下载按钮使用 [Wangnov/claude-app-mirror](https://github.com/Wangnov/claude-app-mirror) 社区镜像：macOS 打开 `https://claudeapp.agentsmirror.com/latest/mac`（通用 DMG）；Windows 根据 CodexBei 构建架构选择 `/latest/win-x64` 或 `/latest/win-arm64`（MSIX）。镜像由第三方维护，项目声明同步未经修改的官方安装包并提供校验和，CodexBei 不托管或修改这些文件。官方下载入口仍为 <https://claude.com/download>。

保存配置后重新打开 Claude 生效。首次使用可能需要在 Claude 中确认第三方网关。仅支持 Anthropic Messages API 和完整的原生 Claude 模型 ID；DeepSeek、Kimi 等别名需要额外映射网关，当前不支持。`[1M]` 后缀转为 `supports1m`，不会直接写入模型 ID。

模型发现与 1M 上下文默认开启，可分别关闭。获取到的原生 Claude 模型写入桌面模型列表，所选默认模型排在首位；启用 1M 时同时写入模型能力和上下文偏好。网关和模型仍需实际支持该上下文长度。

“更多设置”中的“允许访问所有网站”控制网页抓取、内置浏览器和命令的出站联网，首次配置默认关闭，已有配置会读取当前状态。开启写入 `coworkEgressAllowedHosts: ["*"]`、`builtinBrowserEnabled: true` 和 `builtinBrowserDefaultDomainPolicy: "allow"`；关闭时域名列表为空、浏览器站点策略为 `block`，会替换现有自定义联网白名单。模型请求、搜索和 MCP 自身连接不受此开关控制；网站自身、网络环境和 Claude 站点安全检查仍可能限制访问。保存后需重开 Claude，并新建任务验证。

## 网站一键配置

网站选择“Claude 桌面版”后使用独立链接 `codexbei://configure/claude-desktop`，参数为 `base_url`、`api_key`、`model` 和 `preset=claude-desktop-v1`。仅接受 HTTPS 网关和完整原生 Claude 模型，拒绝重复参数、CLI preset 与模型别名。不要在日志、截图或文档中记录带真实密钥的链接。

CodexBei 自动切换到桌面版页面；未安装时保留待处理连接并显示安装引导，检测到安装后继续。保存前获取原生模型列表，保留已有模型发现、1M 和联网偏好；首次联网权限仍默认关闭。较新的链接取代正在请求中的旧链接，旧请求不能覆盖新配置。

网站入口与接收端必须配套上线：已发布的 0.1.12 尚不支持此 route，需要包含该改动的新版本。回滚网站选项可停止新链接；已保存的本地 Claude profile 会保留，可使用已有备份恢复。

## 配置存储

- macOS：`~/Library/Application Support/Claude/` 和 `Claude-3p/`。
- Windows：`%LOCALAPPDATA%/Claude/` 和 `Claude-3p/`；无标准目录时识别有配置文件的版本后缀目录，多个候选时拒绝猜测。
- 两个 `claude_desktop_config.json` 的 `deploymentMode` 设为 `3p`；独立 profile 写入 `Claude-3p/configLibrary/8a6b4459-8b93-4dc2-a094-b734be1a9190.json`，更新 `_meta.json` 的条目和 `appliedId`。保留其他 profiles、MCP 与无关设置。
- 备份位于 CodexBei 本地数据目录的 `claude-desktop/backups/`，含密钥，禁止上传或输出原文。所有变更解析、验证完成后才写入；写入失败尝试回滚，后续更改冲突时保留现场与备份。
- 新版 Claude 会把 profile 的密钥转为本机加密值，不能复制该文件给另一台电脑。每台设备用自己的 CodexBei 连接生成配置。

实现参考 [CC Switch](https://github.com/farion1231/cc-switch/blob/22a4e50e1867744591af6a562a910e9bc63fad08/src-tauri/src/claude_desktop_config.rs) 的路径与 profile 协议，未复制源码。官方说明：[Gateway](https://claude.com/docs/third-party/claude-desktop/gateway)、[配置参考](https://claude.com/docs/third-party/claude-desktop/configuration)。

## 验证入口

`cargo test --manifest-path src-tauri/Cargo.toml claude_desktop` 检查配置保留、模型与 Windows 路径。UI 测试使用模拟 IPC；不能代替真实 Claude 验收。Windows 构建由仓库现有 x64 / ARM64 Actions 流程验证，实机消息测试需单独完成。
