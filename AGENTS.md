# CodexBei

## UI 开发

- 每次修改 UI 时，自动检查本项目的 dev 服务和桌面开发进程；已运行则复用，未运行则自动启动并打开开发窗口，无需再次询问。
- 默认在项目根目录运行 `npm run dev`。若本项目 Vite 已在 `127.0.0.1:1420` 正常运行而桌面开发进程未运行，使用 `npm run dev -- --config '{"build":{"beforeDevCommand":""}}'` 复用 Vite。
- 本应用有单实例限制；若已安装版本挡住开发版，正常退出本机已安装实例后启动开发版，并用进程路径确认运行的是 `src-tauri/target/debug/codexbei-desktop`。
- 修改后确认 dev 服务可访问、开发窗口已打开且最新 UI 已加载；不要重复启动或终止无关进程。
