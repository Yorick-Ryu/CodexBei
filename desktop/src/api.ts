import { invoke as tauriInvoke } from "@tauri-apps/api/core";
export type Tool = "codex" | "claude";
export type Mapping = { opus?: string; sonnet?: string; haiku?: string };
export type Inspection = {
  hasOfficialCredentials?: boolean;
  mapping?: Mapping;
  file: string;
  testMode: boolean;
  baseUrl: string | null;
  model: string | null;
  hasKey: boolean;
  apiKey: string;
  modelChannel: "api" | "official";
  keepOfficialLogin: boolean;
  supportsWebsockets?: boolean;
  platform: string;
};
export type Backup = {
  id: string;
  file: string;
  created: string;
  kind: string;
  existed: boolean;
  baseUrl: string | null;
  keepOfficialLogin: boolean;
};
export type BackupPreview = Backup & {
  baseUrl: string | null;
  model: string | null;
  content: string | null;
};
export type Selection =
  | { mode: "auto" }
  | { mode: "installed"; id: string }
  | {
      mode: "manual";
      kind: "cli" | "desktop";
      runtimeVersion: string;
      appVersion?: string;
    };
export type Matching = {
  installations: {
    id: string;
    kind: string;
    runtimeVersion: string | null;
    appVersion?: string;
  }[];
  selection: Selection;
  template: { id: string; version: string; digest: string } | null;
  latestTemplate: { id: string; version: string; digest: string } | null;
  templateUpdateAvailable: boolean;
  offline: boolean;
  needsSelection: boolean;
  modelClientVersion: string | null;
};
export type Outcome = { canceled?: boolean; warning?: string };
export type DiagnosticReport = {
  schemaVersion: number;
  hasDotEnvProxy: boolean;
  configurations: { source: string; content: string }[];
  checks: { name: string; status: "ok" | "warning" | "info"; detail: string }[];
};
export type Connection = { apiKey: string; baseUrl: string; model: string };
export function installationLabel(v: { kind: string; runtimeVersion: string | null; appVersion?: string }) {
  if (v.kind === "claude") return `Claude Code · ${v.runtimeVersion || "未知"}`;
  if (v.kind === "cli") return `Codex CLI · ${v.runtimeVersion || "未知"}`;
  return `桌面版${v.appVersion ? ` ${v.appVersion}` : ""} · 内核 ${v.runtimeVersion || "未知"}`;
}
export type QuotaRow = { label: string; value: string; remaining?: number | null; resetAt?: number | null; resetPending?: boolean };
export type Quota = { channel: "api" | "official"; planType?: string | null; rows: QuotaRow[]; groups?: { id: number; title: string; expiresAt?: number; rows: QuotaRow[] }[] };
export function toolApi(tool: Tool) {
 const invoke = <T,>(command: string, args: Record<string, unknown> = {}) => tauriInvoke<T>(command, { ...args, tool });
 return {
  openWallet: () => invoke<void>("open_wallet"),
  quota: (channel: "api" | "official") => invoke<Quota>("quota", { channel }),
  windowsDiagnostics: (baseUrl: string) => invoke<DiagnosticReport>("windows_diagnostics", { baseUrl }),
  check: (selection: Selection | null = null, force = false) =>
    invoke<Matching>("check", { selection, force }),
  updateTemplate: () => invoke<Matching>("update_template"),
  models: (apiKey: string, baseUrl: string) =>
    invoke<string[]>("models", { apiKey, baseUrl }),
  inspect: () => invoke<Inspection>("inspect"),
  hasOfficialLogin: () => invoke<boolean>("has_official_login"),
  choose: () => invoke<Inspection>("choose"),
  openConfigFile: () => invoke<void>("open_config_file"),
  preview: (baseUrl: string, model: string, keepOfficialLogin: boolean, modelChannel: "api" | "official" | undefined, mapping?: Mapping) =>
    invoke<string>("preview", { baseUrl, model, keepOfficialLogin, modelChannel, mapping }),
  configure: (connection: Connection, keepOfficialLogin: boolean, mapping?: Mapping, modelChannel?: "api" | "official") =>
    invoke<Outcome>("configure", { connection, keepOfficialLogin, mapping, modelChannel }),
  switchChannel: (channel: "api" | "official") =>
    invoke<Outcome>("switch_channel", { channel }),
  switchTransport: (supportsWebsockets: boolean) =>
    invoke<Outcome>("switch_transport", { supportsWebsockets }),
  incoming: (keepOfficialLogin: boolean) =>
    invoke<null | Outcome>("incoming", { keepOfficialLogin }),
  backups: () => invoke<Backup[]>("backups"),
  backupPreview: (id: string) =>
    invoke<BackupPreview>("backup_preview", { id }),
  restore: (id: string) => invoke<Outcome>("restore", { id }),
  deleteBackup: (id: string) =>
    invoke<{ canceled?: boolean }>("delete_backup", { id }),
  openClaudeInstaller: () => invoke<void>("open_claude_installer"),
  openChatgptInstaller: (directDownload = false) => invoke<void>("open_chatgpt_installer", { directDownload }),
};

}
export const api = toolApi("codex");
export const incomingTool = () => tauriInvoke<Tool | null>("incoming_tool");
