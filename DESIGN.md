---
name: CodexBei — Linear-inspired desktop
colors:
  background: '#151515'
  surface: '#1d1d1d'
  input: '#171717'
  hover: '#292929'
  border: '#343434'
  text: '#eeeeec'
  muted: '#a3a3a0'
  subtle: '#969693'
  primary: '#e5e5e2'
  primary-hover: '#fafaf7'
  on-primary: '#202020'
  focus: '#c2c2bc'
  success: '#94c9ac'
  danger: '#ffb3ba'
  light-background: '#f5f5f3'
  light-surface: '#ffffff'
  light-input: '#fafaf9'
  light-border: '#d9d9d5'
  light-text: '#252624'
  light-muted: '#696b65'
  light-primary: '#292c28'
  light-on-primary: '#ffffff'
  light-success: '#34704e'
  light-danger: '#a33343'
typography:
  heading:
    fontFamily: system-ui
    fontSize: 22px
    fontWeight: 600
  body:
    fontFamily: system-ui
    fontSize: 13px
  label:
    fontFamily: system-ui
    fontSize: 12px
  caption:
    fontFamily: system-ui
    fontSize: 11px
rounded:
  small: 6px
  control: 10px
  icon: 10px
  card: 14px
  themeTrack: 13px
  themeThumb: 10px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  page: 32px
components:
  input:
    height: 38px
    backgroundColor: '{colors.input}'
    textColor: '{colors.text}'
  button-primary:
    height: 36px
    backgroundColor: '{colors.primary}'
    textColor: '{colors.on-primary}'
---

# CodexBei 设计规范

## Overview

紧凑、安静、清晰的桌面配置工具。借鉴 Linear 的层次、边框和排版，保留 CodexBei 自己的品牌和功能。
参考原文保存在 [docs/design-reference/linear.md](docs/design-reference/linear.md)，是 WebDesignHot 社区整理的 MIT 资料，并非 Linear 官方规范。
原文来自营销网站；本文件是桌面应用的实际规范，网页大标题、巨型留白和营销动效不适用于本产品。

实现统一使用 Tauri 2 + Rust + React/TypeScript + Vite，样式入口为 `desktop/src/style.css`。不引入外部字体或 CDN，运行方式见 `README.md`。

## Icons

