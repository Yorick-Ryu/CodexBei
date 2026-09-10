import { Modal } from "./Modal";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon, ChevronRightIcon, CopyIcon, GearIcon } from "./icons";
import { api, type DiagnosticReport } from "./api";

export function AppSettings({ baseUrl, theme, isWindows, updateAvailable, updateRow, historyBusy, onOpenHistory }: {
  baseUrl: string;
  theme: ReactNode;
  isWindows: boolean;
  updateAvailable: boolean;
  updateRow: ReactNode;
  historyBusy: boolean;
  onOpenHistory: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<"settings" | "diagnostics">("settings");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const resetCopied = () => {
    clearTimeout(copyTimer.current);
    setCopied(false);
  };
  const request = useRef(0);
  const openDiagnostics = () => {
    request.current++;
    setReport(null);
    setMessage("");
    resetCopied();
    setBusy(false);
    setSection("diagnostics");
  };
  const run = async () => {
    const current = ++request.current;
    setBusy(true);
    setReport(null);
    setMessage("");
    resetCopied();
    try {
      const result = await api.windowsDiagnostics(baseUrl);
      if (current === request.current) setReport(result);
    }
    catch (error) { if (current === request.current) setMessage(typeof error === "string" ? error : "排查未完成，请重试。"); }
    finally { if (current === request.current) setBusy(false); }
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
      title={section === "settings" ? "设置" : "问题排查"}>
      <div hidden={section !== "settings"}>
        <div className="settings-list">
          <div className="settings-theme-row"><span>外观主题</span>{theme}</div>
          <button id="open-history" type="button" className="settings-diagnostic-row" disabled={historyBusy} onClick={() => { setOpen(false); onOpenHistory(); }}>
            <span>历史备份</span><ChevronRightIcon />
          </button>
          {isWindows && <button type="button" className="settings-diagnostic-row" onClick={openDiagnostics}>
            <span>问题排查</span><ChevronRightIcon />
          </button>}
          {updateRow}
        </div>
      </div>
      {section === "diagnostics" && <>
      <p className="diagnostic-intro" role="status" aria-live="polite">{message || "遇到对话一直重连、无法对话或回复慢？排查后可复制报告，发给客服协助处理。"}</p>
      <div className="diagnostic-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void run()}>{busy ? "正在排查…" : report ? "再次排查" : "开始排查"}</button>
        {report && <button type="button" className="secondary diagnostic-copy" title={copied ? "已复制" : "复制报告"} onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setMessage("");
            clearTimeout(copyTimer.current);
            setCopied(true);
            copyTimer.current = setTimeout(() => setCopied(false), 2000);
          }
          catch { resetCopied(); setMessage("复制失败，请重试。"); }
        }}>{copied ? <CheckIcon /> : <CopyIcon />}复制报告</button>}
      </div>
      </>}
    </Modal>
  </>;
}
