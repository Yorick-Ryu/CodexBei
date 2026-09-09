import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  api,
  installationLabel,
  type Backup,
  type BackupPreview,
  type Inspection,
  type Matching,
  type Outcome,
} from "./api";
import {
  applyAppearance,
  media,
  savedAppearance,
  type Appearance,
} from "./theme";
import { SoftwareUpdate } from "./SoftwareUpdate";
import { VersionPicker } from "./VersionPicker";
import brand from "../assets/brand/codexbei.svg";
import chatgpt from "../assets/agents/chatgpt.svg";
import claude from "../assets/agents/claude-code.svg";

const toolTabs = [
  { id: "codex", name: "ChatGPT", icon: chatgpt, iconClass: "chatgpt-icon", disabled: false },
  { id: "claude", name: "Claude Code", icon: claude, iconClass: "", disabled: true },
] as const;

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}
function Theme() {
  const [appearance, setAppearance] = useState<Appearance>(savedAppearance);
  useEffect(() => {
    const update = () => applyAppearance(appearance);
    update();
    media.addEventListener("change", update);
    try {
      localStorage.setItem("codexbei.appearance", appearance);
    } catch {
      /* Keep the preference in memory. */
    }
    return () => media.removeEventListener("change", update);
  }, [appearance]);
  const icons = [
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8m-4-4v4" />
    </>,
    <path d="M20.2 14.5A8.5 8.5 0 0 1 9.5 3.8a8.5 8.5 0 1 0 10.7 10.7Z" />,
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1" />
    </>,
  ];
  return (
    <div
      id="theme"
      className="theme-switch"
      role="radiogroup"
      aria-label="外观主题"
    >
      {(["system", "dark", "light"] as const).map((value, i) => (
        <label key={value} title={["跟随系统", "石墨灰", "雾白"][i]}>
          <input
            type="radio"
            name="appearance"
            value={value}
            aria-label={["跟随系统", "石墨灰", "雾白"][i]}
            checked={appearance === value}
            onChange={() => setAppearance(value)}
          />
          <Icon>{icons[i]}</Icon>
        </label>
      ))}
    </div>
  );
}
const date = (value: string) =>
  new Date(value).toLocaleString("zh-CN", { hour12: false });
const errorText = (error: unknown) =>
  typeof error === "string" ? error : "操作未完成，请重试。";
// Match known credential failures, rather than routing any mention of a key here.
const isKeyError = (message: string) => [
  "请提供有效的 API 密钥",
  "API 地址已更改或没有可复用密钥，请填写对应密钥。",
  "请输入此地址对应的密钥。",
  "请先完成 API 密钥配置。",
  "无法获取模型，请检查密钥及访问权限。",
].includes(message);

