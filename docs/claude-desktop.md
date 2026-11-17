# Claude 桌面版

入口：Claude 桌面版 Tab。单独填写 API 地址、密钥和默认模型，或从 ChatGPT / Claude Code 导入连接。后者在本机复用密钥，向同一网关获取 Claude 模型列表，不修改 CLI 配置。列表中存在模型不代表当前密钥分组一定有可用上游；最终需实际消息验证。

先彻底退出 Claude，再应用配置并重新打开。首次使用可能需要在 Claude 中确认第三方网关。仅支持 Anthropic Messages API 和完整的原生 Claude 模型 ID；DeepSeek、Kimi 等别名需要额外映射网关，当前不支持。`[1M]` 后缀转为 `supports1m`，不会直接写入模型 ID。

模型发现与 1M 上下文默认开启，可分别关闭。获取到的原生 Claude 模型写入桌面模型列表，所选默认模型排在首位；启用 1M 时同时写入模型能力和上下文偏好。网关和模型仍需实际支持该上下文长度。

## 存储与恢复

- macOS：`~/Library/Application Support/Claude/` 和 `Claude-3p/`。
- Windows：`%LOCALAPPDATA%/Claude/` 和 `Claude-3p/`；无标准目录时识别有配置文件的版本后缀目录，多个候选时拒绝猜测。
- 两个 `claude_desktop_config.json` 的 `deploymentMode` 设为 `3p`；独立 profile 写入 `Claude-3p/configLibrary/8a6b4459-8b93-4dc2-a094-b734be1a9190.json`，更新 `_meta.json` 的条目和 `appliedId`。保留其他 profiles、MCP 与无关设置。
- 备份位于 CodexBei 本地数据目录的 `claude-desktop/backups/`，含密钥，禁止上传或输出原文。所有变更解析、验证完成后才写入；写入失败尝试回滚，后续更改冲突时保留现场与备份。
- 新版 Claude 会把 profile 的密钥转为本机加密值，不能复制该文件给另一台电脑。每台设备用自己的 CodexBei 连接生成配置。
- 撤销保留 Claude 启动后新增的运行偏好。首次创建的 profile 若已加密，撤销只移除其索引与激活状态，保留该文件；已有 profile 的密钥或其他托管字段发生后续更改时，拒绝覆盖并保留备份。

实现参考 [CC Switch](https://github.com/farion1231/cc-switch/blob/22a4e50e1867744591af6a562a910e9bc63fad08/src-tauri/src/claude_desktop_config.rs) 的路径与 profile 协议，未复制源码。官方说明：[Gateway](https://claude.com/docs/third-party/claude-desktop/gateway)、[配置参考](https://claude.com/docs/third-party/claude-desktop/configuration)。

## 验证入口

`cargo test --manifest-path src-tauri/Cargo.toml claude_desktop` 检查配置保留、恢复、冲突、模型与 Windows 路径。UI 测试使用模拟 IPC；不能代替真实 Claude 验收。Windows 构建由仓库现有 x64 / ARM64 Actions 流程验证，实机消息测试需单独完成。
