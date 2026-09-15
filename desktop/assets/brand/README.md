# CodexBei 品牌图标

- `codexbei.svg`：应用图标母版，沿用 `../agents/codex.svg` 的云朵轮廓，将终端符号替换为中文“北”。轮廓来源及 MIT 授权见 `../agents/README.md` 和 `../agents/LICENSE`。
- “北”字使用 Hiragino Sans GB W6 转为矢量轮廓，显示时不依赖本机字体。
- 桌面图标使用单层白色圆角底板、蓝色渐变云朵与白色“北”，云朵带轻微阴影。窗口中的标识省略底板，在深浅主题下均保持蓝色云朵与白字。产品标签页继续使用各自原始图标。
- 执行 `npm run build:icons`，使用 Tauri 图标工具从带底板的 `app-icon.svg` 生成 `src-tauri/icons/`，同步 `build/icon.icns` 和 `build/icon.ico`。
- `app-icon-dark.svg` 是纯黑底预览；浅色底板为纯白。两者以及 `CodexBei.icon/Assets/cloud.png` 从浅色母版通过 `npm run build:icons` 同步生成。
- `CodexBei.icon` 提供 macOS 26 及更新系统的原生默认 / 深色外观，使用 `system-light` / `system-dark` 背景渐变，保留蓝色云朵和白色“北”，开启玻璃、镜面高光和中性投影。背景保留黑白基调，渲染含灰阶和边缘反光；纯黑 / 纯白 SVG 仅用于平面预览。用户选择图标外观“自动”时跟随系统深浅模式，固定外观、透明或染色选项遵循系统设置。
- macOS 构建自动运行 `scripts/build-macos-icon.cjs`，需要 Xcode 26 或更新版本并完成首次启动安装。`actool` 生成的 `Assets.car`、兼容旧系统的 `CodexBei.icns` 在签名前打包，`Info.macos.plist` 指定原生图标名称。macOS 13–15 使用兼容静态图标，不支持这套系统原生外观切换。Windows 打包流程不变。
- `logo-north.svg` 保留为网站原始标识参考，来源为 BeiAPI 网站 `/api/status` 的 `logo` 字段；不再用于桌面应用。
