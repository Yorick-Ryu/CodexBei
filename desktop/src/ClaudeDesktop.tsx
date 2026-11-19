import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import { toolApi, type Connection } from "./api";
import { ToolTabs, type AppTool } from "./ToolTabs";
import { ModelPicker } from "./ModelPicker";
import { ApiAddressPicker, defaultClaudeAddress } from "./ApiAddressPicker";
import { AppSettings } from "./AppSettings";
import { ThemeSelector } from "./ThemeSelector";
import { StatusNotice } from "./StatusNotice";
import { useSoftwareUpdate } from "./SoftwareUpdate";
import { SettingsIcon, EyeIcon, EyeOffIcon, CloseIcon } from "./icons";
import claude from "../assets/agents/claude.svg";
import brand from "../assets/brand/codexbei.svg";

const api = toolApi("claude");
const nativeModels = (models: string[]) => {
  const families = ["fable", "opus", "sonnet", "haiku"];
  const rank = (model: string) => {
    const family = model.replace(/^anthropic\//, "").match(/^claude-([^-]+)-/)?.[1];
    const index = families.indexOf(family || "");
    return index < 0 ? families.length : index;
  };
  return models.filter(name => /^(anthropic\/)?claude-(sonnet|opus|haiku|fable|mythos)-\d/.test(name))
    .sort((a, b) => rank(a) - rank(b) || b.localeCompare(a, "en", { numeric: true }));
};
const preferredModel = (models: string[]) => models.filter(name => /claude-sonnet-/.test(name))
  .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] || models[0] || "";
export type DesktopDraft = { connection: Connection; models: string[]; modelDiscovery: boolean; context1m: boolean; allowAllWebsites: boolean; expanded: boolean; hasSavedKey: boolean; savedKey: string; addressEdited: boolean };

