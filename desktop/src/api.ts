import { invoke } from "@tauri-apps/api/core";
export type Inspection = {
  file: string;
  testMode: boolean;
  baseUrl: string | null;
  model: string | null;
  hasKey: boolean;
  apiKey: string;
  modelChannel: "api" | "official";
  keepOfficialLogin: boolean;
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
  if (v.kind === "cli") return `CLI · ${v.runtimeVersion || "未知"}`;
  return `桌面版${v.appVersion ? ` ${v.appVersion}` : ""} · 内核 ${v.runtimeVersion || "未知"}`;
}
export const api = {
  windowsDiagnostics: (baseUrl: string) => invoke<DiagnosticReport>("windows_diagnostics", { baseUrl }),
  check: (selection: Selection | null = null, force = false) =>
    invoke<Matching>("check", { selection, force }),
  updateTemplate: () => invoke<Matching>("update_template"),
  models: (apiKey: string, baseUrl: string) =>
    invoke<string[]>("models", { apiKey, baseUrl }),
  inspect: () => invoke<Inspection>("inspect"),
  choose: () => invoke<Inspection>("choose"),
  preview: (baseUrl: string, model: string, keepOfficialLogin: boolean, modelChannel: "api" | "official") =>
    invoke<string>("preview", { baseUrl, model, keepOfficialLogin, modelChannel }),
  configure: (connection: Connection, keepOfficialLogin: boolean) =>
    invoke<Outcome>("configure", { connection, keepOfficialLogin }),
  switchChannel: (channel: "api" | "official") =>
    invoke<Outcome>("switch_channel", { channel }),
  incoming: (keepOfficialLogin: boolean) =>
    invoke<null | Outcome>("incoming", { keepOfficialLogin }),
  backups: () => invoke<Backup[]>("backups"),
  backupPreview: (id: string) =>
    invoke<BackupPreview>("backup_preview", { id }),
  restore: (id: string) => invoke<Outcome>("restore", { id }),
  deleteBackup: (id: string) =>
    invoke<{ canceled?: boolean }>("delete_backup", { id }),
  openChatgptInstaller: () => invoke<void>("open_chatgpt_installer"),
};