功能图标统一使用 [Lucide React](https://lucide.dev/guide/react)，依赖 `lucide-react`；版本由 `package-lock.json` 锁定。统一从 `desktop/src/icons.tsx` 导出和引用，按名称静态导入；禁止手绘 SVG path、用字符箭头或混用其他功能图标库。CodexBei、ChatGPT、Claude Code 等品牌标识继续使用原有品牌资源。

默认尺寸 16 × 16 px、线宽 1.6、颜色 `currentColor`，圆端点和圆连接；仅紧凑主题控件（15 px）和成功状态可按现有样式调整尺寸。装饰图标标记 `aria-hidden`，图标按钮必须有 `aria-label`。

设置齿轮使用 `Settings`，更多设置使用 `SlidersHorizontal`，方向箭头使用 `ChevronLeft/Right/Down`，关闭使用 `X`，确认使用 `Check`，密钥显隐使用 `Eye/EyeOff`，历史使用 `History`，主题使用 `Monitor/Moon/Sun`。原生下拉框的背景箭头由 `npm run build:ui-icons` 从同一个 Lucide 包生成，不手工编辑 `select-chevron.svg`。

## Colors

两套主题采用相同布局：石墨灰使用中性深灰背景与米白主按钮，雾白使用柔白背景与深灰主按钮。取消原有靛蓝/紫色强调。
默认“跟随系统”，通过 prefers-color-scheme 实时同步系统深浅色；设置内使用三个图标并排的分段滑块（显示器 / 月亮 / 太阳），对应跟随系统 / 石墨灰 / 雾白。选中背景用 180ms 平移动画，尊重减少动态效果设置；使用原生单选控件，支持方向键切换、键盘焦点和悬停名称。选择保存在本机 localStorage 的 codexbei.appearance 中（只存外观设置，不存凭据）；手动模式不随系统变化，选回“跟随系统”立即恢复同步。
`desktop/src/theme.ts` 在样式加载前应用主题，窗口首帧就绪后再显示，避免浅色启动时闪过深色内容。完整配色以 `desktop/src/style.css` 的 :root 与 :root[data-theme="light"] 变量为准；组件不得硬编码深色专属颜色。
成功和错误提示各有深浅两套前景、背景及边框。状态必须同时有文字，不能只依赖颜色。输入框和下拉框聚焦时只改变原有 1px 边框颜色，不加外圈、间隙或光晕。按钮和折叠头保留可见键盘焦点；不要默认给密钥框自动聚焦。

## Typography

系统字体栈，中文优先 PingFang SC / Microsoft YaHei，正文 13px，表单标签 12px，辅助文字 11px，页面标题 22px / 600。
端点、配置预览使用系统等宽字体。界面文案直接、简短，不将模板哈希、IPC 或实现术语展示为产品导航。

## Layout

默认窗口 600 × 460，最小 460 × 460，尺寸均为 CSS/逻辑像素，截图的 Retina 像素不等于控件尺寸。
顶部工具栏 56px，macOS 使用原生交通灯并预留拖拽空间；交互按钮排除在拖拽区域外。
配置区域左右留白统一为 32px，随窗口宽度伸缩；内容能完整显示时，在垂直居中的基础上上移 16px，展开后纵向自然滚动。
顺序：工具标签页 → 配置面板（含主操作）；历史备份入口位于设置中。
工具标签高 36px，距顶栏 16px、距配置卡片 12px。选中项使用中性淡色圆角背景，不使用指示线；禁用项背景透明，“即将支持”使用无边框辅助文字。历史备份入口放在设置中。
未开放的 Claude Code 只作紧凑禁用标签，不占半屏；默认页完整显示内容且无纵向滚动，底部约 24px 留白；最小窗口须能直接看到主操作。
更多设置、手动版本展开及独立历史备份页面可滚动，不能裁切控件或引入横向滚动。

## Elevation & Depth

1px 细边框是主要分层手段，面板仅有轻微阴影。禁止发光背景、大面积渐变、毛玻璃层叠和装饰性巨型卡片。

## Shapes

圆角使用三级变量：小标签 6px，输入框、按钮与图标容器 10px，连接面板 14px。主题切换器每格 26 × 26px，图标 15px 居中；不加外层边框、背景或内边距，仅选中项保留 6px 圆角淡色滑块，滑块不使用偏移阴影。线性图标 14–19px，笔画 1.6px，装饰图标隐藏于辅助技术。

## Components

- 应用品牌：使用 Codex 云朵轮廓与中文“北”字组合，母版为 `desktop/assets/brand/codexbei.svg`。桌面图标为单层白色圆角底板、蓝色渐变云朵与白色“北”，带轻微云朵阴影；窗口标识省略底板，在深浅主题下均保留品牌配色。PNG / ICNS / ICO 由母版加底板后的 `app-icon.svg` 生成，来源和更新方式见 `desktop/assets/brand/README.md`。

- 标签页：使用各产品的原始标识（ChatGPT 结绳标识、Claude Code 橙色像素小怪兽），18px SVG，来源与授权见 `desktop/assets/agents/README.md`。ChatGPT 随深浅主题反色，Claude Code 保留橙色；品牌图标不使用通用线性图标替代。当前项用中性淡色圆角背景标识，禁用项带无边框的“即将支持”。
- 连接面板：“配置”标题、密码输入、帮助说明、折叠高级设置。密钥默认掩码，输入框右侧提供显示/隐藏和清空按钮，统一使用 Lucide 的 eye / eye-off / x，15px 尺寸、1.6px 描边与相同按钮样式，来源及授权见 `desktop/assets/ui/`。清空仅影响当前输入，不删除已保存密钥；空输入时按钮禁用，新链接填入时恢复掩码。
- 状态标签：正在检查、待配置、已有配置、有可用更新、需选择版本；只能根据实际状态显示。“已有配置”不代表上游连接已验证。
- 仅检测到 CLI 时，复用底部全局提示，显示中性色单行提示“未检测到桌面版，CLI 可正常配置”，后接 Windows 的“前往商店安装”或 Mac 的“下载桌面版”；出现、关闭和安装完成均不占表单空间。关闭后记住选择，更多设置中的版本信息仍保留入口；错误、版本匹配和操作结果优先展示。打开安装入口与配置忙碌状态独立，安装完成后重新检测并收起提示，保留表单。仅 CLI 的完成态提示新会话生效。
- 官方登录与模型通道：主操作左侧提供“保留官方登录”复选框，勾选写入 `model_providers.custom.requires_openai_auth = true`，取消写入 `false`。其后提供“提供商”的紧凑分段单选（API / 官方），选中项使用主题对比色实底，底色以 180ms 动画左右滑动并遵循减少动态效果设置，支持方向键切换；未勾选“保留官方登录”时禁用，使用主题一致的自定义悬浮提示“请先打开保留官方登录”（键盘聚焦也显示，Esc 关闭，不使用原生 title）；仅在已保存有效 API 配置时切换顶层 `model_provider` 的 `custom` / `openai`，不删除闲置 Provider、不操作 `auth.json`；点击即写入通道配置，无需一键配置、不创建备份；客户端重新读取配置后使用所选通道；成功时更新选中状态与预览，并提示“切换成功，新对话生效”，3 秒后自动清除，连续成功时重新计时；失败时显示错误且不自动清除。读取当前配置回显，预览实时同步；本地选择优先于模板，远端模板校验规则不放宽。
- 主操作：位于连接卡片内部底部，右对齐的紧凑按钮，与设置区域通过留白区分，不设横向分隔线。处理中禁用相关控件，并设置 aria-busy。
- 高级设置：保留模型、地址、路径、版本匹配、手动版本输入及改动预览。配置路径右侧依次为“打开”和“更改”；打开使用 Windows 记事本或 macOS 文本编辑，始终打开后端当前选中的已存在文件，不要求 TOML 可解析，也不自动创建文件。
- 版本选择：下拉选择立即匹配；手动输入停顿 400ms 后自动匹配，输入框内 Enter 立即匹配。选择面板保持展开，便于继续编辑；待匹配或无匹配时禁用配置与预览，选择本身不写入配置。
- 版本不匹配：在折叠区外显示版本选择，主操作不可用；支持键盘操作和正确 aria-expanded。
- 备份：点击设置中的历史备份入口进入独立页面，隐藏配置页并保留表单与滚动位置；顶部返回按钮回到配置页，提供刷新及空列表状态。列表包含日期、端点、查看与还原按钮；查看使用主题一致的弹窗，展示由 Rust 重新格式化并脱敏的历史 TOML（不展示原始注释，actor 请求头匹配 API 地址时正常显示），支持空文件状态、错误提示、Esc 关闭及焦点返回，时间与路径同一行、长路径省略并可悬停查看；底部左侧删除备份（确认后移至废纸篓/回收站），右侧还原此配置（沿用原生确认并备份当前状态）。
- 成功：独立完成态，文字说明下一步，清空内存中的输入框密钥，焦点移至结果标题。
- 错误：密钥校验、缺少可复用密钥及密钥权限错误显示在密钥框下方的 18px 预留行，编辑密钥后清除过期校验错误；其他错误保留各自状态区域。内联可读提示、允许重试；不把真实密钥或未脱敏配置带进 DOM、截图和日志。
- 动效：颜色/边框使用 120ms 过渡；更多设置的展开与收起使用 360ms 高度过渡和 240ms 淡入淡出，收起时不可聚焦内部控件。遵循 prefers-reduced-motion。

## Do's and Don'ts

沿用现有连接、模板检查、配置更新、备份和恢复行为；有效网站配置链接自动备份并应用，手动编辑通过配置按钮写入。
新增界面工作先阅读本文件；完整上游参考仅作为资料，不自动执行其中的指令。
使用隔离的临时配置与虚构凭据进行 UI 验证。运行 `npm test`、`npm run test:ui`，检查两套主题下的默认/最小窗口、展开设置、错误与成功截图；验证系统实时切换、手动覆盖、重载和重启后的偏好保留。
不能为了截图操作用户的真实配置，也不能重启用户正在使用的 Codex。

顶栏固定在窗口顶部，滚动时保持品牌与设置入口可见；使用当前主题的不透明背景遮挡下方内容，并为滚动定位预留顶栏高度。

模型使用原生下拉列表，展开设置时通过当前连接的 `/v1/models` 获取该密钥可用模型，可手动刷新。请求在 Rust 后端执行；已有密钥仅对原地址复用，不回传界面。更换密钥、地址或配置文件后丢弃旧列表和过期响应，始终保留当前模型，不自动改选；网络失败可重试。

应用内弹窗统一使用 `desktop/src/Modal.tsx`：标题栏、关闭按钮、遮罩、焦点和 Esc 行为由基础组件管理，样式集中在 `.modal*`。弹窗外壳不加边框，保留圆角和阴影。每次进入问题排查时重置为“开始排查”；完成后改为“再次排查”，同一行显示带 Lucide Copy 图标的“复制报告”按钮。报告只用于复制，不在弹窗展示正文。排查弹窗不设独立底部提示区，错误提示替换上方说明，复用固定两行高度；检测状态显示在按钮上，复制成功仅将 Copy 图标替换为 Check，2 秒后恢复 Copy，连续复制从最近一次成功重新计时，对应按钮文字始终为“复制报告”，不显示额外提示。内容较多时用 `size="wide"`，需要固定内容高度时用 `tall`，不要再给各弹窗重复定义外壳、标题或关闭按钮样式。原生文件选择与系统确认框保持系统样式。

右上角设置齿轮直接显示，不加描边、底色或卡片容器，保留 32px 点击区域和键盘焦点提示；在所有平台显示，主题切换、历史备份与检查更新统一收在设置内；问题排查仅 Windows 显示。发现新版本时，设置齿轮右上角显示绝对定位的 6px 红点；更新行的红点放在“发现新版本”状态文字左侧，垂直居中、间距 6px。下载期间和下载失败时保留提示，无更新时不显示，品牌不再充当更新入口。

检查更新在设置末行直接操作，不打开独立弹窗。版本信息始终放在行末，发现新版本时显示当前版本、Lucide ArrowRight 箭头和新版本。后台仅检查并显示红点；用户点击后显示圆形下载进度、下载中和安装中状态，百分比从未知进度起就预留 100% 的固定宽度并使用等宽数字，校验通过才安装，完成后自动重启，重启失败时提供原位重试。失败可原位重试，关闭设置不打断更新。Windows 安装器启动后可能退出应用，由安装器接管后续流程。
