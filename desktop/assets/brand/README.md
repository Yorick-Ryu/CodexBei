# CodexBei 品牌图标

- `codexbei.svg`：应用图标母版，沿用 `../agents/codex.svg` 的云朵轮廓，将终端符号替换为中文“北”。轮廓来源及 MIT 授权见 `../agents/README.md` 和 `../agents/LICENSE`。
- “北”字使用 Hiragino Sans GB W6 转为矢量轮廓，显示时不依赖本机字体。
- 桌面图标使用单层白色圆角底板、蓝色渐变云朵与白色“北”，云朵带轻微阴影。窗口中的标识省略底板，在深浅主题下均保持蓝色云朵与白字。产品标签页继续使用各自原始图标。
- 执行 `npm run build:icons`，使用 Tauri 图标工具从带底板的 `app-icon.svg` 生成 `src-tauri/icons/`，同步 `build/icon.icns` 和 `build/icon.ico`。
- `logo-north.svg` 保留为网站原始标识参考，来源为 BeiAPI 网站 `/api/status` 的 `logo` 字段；不再用于桌面应用。
