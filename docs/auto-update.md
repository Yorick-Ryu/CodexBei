# 应用自动更新

客户端使用 Tauri 2 Updater。启动 5 秒后及运行期间每 4 小时检查，后台下载并验证签名；准备好后应用名旁出现红点。点击应用名进入“软件更新”，可手动检查或点击“重启更新”。配置、还原等操作进行时禁止安装。下载失败可重试，重启失败不会重复安装。

检查接口：`https://codexbei.beiapi.cn/updates/v1/{{target}}/{{arch}}/{{current_version}}`。
Worker 读取独立 R2 bucket `codexbei-releases` 的 `releases/current.json`。同版本、更低版本或缺少当前平台产物返回 204；存储未初始化或读取失败返回 503。模板更新接口独立保留。

公开下载页：<https://codexbei.beiapi.cn/downloads/>。Worker 从 R2 流式返回安装包和更新包，版本地址仍为 `/downloads/<版本>/`，支持 HEAD、ETag 和 Range。下载页、latest 链接及更新接口使用同一份最新版指向；Worker 代码部署不携带安装包，也不改变最新版。线上是否已发布，以更新接口实际响应为准。

## 签名和打包

- 更新私钥：`~/.codexbei/signing/updater/codexbei.key`（600，仓库外）。必须安全备份并在后续版本持续使用；对应公钥嵌入 `src-tauri/tauri.conf.json`。
- macOS 正式构建：`npm run build:mac:release -- --arm64`；Intel 使用 `--x64`，不带参数构建两种架构。
- 脚本生成 DMG、ZIP，以及最终公证并装订后的 `.app.tar.gz`、`.sig`、`darwin-*.update.json`。自动更新使用 tar.gz，不能替换成 DMG。
- 通用 `tauri build` 需要环境变量 `TAURI_SIGNING_PRIVATE_KEY` 指向同一私钥文件，按需设置密码；不要将私钥写进仓库或日志。
- Windows 使用 `npm run build:win`（签名环境同上），生成 NSIS 安装包和 `.sig`。更新签名与 Windows 发布者代码签名独立；本项目尚未配置 Windows 发布者证书。

Windows 原生构建由 `.github/workflows/build.yml` 手动触发，分别运行在 x64 和 ARM64 Windows 构建机上，执行 Rust 测试、Clippy、NSIS 静默安装、版本和架构检查；使用 `-SkipUi` 跳过应用启动及窗口检查。构建机不持有更新私钥；下载私有仓库 Actions 产物后，在本机生成更新签名与元数据：

```sh
gh workflow run build.yml --ref <构建分支>
gh run download <运行ID> --dir <下载目录>
node scripts/finalize-windows-release.cjs <下载目录> <发布目录> <构建提交SHA>
```

最后一步核对安装验证报告、目标架构、版本、构建提交和文件 SHA-256，然后生成 `.exe.sig` 与 `windows-*.update.json`。不会创建公开 Release 或修改线上更新清单。

## 存储与首次迁移

`APP_RELEASES` 绑定独立 bucket `codexbei-releases`，与官方应用镜像分开。发布脚本使用限于该 bucket 的 R2 S3 凭据，JSON 字段为 `accountId`、`accessKeyId`、`secretAccessKey`（可选 `sessionToken`）；文件放仓库外且权限为 600。Cloudflare Worker 部署令牌仍独立使用，不写入源码或日志。

本机发布使用 [Cloudflare 令牌索引](../../docs/cloudflare.md) 中已有的 beiapi.cn 令牌按次申请临时 R2 凭据，无需用户提供长期 S3 密钥。先调用 `GET /user/tokens/verify`，将返回的 `id` 作为 `parentAccessKeyId`，再调用 `POST /accounts/<账户ID>/r2/temp-access-credentials`，指定 `bucket: codexbei-releases`、`permission: object-read-write`、`ttlSeconds: 7200`；账户 ID 从 `wrangler.jsonc` 读取。将响应凭据与账户 ID 保存到 `~/.codexbei/publishing/` 下权限为 600 的临时 JSON，验证可以读取 `releases/current.json` 后使用，发布完成后删除临时文件。该目录不保存长期凭据。

