import { Modal } from "./Modal";
import { useState, type ReactNode } from "react";
import { ChevronRightIcon, GearIcon } from "./icons";
import { api, type DiagnosticReport } from "./api";

export function AppSettings({ baseUrl, theme, isWindows, updateAvailable, updateRow }: {
  baseUrl: string;
  theme: ReactNode;
  isWindows: boolean;
  updateAvailable: boolean;
  updateRow: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<"settings" | "diagnostics">("settings");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [message, setMessage] = useState("");
  const run = async () => {
    setBusy(true);
    setReport(null);
    setMessage("");
    try { setReport(await api.windowsDiagnostics(baseUrl)); }
    catch (error) { setMessage(typeof error === "string" ? error : "排查未完成，请重试。"); }
    finally { setBusy(false); }
  };
  const text = report ? [
    "CodexBei 问题排查报告",
    "检测结果",
    ...report.checks.map(row => `[${{ ok: "通过", warning: "需检查", info: "说明" }[row.status]}] ${row.name}：${row.detail}`),
    "当前配置信息（已脱敏；来自磁盘已保存文件，不包含未保存的修改）",
    ...(report.configurations || []).map(config => `${config.source}\n\n${config.content}`),
  ].join("\n\n") : "";
  return <>
    <button type="button" className="settings-entry" aria-label="设置" title={updateAvailable ? "设置 · 有新版本" : "设置"} onClick={() => { setSection("settings"); setOpen(true); }}>
      <GearIcon />
      {updateAvailable && <span className="software-update-dot" role="img" aria-label="有新版本" />}
    </button>
    <Modal open={open} onClose={() => setOpen(false)} closeLabel="关闭"
      title={section === "settings" ? "设置" : "问题排查"} size={section === "settings" ? "default" : "wide"}>
      <div hidden={section !== "settings"}>
        <div className="settings-list">
          <div className="settings-theme-row"><span>外观主题</span>{theme}</div>
          {isWindows && <button type="button" className="settings-diagnostic-row" onClick={() => setSection("diagnostics")}>
            <span>问题排查</span><ChevronRightIcon />
          </button>}
          {updateRow}
        </div>
      </div>
      {section === "diagnostics" && <>
      <p>遇到对话一直重连、无法对话或回复慢？排查后可复制报告，发给客服协助处理。</p>
      <div className="diagnostic-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void run()}>{busy ? "正在排查…" : report ? "重新排查" : "开始排查"}</button>
      </div>
      {busy && <p role="status">正在检测，请稍候…</p>}
      {report && <>
        <textarea className="diagnostic-report" aria-label="脱敏排查报告" readOnly value={text} />
        <div className="diagnostic-actions">
          <button type="button" className="secondary" onClick={async () => {
            try { await navigator.clipboard.writeText(text); setMessage("已复制脱敏报告。"); }
            catch { setMessage("复制失败，请在报告框中全选并复制。"); }
          }}>复制报告</button>
        </div>
      </>}
      {message && <p role="status">{message}</p>}
      </>}
    </Modal>
  </>;
}
