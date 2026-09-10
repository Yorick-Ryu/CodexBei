// Browser-only visual fixture. This module is unreachable in production builds.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
mockWindows("main");
const installations = [{ id: "preview-desktop", kind: "desktop", runtimeVersion: "0.153.4", appVersion: "26.903.8094.0" }];
mockIPC(async (cmd, raw) => {
  const args = raw as Record<string, unknown>;
  if (cmd === "inspect") return {
    file: "C:\\Users\\Example\\.codex\\config.toml", testMode: true,
    baseUrl: "https://api.beiapi.cn/v1", model: "gpt-5.6-sol", hasKey: true,
    apiKey: "sk-preview-placeholder", modelChannel: "api", keepOfficialLogin: false, platform: "windows",
  };
  if (cmd === "check") return {
    installations, selection: { mode: "auto" }, template: { id: "preview", version: "1.0.0", digest: "preview" },
    latestTemplate: null, templateUpdateAvailable: false, offline: false, needsSelection: false, modelClientVersion: "0.153.4",
  };
  if (cmd === "models") return ["gpt-5.6-sol"];
  if (cmd === "preview") return `model_provider = "custom"\nmodel = "gpt-5.6-sol"\n\n[model_providers.custom]\nbase_url = "https://api.beiapi.cn/v1"\nwire_api = "responses"\nsupports_websockets = true\nexperimental_bearer_token = "（已隐藏）"`;
  if (cmd === "windows_diagnostics") {
    await new Promise(resolve => setTimeout(resolve, 650));
    return {
      schemaVersion: 1, hasDotEnvProxy: true,
      configurations: [{ source: "当前配置（示例）", content: 'model = "gpt-5.6-sol"\nmodel_provider = "custom"\n\n[model_providers.custom]\nbase_url = "https://api.beiapi.cn/v1"\nexperimental_bearer_token = "（已隐藏）"\nsupports_websockets = false\nhttp_headers = "（已隐藏）"' }], checks: [
        { name: "示例报告", status: "info", detail: "这是 Windows 界面热预览，未检测当前电脑。" },
        { name: "Codex .env", status: "warning", detail: "HTTPS_PROXY 指向本机端口 7890；端口不可连接。" },
        { name: "启动时覆盖代理", status: "warning", detail: "Codex 启动时会读取 .env，并可能覆盖终端代理变量。" },
        { name: "Windows 手动代理", status: "info", detail: "未启用；残留地址不代表代理启用。" },
        { name: "直连 HTTPS", status: "ok", detail: "HTTP 401：接口可达；未携带密钥，不代表对话认证成功。" },
        { name: "内核版本", status: "ok", detail: "内核可启动：0.153.4。" },
      ],
    };
  }
  if (cmd === "plugin:app|version") return "0.1.1-alpha.1";
  if (cmd === "plugin:updater|check") return new URLSearchParams(location.search).get("update") === "available"
    ? { rid: 42, currentVersion: "0.1.1-alpha.1", version: "0.2.0-preview", body: "红点展示用模拟更新，不会下载或安装。", rawJson: {} }
    : null;
  if (cmd === "plugin:updater|download") {
    const channel = args.onEvent as { onmessage: (message: unknown) => void };
    const emit = (message: unknown) => channel.onmessage(message);
    emit({ event: "Started", data: { contentLength: 100 } });
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 700));
      emit({ event: "Progress", data: { chunkLength: 10 } });
    }
    emit({ event: "Finished" });
    return 43;
  }
  if (cmd === "plugin:updater|install") { await new Promise(resolve => setTimeout(resolve, 2000)); return null; }
  if (cmd === "plugin:process|restart") { await new Promise(resolve => setTimeout(resolve, 1500)); location.replace("/?preview=windows"); return null; }
  if (cmd === "plugin:resources|close" || cmd === "incoming") return null;
  if (cmd === "backups") return [];
  if (cmd.startsWith("plugin:window|")) return null;
  void args;
  throw "界面预览不执行文件操作。";
}, { shouldMockEvents: true });
document.title = "CodexBei · Windows 界面热预览";
