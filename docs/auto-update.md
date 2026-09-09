# 应用自动更新

当前 0.1.0 已接入 Tauri 2 Updater。启动 5 秒后及运行期间每 4 小时检查，后台下载并验证签名；准备好后应用名旁出现红点。点击应用名进入“软件更新”，可手动检查或点击“重启更新”。配置、还原等操作进行时禁止安装。下载失败可重试，重启失败不会重复安装。

检查接口：`https://codexbei.beiapi.cn/updates/v1/{{target}}/{{arch}}/{{current_version}}`。
Worker 读取 [app-release.json](../remote/app-release.json)。`null` 表示尚未发布更新，返回 204；相同或更低版本、缺少当前平台产物也返回 204。模板更新接口独立保留。

## 签名和打包

- 更新私钥：`~/.codexbei/signing/updater/codexbei.key`（600，仓库外）。必须安全备份并在后续版本持续使用；对应公钥嵌入 `src-tauri/tauri.conf.json`。
- macOS 正式构建：`npm run build:mac:release -- --arm64`；Intel 使用 `--x64`，不带参数构建两种架构。
- 脚本生成 DMG、ZIP，以及最终公证并装订后的 `.app.tar.gz`、`.sig`、`darwin-*.update.json`。自动更新使用 tar.gz，不能替换成 DMG。
- 通用 `tauri build` 需要环境变量 `TAURI_SIGNING_PRIVATE_KEY` 指向同一私钥文件，按需设置密码；不要将私钥写进仓库或日志。
- Windows 使用 `npm run build:win`（签名环境同上），生成 NSIS 安装包和 `.sig`。更新签名与 Windows 发布者代码签名独立；本项目尚未配置 Windows 发布者证书。

Windows 原生构建由 `.github/workflows/build.yml` 手动触发，分别运行在 x64 和 ARM64 Windows 构建机上，执行 Rust 测试、Clippy、NSIS 安装与启动检查。构建机不持有更新私钥；下载私有仓库 Actions 产物后，在本机生成更新签名与元数据：

```sh
gh workflow run build.yml --ref <构建分支>
gh run download <运行ID> --dir <下载目录>
node scripts/finalize-windows-release.cjs <下载目录> <发布目录> <构建提交SHA>
```

最后一步核对原生验证报告、目标架构、构建提交和文件 SHA-256，然后生成 `.exe.sig` 与 `windows-*.update.json`。不会创建公开 Release 或修改线上更新清单。

## 后续发布

1. 新功能随首次 0.1.0 分发；后续更新必须同步提升 `package.json`、锁文件、`src-tauri/Cargo.toml`、Cargo 锁文件和 `tauri.conf.json` 的版本并重新构建。不要向同版本推送不同二进制。
2. 将正式更新产物上传到 HTTPS 下载目录，保留旧版本文件。每个架构都使用各自的包和签名。
3. 将各平台最终产物及 `.update.json` 放在同一目录，准备更新元数据（只写本地文件，不上传）：

   `node scripts/prepare-app-release.cjs <产物目录> <HTTPS下载目录> <更新说明文件> <新JSON文件>`

   脚本检查各平台文件的 SHA-256 和签名文件是否仍匹配打包记录，自动合并 Mac / Windows 的平台信息，并拒绝混用不同版本。
4. 验证所有下载 URL 可用后，将元数据放入 `remote/app-release.json`，执行 `npm run test:worker`、`npm run worker:check`，再按 [远端部署说明](../remote/README.md) 显式发布 Worker。

首次接入时保持清单为 `null`，不会对外发布安装包，也不会向现有用户推送更新。出现问题可将清单回退为 `null` 暂停后续更新提示；这不会降级已经安装的应用。
