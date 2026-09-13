# React 界面

通过 `src/api.ts` 调用经过校验的 Rust 命令；不读写本地文件、不存储密钥、不直接调用远端网关。
`src/App.tsx` 管理配置和历史记录，`src/VersionPicker.tsx` 管理版本选择，`src/theme.ts` 在窗口显示前设置主题。
设计约束见项目根目录 `DESIGN.md`，运行与测试入口见 `README.md`。
