import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { toolApi, type ClaudeDesktopStatus, type Connection, type Tool } from "./api";
import { ToolTabs, type AppTool } from "./ToolTabs";
import { ModelPicker } from "./ModelPicker";
import { AppSettings } from "./AppSettings";
import { ThemeSelector } from "./ThemeSelector";
import { Modal } from "./Modal";
import { useSoftwareUpdate } from "./SoftwareUpdate";
import brand from "../assets/brand/codexbei.svg";

const api = toolApi("claude");
const nativeModels = (models: string[]) => models.filter(name => /^(anthropic\/)?claude-(sonnet|opus|haiku|fable|mythos)-\d/.test(name));
const preferredModel = (models: string[]) => models.filter(name => /claude-sonnet-/.test(name))
  .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] || models[0] || "";
export type DesktopDraft = { connection: Connection; models: string[]; modelDiscovery: boolean; context1m: boolean };

export function ClaudeDesktop({ onChangeTool, draftRef }: {
  onChangeTool: (tool: AppTool) => void; draftRef: MutableRefObject<DesktopDraft | null>;
}) {
  const initial = useRef(draftRef.current);
  const [connection, setConnection] = useState<Connection>(initial.current?.connection || { baseUrl: "https://api.beiapi.cn", apiKey: "", model: "" });
  const [models, setModels] = useState(initial.current?.models || []);
  const [modelDiscovery, setModelDiscovery] = useState(initial.current?.modelDiscovery ?? true);
  const [context1m, setContext1m] = useState(initial.current?.context1m ?? true);
  const [status, setStatus] = useState<ClaudeDesktopStatus>();
  const [busy, setBusy] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [closed, setClosed] = useState(false);
  const [history, setHistory] = useState(false);
  const busyRef = useRef(false);
  useEffect(() => { draftRef.current = { connection, models, modelDiscovery, context1m }; }, [connection, models, modelDiscovery, context1m, draftRef]);
  useEffect(() => {
    let active = true;
    api.claudeDesktopStatus().then(value => {
      if (!active) return;
      setStatus(value);
      if (!initial.current) {
        setConnection(current => ({ ...current, baseUrl: value.baseUrl || current.baseUrl, model: value.model || current.model }));
        setModelDiscovery(value.modelDiscovery ?? true); setContext1m(value.context1m ?? true);
      }
    }).catch(error => { if (active) setError(typeof error === "string" ? error : "无法读取桌面版状态。"); })
      .finally(() => { if (active) setInitializing(false); });
    return () => { active = false; };
  }, []);
  const run = useCallback(async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); setMessage("");
    try { await action(); }
    catch (error) { setError(typeof error === "string" ? error : "操作未完成，请重试。"); }
    finally { busyRef.current = false; setBusy(false); }
  }, []);
  const update = useSoftwareUpdate({ busy, run });
  const importConnection = (tool: Tool) => void run(async () => {
    const saved = await toolApi(tool).inspect();
    if (!saved.baseUrl || !saved.hasKey) throw "此页面尚未保存 API 连接。";
    const available = nativeModels(await api.models(saved.apiKey, saved.baseUrl));
    setModels(available);
    setConnection({ apiKey: saved.apiKey, baseUrl: saved.baseUrl.replace(/\/v1\/?$/, ""),
      model: available.includes(saved.model || "") ? saved.model! : preferredModel(available) });
    if (!available.length) setMessage("未发现原生 Claude 模型，请核对网关或手动填写模型名称。");
  });
  const disabled = busy || initializing;
  const restore = () => void run(async () => {
    setStatus(await api.restoreClaudeDesktop()); setClosed(false); setHistory(false);
    setMessage("已撤销上次桌面配置，重新打开 Claude 后生效。");
  });
  return <>
    <header className="app-header"><div className="brand-row" data-tauri-drag-region>
      <div className="brand"><img className="logo" src={brand} alt="" />CodexBei</div>
      <div className="toolbar-actions">
        <ToolTabs activeTool="claude-desktop" onChange={onChangeTool} disabled={busy} />
        <AppSettings baseUrl={connection.baseUrl} theme={<ThemeSelector />} isWindows={false}
          updateAvailable={update.available} updateRow={update.row} historyBusy={busy} onOpenHistory={() => setHistory(true)} />
      </div>
    </div></header>
    <div className="content-scroll"><main className="desktop-main">
      <section id="claude-desktop-panel" role="tabpanel" aria-labelledby="claude-desktop-tab">
        <h1>配置 Claude 桌面版</h1>
        <p className="history-description">独立管理桌面版连接，保存后重新打开 Claude 生效。</p>
        <form className="desktop-config" onSubmit={event => {
          event.preventDefault();
          if (disabled || !closed) return;
          void run(async () => {
            setStatus(await api.configureClaudeDesktop(connection, { modelDiscovery, context1m, models }));
            setClosed(false); setMessage("桌面配置已保存，请重新打开 Claude。实际可用性以消息请求结果为准。");
          });
        }}>
          <div className="desktop-import"><span>复用连接</span>
            <button type="button" className="text-button" disabled={disabled} onClick={() => importConnection("codex")}>从 ChatGPT 导入</button>
            <button type="button" className="text-button" disabled={disabled} onClick={() => importConnection("claude")}>从 Claude Code 导入</button>
          </div>
          <label htmlFor="desktop-base-url">API 地址</label>
          <input id="desktop-base-url" type="url" required autoComplete="off" spellCheck={false} value={connection.baseUrl} disabled={disabled}
            onChange={event => { setModels([]); setConnection(current => ({ ...current, baseUrl: event.target.value, apiKey: "" })); }} />
          <label htmlFor="desktop-key">API 密钥</label>
          <input id="desktop-key" type="password" required autoComplete="off" spellCheck={false} value={connection.apiKey} disabled={disabled}
            placeholder={status?.hasKey ? "重新输入密钥，或从其他页面导入连接" : "输入 API 密钥"}
            onChange={event => setConnection(current => ({ ...current, apiKey: event.target.value }))} />
          <div className="label-row"><label htmlFor="model">默认模型</label>
            <button type="button" className="text-button" disabled={disabled || !connection.apiKey.trim()} onClick={() => void run(async () => {
              const available = nativeModels(await api.models(connection.apiKey, connection.baseUrl));
              setModels(available);
              if (!connection.model) setConnection(current => ({ ...current, model: preferredModel(available) }));
              if (!available.length) setMessage("未发现原生 Claude 模型，请核对网关或手动填写。");
            })}>获取模型</button>
          </div>
          <ModelPicker value={connection.model} options={models} disabled={disabled}
            onChange={model => setConnection(current => ({ ...current, model }))} />
          <p id="models-help" className="history-description">支持原生 Claude 模型；模型列表可见不代表上游渠道当前可用。</p>
          <div className="desktop-options">
            <label className="login-option"><input type="checkbox" checked={modelDiscovery} disabled={disabled} onChange={event => setModelDiscovery(event.target.checked)} />启用模型发现</label>
            <label className="login-option"><input type="checkbox" checked={context1m} disabled={disabled} onChange={event => setContext1m(event.target.checked)} />启用 1M 上下文</label>
          </div>
          <label className="login-option"><input type="checkbox" checked={closed} disabled={disabled}
            onChange={event => setClosed(event.target.checked)} />我已彻底退出 Claude 桌面版</label>
          <div className="action-row">
            <button type="button" className="secondary" disabled={disabled || !closed || !status?.canRestore} onClick={restore}>撤销上次配置</button>
            <button type="submit" className="primary" disabled={disabled || !closed || !connection.apiKey.trim() || !connection.model.trim()}>{busy ? "处理中…" : "一键配置"}</button>
          </div>
        </form>
        {error && <p className="desktop-error" role="alert">{error}</p>}
        {message && <p role="status">{message}</p>}
      </section>
    </main></div>
    <Modal title="桌面配置备份" open={history} onClose={() => setHistory(false)}>
      <p>{status?.canRestore ? "已保留上次配置前的备份。请退出 Claude，回到配置页面勾选退出确认后撤销。" : "尚无可撤销的桌面配置。"}</p>
      <p className="history-description">{status?.profilePath}</p>
    </Modal>
  </>;
}