export function App() {
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [apiKey, setApiKey] = useState("");
  const loadedKey = useRef<{ value: string; baseUrl: string } | null>(null);
  const [baseUrl, setBaseUrl] = useState("https://api.beiapi.cn/v1");
  const [model, setModel] = useState("gpt-6-astra");
  const [keep, setKeep] = useState(false);
  const [visibleKey, setVisibleKey] = useState(false);
  const [busy, setBusy] = useState(true);
  const [channelSwitching, setChannelSwitching] = useState(false);
  const [channelTooltipOpen, setChannelTooltipOpen] = useState(false);
  const [previewChannel, setPreviewChannel] = useState<string>();
  const [loginPreviewPending, setLoginPreviewPending] = useState(false);
  const [status, setStatus] = useState("");
  const [statusSuccess, setStatusSuccess] = useState(false);
  const [successNoticeId, setSuccessNoticeId] = useState(0);
  useEffect(() => {
    if (!statusSuccess || !status) return;
    const timeout = setTimeout(() => {
      setStatus("");
      setStatusSuccess(false);
    }, 3000);
    return () => clearTimeout(timeout);
  }, [status, statusSuccess, successNoticeId]);
  const [matching, setMatching] = useState<Matching | null>(null);
  const [waitingForChatgptInstall, setWaitingForChatgptInstall] = useState(false);
  const [versionOpen, setVersionOpen] = useState(false);
  const [versionPending, setVersionPending] = useState(false);
  const [versionDraft, setVersionDraft] = useState<Matching | null>(null);
  const versionOpenRef = useRef(false);
  versionOpenRef.current = versionOpen;
  const acceptVersionMatch = useCallback((data: Matching) => {
    if (versionOpenRef.current) setVersionDraft(data);
    else setMatching(data);
  }, []);
  const closeVersion = () => {
    versionOpenRef.current = false;
    if (versionDraft) setMatching(versionDraft);
    setVersionDraft(null);
    setVersionOpen(false);
  };
  const [expanded, setExpanded] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelStatus, setModelStatus] = useState("");
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelRefresh, setModelRefresh] = useState(0);
  const [page, setPage] = useState<"config" | "success" | "history">("config");
  const [activeTool, setActiveTool] = useState<(typeof toolTabs)[number]["id"]>("codex");
  const selectedTool = toolTabs.find(tool => tool.id === activeTool)!;
  const [preview, setPreview] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [previewPending, setPreviewPending] = useState(true);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [selectedBackup, setSelectedBackup] = useState<BackupPreview | null>(
    null,
  );
  const [dialogError, setDialogError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const baseUrlInput = useRef<HTMLInputElement>(null);
  const successTitle = useRef<HTMLHeadingElement>(null);
  const historyTitle = useRef<HTMLHeadingElement>(null);
  const busyRef = useRef(true);
  const keepRef = useRef(false);
  const incomingQueued = useRef(false);
  const drainIncoming = useRef<() => void>(() => {});
  keepRef.current = keep;
  const acceptInspection = useCallback((data: Inspection) => {
    setInspection(data);
    setApiKey(data.apiKey || "");
    setVisibleKey(false);
    loadedKey.current = data.apiKey && data.baseUrl ? { value: data.apiKey, baseUrl: data.baseUrl } : null;
    setBaseUrl(data.baseUrl || "https://api.beiapi.cn/v1");
    setModel(data.model || "gpt-6-astra");
    setKeep(data.keepOfficialLogin);
    keepRef.current = data.keepOfficialLogin;
    document.body.dataset.platform =
      data.platform === "macos" ? "darwin" : data.platform;
  }, []);
  const changeBaseUrl = (value: string) => {
    const saved = loadedKey.current;
    if (saved && apiKey === saved.value && value.trim().replace(/\/+$/, "") !== saved.baseUrl.replace(/\/+$/, "")) {
      setApiKey("");
      setVisibleKey(false);
      loadedKey.current = null;
    }
    setPreviewPending(true);
    setBaseUrl(value);
  };
  const completed = useCallback(
    async (outcome?: Outcome) => {
      setApiKey("");
      setVisibleKey(false);
      setPage("success");
      setVersionOpen(false);
      setVersionDraft(null);
      dialog.current?.close();
      setSelectedBackup(null);
      acceptInspection(await api.inspect());
      setMatching(await api.check());
      if (outcome?.warning) setStatus(outcome.warning);
    },
    [acceptInspection],
  );
  const run = useCallback(
    async (
      action: () => Promise<void>,
      inDialog = false,
      clearStatus = true,
    ) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      if (clearStatus) {
        setStatus("");
        setStatusSuccess(false);
      }
      setDialogError("");
      try {
        await action();
      } catch (error) {
        setStatusSuccess(false);
        (inDialog ? setDialogError : setStatus)(errorText(error));
      } finally {
        busyRef.current = false;
        setBusy(false);
        if (incomingQueued.current) drainIncoming.current();
      }
    },
    [],
  );
  const switchChannel = (channel: "api" | "official") => {
    if (!keep) return;
    void run(async () => {
      setChannelSwitching(true);
      try {
        await api.switchChannel(channel);
        // A channel switch only changes routing; preserve unsaved form edits.
        setInspection(await api.inspect());
        setStatusSuccess(true);
        setStatus("切换成功，新对话生效");
        setSuccessNoticeId(value => value + 1);
      } finally {
        setChannelSwitching(false);
      }
    });
  };
  drainIncoming.current = () => {
    if (busyRef.current) {
      incomingQueued.current = true;
      return;
    }
    incomingQueued.current = false;
    void run(
      async () => {
        const result = await api.incoming(keepRef.current);
        if (result) {
          setStatus("");
          await completed(result);
        }
      },
      false,
      false,
    );
  };
  useEffect(() => {
    let active = true;
    const subscription = listen("incoming-changed", () =>
      drainIncoming.current(),
    );
    void (async () => {
      try {
        const data = await api.inspect();
        if (active) acceptInspection(data);
      } catch (error) {
        if (active) setStatus(errorText(error));
      }
      await getCurrentWindow()
        .show()
        .catch(() => {});
      try {
        const info = await api.check(null, true);
        if (active) setMatching(info);
      } catch (error) {
        if (active) setStatus(errorText(error));
      } finally {
        if (active) {
          busyRef.current = false;
          setBusy(false);
          drainIncoming.current();
        }
        await getCurrentWindow()
          .show()
          .catch(() => {});
      }
    })();
    return () => {
      active = false;
      void subscription.then((unlisten) => unlisten());
    };
  }, [acceptInspection]);
  useEffect(() => {
    let active = true;
    // Keep the previous layout while IPC produces the replacement preview.
    // Clearing it here collapses the page and clamps WebKit's scroll position.
    setPreviewPending(true);
    setPreviewError("");
    void api.preview(baseUrl, model, keep, inspection?.modelChannel ?? "api").then(
      (value) => {
        if (active) {
          setPreview(value);
          setPreviewChannel(inspection?.modelChannel ?? "api");
          setPreviewPending(false);
          setLoginPreviewPending(false);
        }
      },
      (error) => {
        if (active) {
          setPreviewError(errorText(error));
          setPreviewChannel(inspection?.modelChannel ?? "api");
          setPreviewPending(false);
          setLoginPreviewPending(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [baseUrl, model, keep, matching?.template?.digest, inspection?.modelChannel]);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (!busyRef.current && !versionOpenRef.current)
        void api
          .check()
          .then((info) => {
            if (active && !versionOpenRef.current) setMatching(info);
          })
          .catch(() => {});
    };
    window.addEventListener("focus", refresh);
    const interval = setInterval(refresh, 4 * 60 * 60 * 1000);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      clearInterval(interval);
    };
  }, []);
  useEffect(() => {
    if (!waitingForChatgptInstall) return;
    let active = true;
    const poll = async () => {
      try {
        const info = await api.check(null, true);
        if (!active) return;
        setMatching(info);
        if (info.installations.some((item) => item.kind === "desktop")) {
          setWaitingForChatgptInstall(false);
          setStatus("已检测到 ChatGPT，正在刷新配置。");
        }
      } catch {
        // The Store may still be installing or the app may be offline.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [waitingForChatgptInstall]);
  useEffect(() => {
    let active = true;
    setAvailableModels([]);
    setModelStatus("");
    setModelsLoading(false);
    if (!expanded) return;
    if (!apiKey) {
      setModelStatus("填写密钥后可获取模型列表。");
      return;
    }
    if (!matching?.modelClientVersion) {
      setModelStatus("请先选择 ChatGPT 版本。");
      return;
    }
    setModelsLoading(true);
    const timer = setTimeout(() => {
      void api.models(apiKey, baseUrl).then(
        (models) => {
          if (active) {
            setAvailableModels(models);
            setModelStatus(models.length ? "" : "没有可用模型，请检查权限。");
            setModelsLoading(false);
          }
        },
        (e) => {
          if (active) {
            setModelStatus(errorText(e));
            setModelsLoading(false);
          }
        },
      );
    }, 400);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    expanded,
    apiKey,
    baseUrl,
    inspection?.file,
    inspection?.hasKey,
    matching?.modelClientVersion,
    modelRefresh,
  ]);
  useEffect(() => {
    if (page === "success") successTitle.current?.focus();
    if (page === "history") historyTitle.current?.focus();
  }, [page]);
  useEffect(() => {
    if (selectedBackup && !dialog.current?.open) {
      dialog.current?.showModal();
      dialog.current?.focus({ preventScroll: true });
    }
  }, [selectedBackup]);
  const showBackup = (id: string) =>
    void run(async () => {
      setSelectedBackup(await api.backupPreview(id));
    });
  const restoreBackup = (id: string, inDialog = false) =>
    void run(async () => {
      const result = await api.restore(id);
      if (!result.canceled) {
        dialog.current?.close();
        setSelectedBackup(null);
        setBackups(await api.backups());
        acceptInspection(await api.inspect());
        setVisibleKey(false);
      }
    }, inDialog);
  const statusKeyError = page === "config" && !statusSuccess && isKeyError(status);
  const keyError = page === "config" ? (statusKeyError ? status : isKeyError(modelStatus) ? modelStatus : "") : "";
  const footerStatus = statusKeyError ? "" : status;
  const disabled = busy || !inspection;
  const channelUpdating = channelSwitching || (!!inspection && previewChannel !== undefined && previewChannel !== inspection.modelChannel);
  const applyReady = !!(apiKey.trim() && baseUrl.trim() && model.trim() && matching && !matching.needsSelection && !versionPending && (!previewPending || channelUpdating || loginPreviewPending) && preview && !previewError);
  return (
    <>
      <header className="app-header">
        <div className="toolbar" data-tauri-drag-region />
        {page === "history" ? (
          <div className="brand-row history-page-header" data-tauri-drag-region>
            <button
              id="back-to-config"
              className="history-back"
              disabled={busy}
              aria-label="返回配置"
              onClick={() => setPage("config")}
            >
              <Icon>
                <path d="m14 6-6 6 6 6" />
              </Icon>
            </button>
            <h1 id="history-title" tabIndex={-1} ref={historyTitle}>
              历史备份
            </h1>
            <button
              className="text-button"
              disabled={busy}
              onClick={() =>
                void run(async () => setBackups(await api.backups()))
              }
            >
              刷新
            </button>
          </div>
        ) : (
          <div className="brand-row" data-tauri-drag-region>
            <button type="button" className="brand software-update-entry" aria-label="CodexBei 软件更新"
              title={updateReady ? "更新已准备好，点击重启更新" : "软件更新"} onClick={() => setUpdateOpen(true)}>
              <img className="logo" src={brand} alt="" />
              CodexBei
              {updateReady && <span className="software-update-dot" aria-label="有可用更新" />}
            </button>
            <div className="toolbar-actions">
              <div className="tabs" role="tablist" aria-label="选择工具">
                {toolTabs.map(tool => (
                  <button
                    key={tool.id}
                    role="tab"
                    aria-selected={activeTool === tool.id}
                    aria-controls={activeTool === tool.id ? "codex-panel" : undefined}
                    id={`${tool.id}-tab`}
                    disabled={tool.disabled}
                    onClick={() => setActiveTool(tool.id)}
                  >
                    <img className={`agent-icon ${tool.iconClass}`} src={tool.icon} alt="" />
                    {tool.name}
                    {tool.disabled && <span>即将支持</span>}
                  </button>
                ))}
              </div>
              <Theme />
            </div>
          </div>
        )}
      </header>
      <div className="content-scroll" onScrollCapture={() => setChannelTooltipOpen(false)}>
        <main className={page !== "history" ? "config-main" : undefined} data-channel-updating={channelUpdating || undefined} data-has-key={!!apiKey} data-has-base-url={!!baseUrl} data-template-update={!!matching?.templateUpdateAvailable}>
          {page !== "history" ? (
            <div id="configuration-page">
              <section
                id="codex-panel"
                role="tabpanel"
                aria-labelledby={`${activeTool}-tab`}
              >
                {page === "success" ? (
                  <div id="success">
                    <div className="success-icon">
                      <Icon>
                        <path d="m6 12 4 4 8-8" />
                      </Icon>
                    </div>
                    <h1 ref={successTitle} id="success-title" tabIndex={-1}>
                      配置完成
                    </h1>
                    <p>
                      {inspection?.testMode
                        ? "已写入隔离测试目录。"
                        : "请彻底退出并重新打开 ChatGPT，即可开始使用。"}
                    </p>
                    <button
                      className="primary"
                      id="done"
                      onClick={() => setPage("config")}
                    >
                      完成
                    </button>
                  </div>
                ) : (
                  <form
                    id="configure"
                    aria-busy={busy}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void run(async () => {
                        const result = await api.configure(
                          { apiKey, baseUrl, model },
                          keep,
                        );
                        await completed(result);
                      });
                    }}
                  >
                    {matching && !matching.installations.length ? (
                      <div className="config-card install-card">
                        <div className="install-card-icon"><img className={selectedTool.iconClass} src={selectedTool.icon} alt="" /></div>
                        <h2 className="config-title">未检测到 {selectedTool.name}</h2>
                        <p className="install-card-message">
                          请先下载安装 ChatGPT 桌面版，完成后开放配置功能。
                        </p>
                        <button
                          type="button"
                          className="primary install-card-action"
                          disabled={busy}
                          onClick={() => void run(async () => {
                            await api.openChatgptInstaller();
                            setWaitingForChatgptInstall(true);
                            setStatus("已打开安装入口，等待安装完成…");
                          })}
                        >
                          {waitingForChatgptInstall ? "等待安装完成…" : inspection?.platform === "windows" ? "前往 Microsoft Store 安装" : "下载 Mac 安装包"}
                        </button>
                      </div>
                    ) : (
                    <div className="config-card">
                      <div className="provider-row">
                        <div className="provider-info">
                          <h2 className="config-title">
                            <img className={selectedTool.iconClass} src={selectedTool.icon} alt="" />
                            {selectedTool.name} 配置
                          </h2>
                        </div>
                        <button
                          id="toggle-settings"
                          type="button"
                          className="text-button settings-toggle"
                          aria-expanded={expanded}
                          aria-controls="settings"
                          onClick={() => setExpanded(value => !value)}
                        >
                          <Icon>
                            <path d="M4 7h9m4 0h3M4 17h3m4 0h9" />
                            <circle cx="15" cy="7" r="2" />
                            <circle cx="9" cy="17" r="2" />
                          </Icon>
                          {expanded ? "更少设置" : "更多设置"}
                        </button>
                      </div>
                      <div className="credential-field">
                        <div className="label-row">
                          <label htmlFor="key">API 密钥</label>
                        </div>
                        <div className="key-control">
                          <input
                            id="key"
                            type={visibleKey ? "text" : "password"}
                            value={apiKey}
                            onChange={(e) => {
                              setApiKey(e.target.value);
                              if (isKeyError(status)) setStatus("");
                            }}
                            autoComplete="off"
                            spellCheck={false}
                            required
                            disabled={disabled}
                            aria-describedby={keyError || inspection?.testMode ? "key-help" : undefined}
                            aria-invalid={!!keyError}
                            aria-errormessage={keyError ? "key-help" : undefined}
                          />
                          <div className="key-actions">
                            <button
                              type="button"
                              id="toggle-key"
                              className="key-action"
                              disabled={disabled || !apiKey}
                              aria-label={visibleKey ? "隐藏密钥" : "显示密钥"}
                              aria-pressed={visibleKey}
                              onClick={() => setVisibleKey((v) => !v)}
                            >
                              <Icon>
                                <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z" />
                                <circle cx="12" cy="12" r="3" />
                                {visibleKey && <path d="m2 2 20 20" />}
                              </Icon>
                            </button>
                            <button
                              type="button"
                              id="clear-key"
                              className="key-action"
                              disabled={disabled || !apiKey}
                              aria-label="清空输入的密钥"
                              onClick={() => {
                                setApiKey("");
                                setVisibleKey(false);
                                if (isKeyError(status)) setStatus("");
                              }}
                            >
                              <Icon>
                                <path d="m6 6 12 12M18 6 6 18" />
                              </Icon>
                            </button>
                          </div>
                        </div>
                        <p id="key-help" className={`field-feedback${keyError ? " error" : ""}`} role="status" aria-live="polite">
                          {keyError || (inspection?.testMode ? "当前使用隔离测试目录。" : "")}
                        </p>
                      </div>
                      <div id="settings" hidden={!expanded}>
                        <div className="settings-body">
                          <div className="label-row model-label">
                            <label htmlFor="model">模型</label>
                            <button
                              type="button"
                              id="refresh-models"
                              className="text-button"
                              disabled={disabled || modelsLoading}
                              aria-busy={modelsLoading}
                              onClick={() => setModelRefresh((v) => v + 1)}
                            >
                              {modelsLoading ? "正在获取模型…" : "刷新列表"}
                            </button>
                          </div>
                          <select
                            id="model"
                            value={model}
                            onChange={(e) => {
                              setPreviewPending(true);
                              setModel(e.target.value);
                            }}
                            disabled={disabled}
                            required
                          >
                            {[...new Set([model, ...availableModels])].map(
                              (value) => (
                                <option key={value} value={value}>
                                  {value}
                                </option>
                              ),
                            )}
                          </select>
                          <p
                            id="models-help"
                            className="field-feedback"
                            role="status"
                            title={!isKeyError(modelStatus) && modelStatus || undefined}
                          >
                            {!isKeyError(modelStatus) && modelStatus}
                          </p>
                          <label htmlFor="base-url">API 地址</label>
                          <div className="key-control base-url-control">
                            <input
                              id="base-url"
                              ref={baseUrlInput}
                              type="url"
                              value={baseUrl}
                              onChange={(e) => changeBaseUrl(e.target.value)}
                              disabled={disabled}
                              required
                              autoComplete="off"
                              spellCheck={false}
                            />
                            <div className="key-actions">
                              <button
                                id="clear-base-url"
                                type="button"
                                className="key-action"
                                aria-label="清空 API 地址"
                                title="清空 API 地址"
                                aria-controls="base-url"
                                disabled={disabled || !baseUrl}
                                onClick={() => {
                                  changeBaseUrl("");
                                  baseUrlInput.current?.focus({ preventScroll: true });
                                }}
                              >
                                <Icon><path d="m6 6 12 12M18 6 6 18" /></Icon>
                              </button>
                            </div>
                          </div>
                          <p className="field-feedback" aria-hidden="true" />
                          <label htmlFor="target">配置文件</label>
                          <div className="path-row">
                            <input
                              id="target"
                              value={inspection?.file || ""}
                              title={inspection?.file}
                              readOnly
                            />
                            <button
                              id="choose"
                              type="button"
                              className="secondary"
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  acceptInspection(await api.choose());
                                  setVisibleKey(false);
                                })
                              }
                            >
                              更改
                            </button>
                          </div>
                          <p className="field-feedback" aria-hidden="true" />
                          <p className="preview-heading">配置预览</p>
                          <div id="preview" aria-busy={previewPending}>
                            <div className="preview-meta">
                              <div className="version-row">
                                <span id="version-info" className="connection">
                                  {matching?.installations.length
                                    ? matching.installations.map(installationLabel).join(" / ")
                                    : "未检测到已安装版本"}
                                </span>
                                {!matching?.installations.length && (inspection?.platform === "windows" || inspection?.platform === "macos") && (
                                  <button
                                    type="button"
                                    className="text-button"
                                    disabled={busy}
                                    onClick={() => void run(async () => {
                                      await api.openChatgptInstaller();
                                      setWaitingForChatgptInstall(true);
                                      setStatus("已打开 Microsoft Store，等待安装完成…");
                                    })}
                                  >
                                    {waitingForChatgptInstall ? "等待安装完成…" : inspection.platform === "windows" ? "前往 Microsoft Store 安装" : "下载 Mac 安装包"}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  id="change-version"
                                  className="text-button"
                                  aria-expanded={versionOpen}
                                  aria-haspopup="dialog"
                                  disabled={busy}
                                  onClick={() => setVersionOpen(true)}
                                >
                                  选择 ChatGPT 版本
                                </button>
                              </div>
                              {matching && matching.selection.mode !== "auto" && (
                                <p className="preview-version selected-version">
                                  当前选择：{matching.selection.mode === "manual"
                                    ? installationLabel(matching.selection)
                                    : matching.installations.filter(v => matching.selection.mode === "installed" && v.id === matching.selection.id).map(installationLabel).join(" / ")}
                                </p>
                              )}
                              <div className="template-version-row">
                                <p id="preview-version" className="preview-version">
                                  配置模板：当前 {matching?.template ? `v${matching.template.version}` : "未获取"}
                                  {" · 最新 "}{matching?.latestTemplate ? `v${matching.latestTemplate.version}` : "未获取"}
                                  {matching?.offline ? "（缓存）" : ""}
                                </p>
                                <button
                                  type="button"
                                  id="update-template"
                                  className="text-button template-update"
                                  disabled={busy || versionPending || !matching?.templateUpdateAvailable}
                                  aria-label={matching?.templateUpdateAvailable ? "更新配置模板，有可用更新" : "更新配置模板"}
                                  title={matching?.templateUpdateAvailable ? "更新配置模板与预览" : "暂无可用的配置模板更新"}
                                  onClick={() =>
                                    void run(async () =>
                                      setMatching(await api.updateTemplate()),
                                    )
                                  }
                                >
                                  更新配置模板
                                  {matching?.templateUpdateAvailable && (
                                    <span className="template-update-dot" aria-hidden="true" />
                                  )}
                                </button>
                              </div>
                            </div>
                            <pre id="preview-code" aria-label="配置预览">
                              {previewError || preview}
                            </pre>
                          </div>
                        </div>
                      </div>
                      <div className="action-row">
                        <div className="action-options">
                          <label className="login-option">
                            <input
                              id="keep-official-login"
                              type="checkbox"
                              checked={keep}
                              onChange={(e) => {
                                setPreviewPending(true);
                                setLoginPreviewPending(true);
                                setKeep(e.target.checked);
                                setChannelTooltipOpen(false);
                              }}
                              disabled={disabled}
                            />
                            保留官方登录
                          </label>
                          <div className="channel-option">
                            <span className="channel-title" id="model-channel-label">提供商</span>
                            <div
                              id="model-channel"
                              className="channel-segments"
                              data-channel={inspection?.modelChannel}
                              role="radiogroup"
                              aria-labelledby="model-channel-label"
                              aria-busy={channelUpdating}
                              aria-disabled={disabled || !keep}
                              aria-describedby={channelTooltipOpen && !keep ? "provider-tooltip" : undefined}
                              tabIndex={!keep ? 0 : undefined}
                              onMouseEnter={() => setChannelTooltipOpen(!keep)}
                              onMouseLeave={() => setChannelTooltipOpen(false)}
                              onFocus={() => setChannelTooltipOpen(!keep)}
                              onBlur={(event) => {
                                if (!event.currentTarget.contains(event.relatedTarget)) setChannelTooltipOpen(false);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Escape") setChannelTooltipOpen(false);
                              }}
                            >
                              {([
                                ["api", "API"],
                                ["official", "官方"],
                              ] as const).map(([channel, label]) => (
                                <label className="channel-segment" key={channel}>
                                  <input
                                    type="radio"
                                    name="model-channel"
                                    value={channel}
                                    checked={inspection?.modelChannel === channel}
                                    disabled={disabled || !keep}
                                    onChange={() => switchChannel(channel)}
                                  />
                                  <span>{label}</span>
                                </label>
                              ))}
                              {channelTooltipOpen && !keep && (
                                <span id="provider-tooltip" className="channel-tooltip" role="tooltip">
                                  请先打开保留官方登录
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <button
                          id="apply"
                          data-ready={applyReady}
                          data-login-preview-pending={loginPreviewPending && !busy || undefined}
                          type="submit"
                          className="primary"
                          disabled={disabled || !applyReady || previewPending}
                        >
                          {busy && !channelUpdating ? "处理中…" : "一键配置"}
                        </button>
                      </div>
                    </div>
                    )}
                  </form>
                )}
              </section>
              <button
                id="open-history"
                type="button"
                className="history-entry"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setBackups(await api.backups());
                    setPage("history");
                  })
                }
              >
                <span className="summary-label">
                  <Icon>
                    <path d="M3 11a9 9 0 1 1 2 7M3 5v6h6m3-4v5l3 2" />
                  </Icon>
                  历史备份
                </span>
                <span className="summary-hint">查看备份记录</span>
                <Icon>
                  <path d="m9 6 6 6-6 6" />
                </Icon>
              </button>
            </div>
          ) : (
            <section id="history-page" aria-labelledby="history-title">
              <p className="history-description">
                保留最近 10 份备份，可查看或还原历史配置。
              </p>
              <div id="backups">
                {backups.length ? (
                  backups.map((backup) => (
                    <div className="backup" key={backup.id}>
                      <div>
                        <div className="backup-heading">
                          <p>{date(backup.created)}</p>
                          {backup.keepOfficialLogin && <span className="backup-login-badge">保留官方登录</span>}
                        </div>
                        {backup.baseUrl && <p className="backup-detail">{backup.baseUrl}</p>}
                      </div>
                      <div className="backup-actions">
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() => showBackup(backup.id)}
                        >
                          查看
                        </button>
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() => restoreBackup(backup.id)}
                        >
                          还原
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="empty">暂无备份</p>
                )}
              </div>
            </section>
          )}
          <p
            id="status"
            className={statusSuccess ? undefined : "error"}
            role="status"
            aria-live="polite"
            title={footerStatus || undefined}
          >
            {footerStatus || ((matching?.needsSelection || (versionPending && !versionOpen)) && (
              <>
                {versionPending && !versionOpen ? "请完成版本匹配。" : "没有匹配的配置模板。"}{" "}
                <button type="button" className="text-button" onClick={() => setVersionOpen(true)}>选择版本</button>
              </>
            ))}
          </p>
        </main>
      </div>
      <SoftwareUpdate busy={busy} run={run} open={updateOpen}
        onClose={() => setUpdateOpen(false)} onAvailable={setUpdateReady} />
      <VersionPicker
        open={versionOpen}
        matching={versionDraft || matching}
        onClose={closeVersion}
        onMatch={acceptVersionMatch}
        onPending={setVersionPending}
      />
      <dialog
        id="backup-preview"
        ref={dialog}
        aria-labelledby="backup-dialog-title"
        aria-describedby="backup-preview-note"
        tabIndex={-1}
        onClose={() => setSelectedBackup(null)}
      >
        <div className="version-dialog-header">
          <h2 id="backup-dialog-title">历史配置</h2>
          <button
            className="version-dialog-close"
            aria-label="关闭历史配置"
            onClick={() => dialog.current?.close()}
          >
            <Icon>
              <path d="m6 6 12 12M18 6 6 18" />
            </Icon>
          </button>
        </div>
        {selectedBackup && (
          <>
            <div className="backup-preview-meta">
              <p id="backup-preview-date" className="field-help">
                {date(selectedBackup.created)}
              </p>
              <p
                id="backup-preview-path"
                className="field-help"
                title={selectedBackup.file}
              >
                {selectedBackup.file}
              </p>
            </div>
            <div className="backup-preview-summary">
              {selectedBackup.baseUrl && <p className="field-help backup-preview-url" title={selectedBackup.baseUrl}>{selectedBackup.baseUrl}</p>}
              {selectedBackup.keepOfficialLogin && <span className="backup-login-badge">保留官方登录</span>}
              <p id="backup-preview-note" className="field-help">密钥已隐藏。</p>
            </div>
            {selectedBackup.existed ? (
              <pre
                id="backup-preview-code"
                tabIndex={0}
                aria-label="历史配置内容"
              >
                {selectedBackup.content || "（空配置文件）"}
              </pre>
            ) : (
              <p className="field-help">
                配置前文件不存在，还原将移除当前配置文件。
              </p>
            )}
            <p id="backup-preview-status" role="alert" title={dialogError || undefined}>
              {dialogError}
            </p>
            <div className="backup-preview-footer">
              <button
                className="text-button danger-button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await api.deleteBackup(selectedBackup.id);
                    if (!result.canceled) {
                      dialog.current?.close();
                      setSelectedBackup(null);
                      setBackups(await api.backups());
                    }
                  }, true)
                }
              >
                删除备份
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() => restoreBackup(selectedBackup.id, true)}
              >
                还原此配置
              </button>
            </div>
          </>
        )}
      </dialog>
    </>
  );
}
