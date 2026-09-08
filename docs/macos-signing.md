# macOS 签名与公证

正式构建入口：`npm run build:mac:release`，默认输出 Apple Silicon 和 Intel 的 DMG / ZIP 到 `dist-release/`；可追加 `-- --arm64` 或 `-- --x64`。

脚本固定使用个人团队 `HYB659G8FH` 的 Developer ID Application 证书，并强制签名、公证。证书、私钥或公证凭据不可用时直接停止，不生成冒充正式版的未签名包。

Electron 的 `*.lproj/locale.pak` 是语言数据，由所属 Framework 的资源签名封印保护，不单独作为可执行文件签名。发布目录与本地测试目录分开，公证期间不要覆盖发布目录中的应用。

检查本机签名身份：

```sh
security find-identity -v -p codesigning
```

公证凭据仅存系统钥匙串，配置名为 `codexbei-notary`。在 Apple 账户中生成专用密码，然后在本机终端执行下面的命令，将邮箱替换为该个人团队的 Apple 账户邮箱；在隐藏输入提示中粘贴专用密码，不把密码写入命令、项目或聊天。

```sh
xcrun notarytool store-credentials codexbei-notary --apple-id '你的 Apple 账户邮箱' --team-id HYB659G8FH
```

验证保存后的凭据：

```sh
xcrun notarytool history --keychain-profile codexbei-notary
```

证书及本机私钥备份位于 `~/.codexbei/signing/HYB659G8FH/`，不随安装包分发；换机器时需安全迁移证书与私钥。签名完成后，不要再修改应用包。仅有签名、不含公证的本地测试包不能视为完成正式分发验证。
