# 应用自动更新

当前 0.1.1-alpha.1 已接入 Tauri 2 Updater。启动 5 秒后及运行期间每 4 小时检查，后台下载并验证签名；准备好后应用名旁出现红点。点击应用名进入“软件更新”，可手动检查或点击“重启更新”。配置、还原等操作进行时禁止安装。下载失败可重试，重启失败不会重复安装。

检查接口：`https://codexbei.beiapi.cn/updates/v1/{{target}}/{{arch}}/{{current_version}}`。
Worker 读取 [app-release.json](../remote/app-release.json)。`null` 表示尚未发布更新，返回 204；相同或更低版本、缺少当前平台产物也返回 204。模板更新接口独立保留。

公开下载页：<https://codexbei.beiapi.cn/downloads/>。安装包和更新包通过同一个 Worker 的静态资源托管，版本目录为 `/downloads/<版本>/`，不依赖 R2。线上是否已发布，以更新接口实际响应为准。

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

1. 预发布版本使用 SemVer 的 `0.1.x-alpha.N` / `0.1.x-beta.N`；正式版本去掉预发布后缀。每次构建必须同步提升 `package.json`、锁文件、`src-tauri/Cargo.toml`、Cargo 锁文件和 `tauri.conf.json` 的版本并重新构建。不要向同版本推送不同二进制。
2. 整理包含四个平台产物和 `SHA256SUMS` 的正式发布目录，运行 `node scripts/stage-app-downloads.cjs <发布目录> dist-downloads`。脚本只复制公开安装包、更新包和签名，生成下载页；拒绝覆盖同版本的不同文件。保留 `dist-downloads` 的所有旧版本目录，每次 Worker 部署会重新发布整个静态资源目录；在新机器上必须从已保存的发布目录重新整理所有已发布版本。
3. 将各平台最终产物及 `.update.json` 放在同一目录，准备更新元数据（只写本地文件，不上传）：

   `node scripts/prepare-app-release.cjs <产物目录> <HTTPS下载目录> <更新说明文件> <新JSON文件>`

   脚本检查各平台文件的 SHA-256 和签名文件是否仍匹配打包记录，自动合并 Mac / Windows 的平台信息，并拒绝混用不同版本。
4. 先保持旧更新清单不变，按 [远端部署说明](../remote/README.md) 发布静态资源；逐个下载公开文件并核对 SHA-256 后，再将新元数据放入 `remote/app-release.json`。执行 `npm run test:worker`、`npm run worker:check`，然后再次发布 Worker 启用更新。

出现问题可将清单回退为 `null` 并重新部署，暂停后续更新提示；保留静态资源目录。这不会降级已经安装的应用。

## 本地真实更新测试

用 Tauri 的 `--config` 覆盖文件将测试构建的 `version` 设为 `0.0.1`、`bundle.createUpdaterArtifacts` 设为 `false`，保留正式更新地址和公钥。将生成的 `.app` 复制到独立测试目录后运行，不要从开发模式的裸二进制或 DMG 只读卷测试替换安装。正式源码的版本号保持不变。

确认测试应用显示 0.0.1，等待更新准备好，点击“重启更新”；重启后确认版本、程序文件 SHA-256、代码签名及用户配置未变化。2026-09-09 的真实测试记录保存在本地 `artifacts/updater-live-20260909/e2e-result.json`，0.0.1 测试应用的恢复副本为同目录 `CodexBei-0.0.1-local-test.zip`。
