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
      configurations: [{ source: "当前配置（示例）", content: 'model = "gpt-5.6-sol"\nmodel_provider = "custom"\n\n[model_providers.custom]\nbase_url = "https://api.beiapi.cn/v1"\nexperimental_bearer_token = "（已隐藏）"\nsupports_websockets = false\nhttp_headers = { Authorization = "（已隐藏）", "x-client" = "codex" }' }], checks: [
        { name: "示例报告", status: "info", detail: "这是 Windows 界面热预览，未检测当前电脑。" },
        { name: "Codex .env", status: "warning", detail: "HTTPS_PROXY=http://127.0.0.1:7890; port=7890; tcp=UNREACHABLE" },
        { name: "Windows 手动代理", status: "info", detail: "ProxyEnable=0" },
        { name: "直连 HTTPS", status: "ok", detail: "GET https://api.beiapi.cn/v1/models; auth=NONE; HTTP 401; curl_exit=0; total=0.58s" },
        { name: "内核版本", status: "ok", detail: "version=0.153.4; exit=0" },
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
  if (cmd === "open_config_file") throw "当前为界面预览；Windows 应用会使用记事本打开所选配置文件。";
  if (cmd.startsWith("plugin:window|")) return null;
  void args;
  throw "界面预览不执行文件操作。";
}, { shouldMockEvents: true });
document.title = "CodexBei · Windows 界面热预览";