export function ClaudeDesktop({ onChangeTool, draftRef }: {
  onChangeTool: (tool: AppTool) => void; draftRef: MutableRefObject<DesktopDraft | null>;
}) {
  const initial = useRef(draftRef.current);
  const [connection, setConnection] = useState<Connection>(initial.current?.connection || { baseUrl: defaultClaudeAddress, apiKey: "", model: "" });
  const [hasSavedKey, setHasSavedKey] = useState(initial.current?.hasSavedKey ?? false);
  const [savedKey, setSavedKey] = useState(initial.current?.savedKey ?? "");
  const [addressEdited, setAddressEdited] = useState(initial.current?.addressEdited ?? false);
  const [models, setModels] = useState(initial.current?.models || []);
  const [modelDiscovery, setModelDiscovery] = useState(initial.current?.modelDiscovery ?? true);
  const [context1m, setContext1m] = useState(initial.current?.context1m ?? true);
  const [allowAllWebsites, setAllowAllWebsites] = useState(initial.current?.allowAllWebsites ?? false);
  const [busy, setBusy] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [installation, setInstallation] = useState<Awaited<ReturnType<typeof api.claudeDesktopInstallation>> | null>(null);
  const [repairOpening, setRepairOpening] = useState(false);
  const [repairNoticeDismissed, setRepairNoticeDismissed] = useState(false);
  const [installationError, setInstallationError] = useState("");
  const [installationRefresh, setInstallationRefresh] = useState(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), 3000);
    return () => clearTimeout(timer);
  }, [message]);
  const [expanded, setExpanded] = useState(initial.current?.expanded ?? false);
  const [visibleKey, setVisibleKey] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelStatus, setModelStatus] = useState("");
  const [modelRefresh, setModelRefresh] = useState(0);
  const busyRef = useRef(false);
  const incomingQueued = useRef(false);
  const drainIncoming = useRef<() => void>(() => {});
  useEffect(() => {
    let active = true;
    let checking = false;
    const check = async () => {
      if (checking || busyRef.current) return;
      checking = true;
      try {
        const value = await api.claudeDesktopInstallation();
        if (!active) return;
        setInstallation(value); setInstallationError("");
        if (value.installed && !value.runtimeMissing) {
          window.clearInterval(timer);
        }
      } catch (error) {
        if (active) setInstallationError(typeof error === "string" ? error : "无法检测安装状态，请重试。");
      } finally { checking = false; }
    };
    const onFocus = () => void check();
    const timer = window.setInterval(() => void check(), 10_000);
    window.addEventListener("focus", onFocus);
    void check();
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [installationRefresh]);
  useEffect(() => { draftRef.current = { connection, models, modelDiscovery, context1m, allowAllWebsites, expanded, hasSavedKey, savedKey, addressEdited }; }, [connection, models, modelDiscovery, context1m, allowAllWebsites, expanded, hasSavedKey, savedKey, addressEdited, draftRef]);
  useEffect(() => {
    let active = true;
    api.claudeDesktopStatus().then(value => {
      if (!active) return;
      if (!initial.current) {
        setHasSavedKey(value.hasKey ?? false);
        setSavedKey(value.apiKey ?? "");
        setModels(nativeModels(value.models || []));
        setConnection(current => ({ ...current, apiKey: value.apiKey ?? "", baseUrl: value.baseUrl || current.baseUrl, model: value.model || current.model }));
        setModelDiscovery(value.modelDiscovery ?? true); setContext1m(value.context1m ?? true);
        setAllowAllWebsites(value.allowAllWebsites ?? false);
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
    finally {
      busyRef.current = false; setBusy(false);
      if (incomingQueued.current) drainIncoming.current();
    }
  }, []);
  drainIncoming.current = () => {
    if (busyRef.current || initializing || !installation?.installed) {
      incomingQueued.current = true;
      return;
    }
    incomingQueued.current = false;
    void run(async () => {
      const value = await api.incomingClaudeDesktop();
      if (!value) return;
      setHasSavedKey(value.hasKey ?? false);
      setSavedKey(value.apiKey ?? "");
      setAddressEdited(false);
      setModels(nativeModels(value.models || []));
      setConnection(current => ({ ...current, apiKey: value.apiKey ?? "", baseUrl: value.baseUrl || current.baseUrl, model: value.model || "" }));
      setModelDiscovery(value.modelDiscovery ?? true);
      setContext1m(value.context1m ?? true);
      setAllowAllWebsites(value.allowAllWebsites ?? false);
      setMessage("桌面配置已保存，重新打开 Claude 后生效。");
    });
  };
  useEffect(() => {
    const subscription = listen("incoming-changed", () => drainIncoming.current());
    drainIncoming.current();
    return () => { void subscription.then(unlisten => unlisten()); };
  }, [initializing, installation?.installed]);
  const update = useSoftwareUpdate({ busy, run });
  const disabled = busy || initializing || !installation?.installed;
  const showRepairNotice = installation?.installed && installation.platform === "windows"
    && installation.runtimeMissing && !repairNoticeDismissed && !error && !message;
  useEffect(() => {
    if (!expanded || initializing || !installation?.installed || addressEdited || !connection.apiKey.trim()) {
      setModelsLoading(false);
      return;
    }
    let active = true;
    setModelsLoading(true); setModelStatus("");
    const timer = setTimeout(() => {
      api.models(connection.apiKey, connection.baseUrl).then(result => {
        if (!active) return;
        const available = nativeModels(result);
        setModels(available);
        setConnection(current => ({ ...current, model: current.model || preferredModel(available) }));
        setModelStatus(available.length ? "" : "未发现原生 Claude 模型，可手动填写。");
      }).catch(error => {
        if (active) setModelStatus(typeof error === "string" ? error : "模型获取失败，可手动填写。");
      }).finally(() => { if (active) setModelsLoading(false); });
    }, 350);
    return () => { active = false; clearTimeout(timer); };
  }, [expanded, initializing, installation?.installed, connection.apiKey, connection.baseUrl, addressEdited, modelRefresh]);
  return <>
    <header className="app-header"><div className="brand-row" data-tauri-drag-region>
      <div className="brand"><img className="logo" src={brand} alt="" />CodexBei</div>
      <div className="toolbar-actions">
        <ToolTabs activeTool="claude-desktop" onChange={onChangeTool} disabled={busy} />
        <AppSettings baseUrl={connection.baseUrl} theme={<ThemeSelector />} isWindows={false}
          updateAvailable={update.available} updateRow={update.row} historyBusy={busy} />
      </div>
    </div></header>
    <div className="content-scroll"><main className="config-main desktop-main">
      <section id="claude-desktop-panel" role="tabpanel" aria-labelledby="claude-desktop-tab">
        {!installation?.installed ? <div className="config-card install-card">
          <div className="install-card-icon"><img src={claude} alt="" /></div>
          <h2 className="config-title">{installationError ? "无法检测 Claude 桌面版" : installation ? "未检测到 Claude 桌面版" : "正在检测 Claude 桌面版…"}</h2>
          <p className="install-card-message">{installationError || (installation
            ? "请先下载安装 Claude 桌面版，完成后开放配置功能。"
            : "正在检查本机安装状态，请稍候。")}</p>
          {(installation || installationError) && <div className="install-card-actions">
            <button type="button" className="primary install-card-action" disabled={busy}
              onClick={() => void run(() => api.openClaudeDesktopInstaller())}>下载桌面版</button>
            <button type="button" className="secondary install-card-action" disabled={busy}
              onClick={() => { setInstallationError(""); setInstallation(null); setInstallationRefresh(value => value + 1); }}>重新检测</button>
          </div>}
        </div> :
        <form onSubmit={event => {
          event.preventDefault();
          if (disabled) return;
          void run(async () => {
            let available = models;
            if (!available.length && connection.apiKey.trim()) {
              available = nativeModels(await api.models(connection.apiKey, connection.baseUrl));
              setModels(available);
            }
            const selected = { ...connection, model: connection.model || preferredModel(available) };
            if (!selected.model) {
              setExpanded(true);
              throw "未发现原生 Claude 模型，请在更多设置中填写模型名称。";
            }
            setConnection(selected);
            const apiKey = selected.apiKey === savedKey ? "" : selected.apiKey;
            const value = await api.configureClaudeDesktop({ ...selected, apiKey }, { modelDiscovery, context1m, allowAllWebsites, models: available });
            setHasSavedKey(value.hasKey ?? false);
            setSavedKey(value.apiKey ?? "");
            setAddressEdited(false);
            setConnection(current => ({ ...current, apiKey: value.apiKey ?? "" }));
            setMessage("桌面配置已保存，重新打开 Claude 后生效。");
          });
        }}>
          <div className="config-card">
            <div className="provider-row">
              <div className="provider-info"><h2 className="config-title"><img src={claude} alt="" />配置 Claude 桌面版</h2></div>
              <button type="button" className="text-button settings-toggle" aria-expanded={expanded} aria-controls="desktop-settings"
                onClick={() => setExpanded(value => !value)}><SettingsIcon />{expanded ? "更少设置" : "更多设置"}</button>
            </div>
            <div className="credential-field">
              <div className="label-row"><label htmlFor="desktop-key">API 密钥</label></div>
              <div className="key-control">
                <input id="desktop-key" type={visibleKey ? "text" : "password"} required={!hasSavedKey} placeholder={hasSavedKey ? savedKey ? "留空继续使用当前密钥" : "密钥已由 Claude 加密，留空继续使用" : ""} autoComplete="off" spellCheck={false}
                  value={connection.apiKey} disabled={disabled}
                  onChange={event => { setModels([]); setConnection(current => ({ ...current, apiKey: event.target.value })); }} />
                <div className="key-actions">
                  <button type="button" className="key-action" disabled={disabled || !connection.apiKey} aria-label={visibleKey ? "隐藏密钥" : "显示密钥"}
                    aria-pressed={visibleKey} onClick={() => setVisibleKey(value => !value)}>{visibleKey ? <EyeOffIcon /> : <EyeIcon />}</button>
                  <button type="button" className="key-action" disabled={disabled || !connection.apiKey} aria-label="清空输入的密钥"
                    onClick={() => { setConnection(current => ({ ...current, apiKey: "" })); setModels([]); }}><CloseIcon /></button>
                </div>
              </div>
              <p className="field-feedback" aria-live="polite" />
            </div>
            <div id="desktop-settings" className="settings-collapse" data-expanded={expanded} aria-hidden={!expanded}
              ref={element => { if (element) element.inert = !expanded; }}>
              <div className="settings-clip"><div className="settings-body desktop-options-body">
                <label htmlFor="desktop-base-url">API 地址</label>
                <ApiAddressPicker id="desktop-base-url" value={connection.baseUrl} disabled={disabled} required={false}
                  onChange={baseUrl => {
                    setAddressEdited(true);
                    setModelStatus("");
                    if (connection.apiKey.trim()) setModels([]);
                    setConnection(current => ({ ...current, baseUrl }));
                  }} />
                <p className="field-feedback" aria-hidden="true" />
                <div className="label-row model-label"><label htmlFor="model">模型</label>
                  <button type="button" className="text-button" disabled={disabled || modelsLoading || !connection.apiKey.trim()}
                    onClick={() => { setAddressEdited(false); setModelRefresh(value => value + 1); }}>{modelsLoading ? "获取中…" : "刷新"}</button>
                </div>
                <ModelPicker required={false} value={connection.model} options={models} disabled={disabled}
                  onChange={model => setConnection(current => ({ ...current, model }))} />
                <p id="models-help" className="field-feedback" role="status" title={modelStatus || undefined}>{modelStatus}</p>
                <div className="desktop-options">
                  <label className="login-option"><input type="checkbox" checked={modelDiscovery} disabled={disabled} onChange={event => setModelDiscovery(event.target.checked)} />启用模型发现</label>
                  <label className="login-option"><input type="checkbox" checked={context1m} disabled={disabled} onChange={event => setContext1m(event.target.checked)} />启用 1M 上下文</label>
                  <label className="login-option"><input type="checkbox" checked={allowAllWebsites} disabled={disabled} onChange={event => setAllowAllWebsites(event.target.checked)} />允许访问所有网站</label>
                </div>
              </div></div>
            </div>
            <div className="action-row"><button id="apply" type="submit" className="primary" disabled={disabled || (!connection.apiKey.trim() && !hasSavedKey)}>{busy ? "处理中…" : "一键配置"}</button></div>
          </div>
        </form>}
      </section>
    </main></div>
    <StatusNotice visible={!!(error || message || showRepairNotice)}
      kind={error ? "error" : message ? "success" : "info"}
      formWidth={!!showRepairNotice}
      onClose={() => {
        if (error || message) { setError(""); setMessage(""); }
        else setRepairNoticeDismissed(true);
      }}
      actions={showRepairNotice &&
        <button type="button" className="secondary" disabled={repairOpening}
          title="下载并运行 Claude 官方离线安装包"
          onClick={async () => {
            setRepairOpening(true);
            try {
              await api.openClaudeDesktopOfflineInstaller();
            } catch (error) {
              setError(typeof error === "string" ? error : "无法打开 Claude 官方离线安装包。");
            } finally {
              setRepairOpening(false);
            }
          }}>{repairOpening ? "正在打开…" : "一键修复"}</button>
      }>
      {error || message || (showRepairNotice &&
        <span><strong>检测到 Claude Code 组件缺失</strong><br />可能无法正常对话，点击一键修复后重启 Claude。</span>)}
    </StatusNotice>
  </>;
}
