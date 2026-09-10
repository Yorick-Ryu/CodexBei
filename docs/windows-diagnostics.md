# Windows 问题排查

右上角 **设置** → **问题排查** → **开始排查**（仅 Windows 显示）。每次进入先显示“开始排查”，完成后显示“再次排查”和“复制报告”。报告只在本机生成，不在弹窗展示正文，可复制给支持人员。应用内报告附带当前所选的已保存配置；与默认位置不同时还附默认配置。密钥、请求头、路径、注释、自定义字符串和命令等在 Rust 后端脱敏后才进入界面。无法解析的文件不附原文。扫描不会更改配置、代理、注册表，也不发送密钥或模型请求。

独立运行（Windows PowerShell 5.1 或 PowerShell 7）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-diagnostics.ps1 -BaseUrl https://api.beiapi.cn/v1
```

`-ConfigPath` 可指定要检查的配置文件位置；`.env` 始终按当前进程的 `CODEX_HOME`（否则 `%USERPROFILE%\.codex`）定位，不跟随任意所选 TOML 文件。

检查范围：`.env` 代理赋值、进程/用户/系统环境变量、手动代理和 PAC 配置、WinHTTP 默认代理、明确的本机代理端口、curl 直连/默认 HTTPS（含耗时），以及常见安装路径中的 `codex.exe --version`。不打印环境变量原值、API Key、请求头、完整配置或原始命令错误。每个子进程有超时，应用内整体上限 55 秒。

- `.env` 会在 Codex 启动时重新注入变量；清除终端代理不一定有效。
- `ProxyEnable=0` 时，残留 `ProxyServer` 不能证明代理启用。WinHTTP 默认直连也不能排除 PAC 或环境变量。
- 未带密钥的 HTTP 401 表示接口可达，不代表认证、模型、WebSocket 或对话成功。curl 路由也不等于 Codex 路由。
- `.env` 的代理检测是静态赋值扫描，不执行变量展开；重复赋值、复杂多行内容需打开文件核实。只探测明确的 loopback 端口，其他代理值一律隐藏。

纯检测：不提供备份、打开文件、自动修复或设置修改操作。报告只给出核查建议。

开发验证：`powershell.exe -NoProfile -File test/windows-diagnostics.test.ps1`；Windows x64/ARM64 构建流程分别执行 PowerShell 5.1/7 测试。UI 测试模拟 IPC，不能替代 Windows 原生验收。正式发布仍需在代理软件关闭、`.env` 指向失效端口的隔离 Windows 环境验证报告与只读行为。

独立 PowerShell 脚本输出环境检测 JSON；当前配置的 TOML 解析及脱敏附件由应用后端生成。配置来自磁盘，不代表桌面端已经加载，也不包含输入框中尚未保存的修改。