首次切换前，先创建 bucket，并从线上下载清单、已发布归档核对全部历史版本和 SHA-256；不能用本机现存目录推断历史完整性。保持旧 Worker 在线，先上传历史文件和当前线上版本，再把 R2 指向设为当前线上版本，最后部署新 Worker。迁移过程中不发布新客户端版本。

- 当前线上版本使用下方完整上传流程，保留原始更新地址、签名和发布时间；[app-release.json](../remote/app-release.json) 仅作旧静态部署的迁移基线，不再控制线上版本。
- 更早、没有四平台更新元数据的版本，使用 `node scripts/import-legacy-downloads.cjs <版本> <旧公开文件目录> --credentials-file <R2凭据文件> --apply`。目录必须有 `SHA256SUMS`；只导入校验通过的公开文件，不切换最新版、不删除远端文件。不带 `--apply` 只验证本地。
- 新 Worker 的部署脚本检查 R2 当前指向、原线上版本及其文件；迁移缺失时拒绝部署。首次切换还须逐项核对历史下载清单，包含比迁移基线更早的版本。切换前保存旧 Worker 版本，供服务回滚。

## 后续发布

1. 正式版本使用 `0.1.5` 等稳定版本号。同步 `package.json`、锁文件、`src-tauri/Cargo.toml`、Cargo 锁文件、`tauri.conf.json` 和 macOS `bundleVersion` 后重新构建。不要向同版本推送不同二进制。
2. 整理四个平台签名产物、`.update.json` 和 `SHA256SUMS`。准备一次元数据并保存，重试时沿用该文件：

   `node scripts/prepare-app-release.cjs <产物目录> https://codexbei.beiapi.cn/downloads/0.1.5/ <更新说明文件> <新JSON文件>`

3. 上传该版本，逐个读回校验 SHA-256，最后写入不可变的 `releases/<版本>.json`。成功后仍不改变线上版本：

   `node scripts/publish-app-release.cjs upload <产物目录> <新JSON文件> --credentials-file <R2凭据文件> --apply`

   不带 `--apply` 仅本地校验。相同内容跳过，已有路径内容不同则拒绝覆盖；中断后可用同一批文件重试。下载页资源也按版本或内容哈希存储，不依赖持久的本地 `dist-downloads`。
4. 校验通过后单独切换最新版指向。首次初始化使用 `--expected-version none`，后续必须填写实际旧版本：

   `node scripts/publish-app-release.cjs activate 0.1.5 --expected-version 0.1.4 --credentials-file <R2凭据文件> --apply`

   激活前重新校验全部文件；以 ETag 条件写入单个指向，拒绝并发覆盖。不带 `--apply` 只读取和校验。仅发客户端版本时无需重新部署 Worker。

回滚：用 `activate <旧版本> --expected-version <当前版本> --rollback --credentials-file <R2凭据文件> --apply`。只恢复下载页、latest 链接和更新清单，保留所有版本文件；不会降级已经安装的客户端。下载页面内容也属于版本快照，同版本不能替换。

Worker 代码或模板变更仍按 [远端部署说明](../remote/README.md) 发布，与上述应用版本激活独立。

## 本地真实更新测试

用 Tauri 的 `--config` 覆盖文件将测试构建的 `version` 设为 `0.0.1`、`bundle.createUpdaterArtifacts` 设为 `false`，保留正式更新地址和公钥。将生成的 `.app` 复制到独立测试目录后运行，不要从开发模式的裸二进制或 DMG 只读卷测试替换安装。正式源码的版本号保持不变。

确认测试应用显示 0.0.1，等待更新准备好，点击“重启更新”；重启后确认版本、程序文件 SHA-256、代码签名及用户配置未变化。2026-09-09 的真实测试记录保存在本地 `artifacts/updater-live-20260909/e2e-result.json`，0.0.1 测试应用的恢复副本为同目录 `CodexBei-0.0.1-local-test.zip`。
