# Windows 问题排查

右上角 **设置** → **问题排查** → **开始排查**（仅 Windows 显示）。结果在可滚动日志中逐项显示，包含检查名、状态和实际结果；“复制报告”复制同一份日志及末尾配置。HTTPS 检查记录请求地址、HTTP 状态、curl 退出码、IP 和 DNS/连接/TLS/首字节/总耗时。日志上方保留简短介绍，初始显示“等待排查”；点击后显示运行状态，完成后展示检查结果。

配置附件保留原有格式、注释、路径、MCP、自定义字段及非认证请求头；复用配置预览的凭证脱敏，仅遮住 API Key、Token、密码等值。配置无法解析时不附原文。报告只在本机生成，扫描不会修改配置、代理或注册表，也不发送密钥或模型请求。

独立运行（Windows PowerShell 5.1 或 PowerShell 7）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-diagnostics.ps1 -BaseUrl https://api.beiapi.cn/v1
```

`-ConfigPath` 可指定要检查的配置文件位置；`.env` 始终按当前进程的 `CODEX_HOME`（否则 `%USERPROFILE%\.codex`）定位，不跟随任意所选 TOML 文件。

检查范围：`.env` 代理赋值、进程/用户/系统环境变量、手动代理和 PAC 配置、WinHTTP 默认代理、明确的本机代理端口、curl 直连/默认 HTTPS（含耗时），以及常见安装路径中的 `codex.exe --version`。不打印环境变量原值、API Key、请求头、完整配置或原始命令错误。每个子进程有超时，应用内整体上限 55 秒。

- `.env` 会在 Codex 启动时重新注入变量；清除终端代理不一定有效。
- `ProxyEnable=0` 时，残留 `ProxyServer` 不能证明代理启用。WinHTTP 默认直连也不能排除 PAC 或环境变量。
- 未带密钥的 HTTP 401 表示接口可达，不代表认证、模型、WebSocket 或对话成功。curl 路由也不等于 Codex 路由。
- `.env` 的代理检测是静态赋值扫描，不执行变量展开；重复赋值、复杂多行内容需打开文件核实。只探测明确的 loopback 端口；代理目标保留，URL 中的凭证隐藏。

纯检测：不提供备份、打开文件、自动修复或设置修改操作。报告仅记录检查结果。

开发验证：`powershell.exe -NoProfile -File test/windows-diagnostics.test.ps1`；Windows x64/ARM64 构建流程分别执行 PowerShell 5.1/7 测试。UI 测试模拟 IPC，不能替代 Windows 原生验收。正式发布仍需在代理软件关闭、`.env` 指向失效端口的隔离 Windows 环境验证报告与只读行为。

独立 PowerShell 脚本输出环境检测 JSON；当前配置的 TOML 解析及脱敏附件由应用后端生成。配置来自磁盘，不代表桌面端已经加载，也不包含输入框中尚未保存的修改。
