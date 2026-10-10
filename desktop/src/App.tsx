import {
  useCallback,
  useId,
  useMemo,
  type MutableRefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  toolApi,
  incomingTool,
  type Tool,
  type Mapping,
  type Speed,
  installationLabel,
  type Backup,
  type BackupPreview,
  type Inspection,
  type Matching,
  type Outcome,
} from "./api";
import { useSoftwareUpdate } from "./SoftwareUpdate";
import { VersionPicker } from "./VersionPicker";
import { RefreshIcon, InfoIcon, CheckIcon, ChevronLeftIcon, CloseIcon, EyeIcon, EyeOffIcon, SettingsIcon } from "./icons";
import { Select } from "./Select";
import { Modal } from "./Modal";
import { AppSettings } from "./AppSettings";
import { QuotaCard } from "./QuotaCard";
import { ThemeSelector } from "./ThemeSelector";
import brand from "../assets/brand/codexbei.svg";
import chatgpt from "../assets/agents/chatgpt.svg";
import claude from "../assets/agents/claude-code.svg";

function FieldInfo({ label, description }: { label: string; description: string }) {
  const tooltipId = useId();
  const [position, setPosition] = useState<{ left: number; top: number; above: boolean; arrowLeft: number } | null>(null);
  useEffect(() => {
    if (!position) return;
    const close = () => setPosition(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [position]);
  const show = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const above = rect.top >= 92;
    const center = rect.left + rect.width / 2;
    const left = Math.max(12, Math.min(center - 100, window.innerWidth - 212));
    setPosition({ left, top: above ? rect.top - 8 : rect.bottom + 8, above, arrowLeft: Math.max(12, Math.min(center - left, 188)) });
  };
  return <>
    <button type="button" className="text-button field-info" aria-label={`${label}说明`} aria-describedby={position ? tooltipId : undefined}
      onMouseEnter={event => show(event.currentTarget)} onMouseLeave={() => setPosition(null)}
      onFocus={event => show(event.currentTarget)} onBlur={() => setPosition(null)}
      onKeyDown={event => { if (event.key === "Escape") setPosition(null); }}
      onClick={event => { event.preventDefault(); if (!position) show(event.currentTarget); }}><InfoIcon /></button>
    {position && createPortal(<span id={tooltipId} role="tooltip" className="field-tooltip" data-above={position.above || undefined} style={{ left: position.left, top: position.top, transform: position.above ? "translateY(-100%)" : undefined }}>{description}<span className="field-tooltip-arrow" style={{ left: position.arrowLeft }} /></span>, document.body)}
  </>;
}

const toolTabs = [
  { id: "codex", name: "ChatGPT", icon: chatgpt, iconClass: "chatgpt-icon", disabled: false },
  { id: "claude", name: "Claude Code", icon: claude, iconClass: "", disabled: false },
] as const;

const date = (value: string) =>
  new Date(value).toLocaleString("zh-CN", { hour12: false });
const errorText = (error: unknown) =>
  typeof error === "string" ? error : "操作未完成，请重试。";
const configureFirstNotice = "请先保存连接配置";
// Match known credential failures, rather than routing any mention of a key here.
const isKeyError = (message: string) => [
  "请输入 API 密钥。",
  "请提供有效的 API 密钥",
  "API 地址已更改或没有可复用密钥，请填写对应密钥。",
  "请输入此地址对应的密钥。",
  "无法获取模型，请检查密钥及访问权限。",
].includes(message);

// Strip Windows verbatim prefixes for display only; keep the original path for I/O.
const displayPath = (path = "") => {
  if (path.startsWith("\\\\?\\UNC\\")) return "\\\\" + path.slice(8);
  if (/^\\\\\?\\[A-Za-z]:\\/.test(path)) return path.slice(4);
  return path;
};

const configuredSpeed = (tier?: string | null): Speed | undefined => {
  if (!tier || tier === "auto") return "standard";
  if (tier === "fast" || tier === "priority") return "fast";
  if (tier === "default") return "standard";
  return undefined;
};
type Draft = { apiKey: string; baseUrl: string; model: string; speed?: Speed; mapping: Mapping; keep: boolean; selectedChannel?: "api" | "official"; expanded: boolean; page?: "config" | "home"; inspection: Inspection; matching: Matching | null; preview: string; previewError: string };

export function App() {
  const drafts = useRef<Partial<Record<Tool, Draft>>>({});
  const [tool, setTool] = useState<Tool>("codex");
  useEffect(() => {
    let active = true;
    const route = () => { void incomingTool().then(value => { if (active && value) setTool(value); }).catch(() => {}); };
    const subscription = listen("incoming-changed", route);
    route();
    return () => { active = false; void subscription.then(unlisten => unlisten()); };
  }, []);
  return <ToolApp key={tool} activeTool={tool} setActiveTool={setTool} drafts={drafts} />;
}

function ToolApp({ activeTool, setActiveTool, drafts }: { activeTool: Tool; setActiveTool: (tool: Tool) => void; drafts: MutableRefObject<Partial<Record<Tool, Draft>>> }) {
  const initialDraft = useRef(drafts.current[activeTool]);
  const restoringDraft = useRef(!!initialDraft.current);
  const api = useMemo(() => toolApi(activeTool), [activeTool]);
  const isClaude = activeTool === "claude";
  const defaultBase = isClaude ? "https://api.beiapi.cn" : "https://api.beiapi.cn/v1";
  const defaultModel = isClaude ? "claude-sonnet-4-6" : "gpt-6-astra";
  const [mapping, setMapping] = useState<Mapping>(initialDraft.current?.mapping ?? {});
  const [inspection, setInspection] = useState<Inspection | null>(initialDraft.current?.inspection ?? null);
  const [apiKey, setApiKey] = useState(initialDraft.current?.apiKey ?? "");
  const inspectedOnce = useRef(false);
  const loadedKey = useRef<{ value: string; baseUrl: string } | null>(null);
  const [baseUrl, setBaseUrl] = useState(initialDraft.current?.baseUrl ?? defaultBase);
  const [model, setModel] = useState(initialDraft.current?.model ?? defaultModel);
  const [speed, setSpeed] = useState<Speed | undefined>(initialDraft.current?.speed ?? configuredSpeed(initialDraft.current?.inspection.serviceTier));
  const [keep, setKeep] = useState(initialDraft.current?.keep ?? false);
  const [selectedChannel, setSelectedChannel] = useState(initialDraft.current?.selectedChannel);
  const [officialLoginConfirmOpen, setOfficialLoginConfirmOpen] = useState(false);
  const [visibleKey, setVisibleKey] = useState(false);
  const [busy, setBusy] = useState(true);
  const [initializing, setInitializing] = useState(true);
  const [configuring, setConfiguring] = useState(false);
  const [channelSwitching, setChannelSwitching] = useState(false);
  const [transportSwitching, setTransportSwitching] = useState(false);
  const [speedSwitching, setSpeedSwitching] = useState(false);
  const [previewChannel, setPreviewChannel] = useState<string>();
  const [loginPreviewPending, setLoginPreviewPending] = useState(false);
  const [status, setStatus] = useState("");
  const [fileError, setFileError] = useState("");
  const fileErrorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (fileError) fileErrorRef.current?.scrollIntoView({ block: "nearest" });
  }, [fileError]);
  const [statusSuccess, setStatusSuccess] = useState(false);
  const [successNoticeId, setSuccessNoticeId] = useState(0);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const [matching, setMatching] = useState<Matching | null>(initialDraft.current?.matching ?? null);
  const [waitingForChatgptInstall, setWaitingForChatgptInstall] = useState(false);
  const [openingInstaller, setOpeningInstaller] = useState(false);
  const openingInstallerRef = useRef(false);
  const [installerError, setInstallerError] = useState("");
  const [installHintDismissed, setInstallHintDismissed] = useState(() => {
    try { return localStorage.getItem("codexbei.desktop-install-hint-dismissed") === "true"; }
    catch { return false; }
  });
  const [claudeInstallHintDismissed, setClaudeInstallHintDismissed] = useState(false);
  const openInstaller = async (directDownload = false) => {
    if (openingInstallerRef.current) return;
    openingInstallerRef.current = true;
    setOpeningInstaller(true);
    setInstallerError("");
    try {
      await api.openChatgptInstaller(directDownload);
      setWaitingForChatgptInstall(matching?.installations.length === 0);
    } catch (error) {
      setInstallerError(errorText(error));
    } finally {
      openingInstallerRef.current = false;
      setOpeningInstaller(false);
    }
  };
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
  const [expanded, setExpanded] = useState(initialDraft.current?.expanded ?? false);
  const [settingsOverflowReady, setSettingsOverflowReady] = useState(false);
  useEffect(() => {
    setSettingsOverflowReady(false);
    if (!expanded) return;
    const timer = window.setTimeout(() => setSettingsOverflowReady(true), 360);
    return () => window.clearTimeout(timer);
  }, [expanded]);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelStatus, setModelStatus] = useState("");
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelRefresh, setModelRefresh] = useState(0);
  const [page, setPage] = useState<"config" | "home" | "history">(initialDraft.current?.page ?? "config");
  const selectedTool = toolTabs.find(tool => tool.id === activeTool)!;
  const [preview, setPreview] = useState(initialDraft.current?.preview ?? "");
  const [previewError, setPreviewError] = useState(initialDraft.current?.previewError ?? "");
  const [previewPending, setPreviewPending] = useState(true);
  useEffect(() => {
    if (!initializing && !previewPending) restoringDraft.current = false;
  }, [initializing, previewPending]);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [selectedBackup, setSelectedBackup] = useState<BackupPreview | null>(
    null,
  );
  const [dialogError, setDialogError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const baseUrlInput = useRef<HTMLInputElement>(null);
  const homeTitle = useRef<HTMLHeadingElement>(null);
  const historyTitle = useRef<HTMLHeadingElement>(null);
  const busyRef = useRef(true);
  const keepRef = useRef(false);
  const incomingQueued = useRef(false);
  const drainIncoming = useRef<() => void>(() => {});
  keepRef.current = keep;
  const acceptInspection = useCallback((data: Inspection) => {
    setInspection(data);
    setSelectedChannel(undefined);
    setApiKey(data.apiKey || "");
    setVisibleKey(false);
    loadedKey.current = data.apiKey && data.baseUrl ? { value: data.apiKey, baseUrl: data.baseUrl } : null;
    setBaseUrl(data.baseUrl || defaultBase);
    setModel(data.model || defaultModel);
    setSpeed(configuredSpeed(data.serviceTier));
    setMapping(Object.fromEntries(Object.entries(data.mapping || {}).filter(([, value]) => value && value !== data.model)));
    setKeep(data.keepOfficialLogin);
    keepRef.current = data.keepOfficialLogin;
    const draft = initialDraft.current;
    initialDraft.current = undefined;
    if (!inspectedOnce.current) {
      setPage(draft?.page ?? (data.hasKey && data.baseUrl ? "home" : "config"));
      inspectedOnce.current = true;
    }
    if (draft) {
      setApiKey(draft.apiKey);
      setBaseUrl(draft.baseUrl);
      setModel(draft.model);
      setSpeed(draft.speed);
      setMapping(draft.mapping);
      setKeep(draft.keep);
      if (draft.inspection.file === data.file) setSelectedChannel(draft.selectedChannel);
      keepRef.current = draft.keep;
      setExpanded(draft.expanded);
    }
    document.body.dataset.platform =
      data.platform === "macos" ? "darwin" : data.platform;
  }, [defaultBase, defaultModel]);
  useEffect(() => {
    if (inspection) drafts.current[activeTool] = { apiKey, baseUrl, model, speed, mapping, keep, selectedChannel, expanded, page: page === "history" ? (inspection.hasKey && inspection.baseUrl ? "home" : "config") : page, inspection, matching, preview, previewError };
  }, [inspection, activeTool, apiKey, baseUrl, model, speed, mapping, keep, selectedChannel, expanded, page, matching, preview, previewError, drafts]);
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
      setPage("home");
      setVersionOpen(false);
      setVersionDraft(null);
      dialog.current?.close();
      setSelectedBackup(null);
      acceptInspection(await api.inspect());
      setMatching(await api.check());
      if (outcome?.warning) setStatus(outcome.warning);
    },
    [acceptInspection, api],
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
  const runFileAction = (action: () => Promise<void>) => void run(async () => {
    setFileError("");
    try {
      await action();
    } catch (error) {
      setFileError(errorText(error));
    }
  });
  const applyLoginPreference = async (enabled: boolean) => {
    await api.switchLoginPreference(enabled);
    const saved = await api.inspect();
    setInspection(saved);
    setKeep(enabled);
    keepRef.current = enabled;
    setPreviewPending(true);
    setLoginPreviewPending(true);
    setStatusSuccess(true);
    setStatus(`${enabled ? "已开启" : "已关闭"}保留官方登录，重启 ChatGPT 后生效`);
    setSuccessNoticeId(value => value + 1);
  };
  const changeLoginPreference = (enabled: boolean) => {
    void run(async () => {
      if (!enabled || await api.hasOfficialLogin()) await applyLoginPreference(enabled);
      else setOfficialLoginConfirmOpen(true);
    });
  };
  const switchChannel = (channel: "api" | "official") => {
    void run(async () => {
      setChannelSwitching(true);
      try {
        try {
          await api.switchChannel(channel);
        } catch (error) {
          if (errorText(error) === "请先完成 API 密钥配置。") {
            setStatus(apiKey.trim() ? configureFirstNotice : "请输入 API 密钥。");
            return;
          }
          throw error;
        }
        // A channel switch only changes routing; preserve unsaved form edits.
        setSelectedChannel(channel);
        setInspection(await api.inspect());
        setStatusSuccess(true);
        setStatus(`模型供应商已切换为 ${channel === "api" ? "API" : "官方"}，新对话生效`);
        setSuccessNoticeId(value => value + 1);
      } finally {
        setChannelSwitching(false);
      }
    });
  };
  const switchSpeed = (next: Speed) => {
    if (next === speed) return;
    void run(async () => {
      setSpeedSwitching(true);
      try {
        await api.switchSpeed(next);
        // Only refresh saved state; keep other unsaved form edits.
        setInspection(await api.inspect());
        setPreviewPending(true);
        setSpeed(next);
        setStatusSuccess(true);
        setStatus(`响应速度已切换为${next === "fast" ? "快速" : "标准"}，新对话生效`);
        setSuccessNoticeId(value => value + 1);
      } finally {
        setSpeedSwitching(false);
      }
    });
  };
  const switchTransport = (supportsWebsockets: boolean) => {
    void run(async () => {
      setTransportSwitching(true);
      try {
        await api.switchTransport(supportsWebsockets);
        // Refresh saved state without replacing unsaved key, model or URL edits.
        setInspection(await api.inspect());
        setStatusSuccess(true);
        setStatus(`已${supportsWebsockets ? "启用" : "关闭"} WebSocket，新对话生效`);
        setSuccessNoticeId(value => value + 1);
      } finally {
        setTransportSwitching(false);
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
        // Tab remounts reuse the backend template cache; installation polling stays forced.
        const info = await api.check();
        if (active) setMatching(info);
      } catch (error) {
        if (active) setStatus(errorText(error));
      } finally {
        if (active) {
          busyRef.current = false;
          setInitializing(false);
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
  }, [acceptInspection, api, isClaude]);
  useEffect(() => {
    let active = true;
    // Keep the previous layout while IPC produces the replacement preview.
    // Clearing it here collapses the page and clamps WebKit's scroll position.
    setPreviewPending(true);
    setPreviewError("");
    void api.preview(baseUrl, model, keep, selectedChannel, mapping, speed).then(
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
  }, [baseUrl, model, speed, keep, selectedChannel, matching?.template?.digest, inspection?.modelChannel, inspection?.hasKey, inspection?.supportsWebsockets, inspection?.file, mapping, api]);
  useEffect(() => {
    if (!waitingForChatgptInstall) return;
    let active = true;
    let checking = false;
    const poll = async () => {
      if (checking || busyRef.current || versionOpenRef.current) return;
      checking = true;
      try {
        const info = await api.check(null, true);
        if (!active || busyRef.current || versionOpenRef.current) return;
        setMatching(info);
        if (info.installations.length > 0) {
          setWaitingForChatgptInstall(false);
        }
      } catch {
        // The Store may still be installing or the app may be offline.
      } finally {
        checking = false;
      }
    };
    void poll();
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => void poll(), 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
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
    if (page === "home") homeTitle.current?.focus();
    if (page === "history") historyTitle.current?.focus();
  }, [page]);
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
  const channelUpdating = channelSwitching || transportSwitching || speedSwitching || (!!inspection && previewChannel !== undefined && previewChannel !== inspection.modelChannel);
  const applyReady = !!(apiKey.trim() && baseUrl.trim() && model.trim() && matching && !matching.needsSelection && !versionPending && (!previewPending || channelUpdating || loginPreviewPending) && preview && !previewError);
  const softwareUpdate = useSoftwareUpdate({ busy, run });
  const hasCli = !!matching?.installations.some(item => item.kind === "cli");
  const hasDesktop = !!matching?.installations.some(item => item.kind === "desktop");
  const connectedToolName = !isClaude && hasCli && !hasDesktop ? "Codex CLI" : selectedTool.name;
  const missingDesktop = !isClaude && !!matching && !hasDesktop && (inspection?.platform === "windows" || inspection?.platform === "macos");
  const installerLabel = inspection?.platform === "windows" ? "安装桌面版" : "下载桌面版";
  const needsVersionNotice = !!(matching?.needsSelection || (versionPending && !versionOpen));
  const missingClaude = isClaude && !!matching && !matching.installations.length;
  const showInstallHint = page === "config" && (missingClaude ? !claudeInstallHintDismissed : missingDesktop && hasCli && !installHintDismissed) && !footerStatus && !installerError && !needsVersionNotice;
  const showNotice = !!(footerStatus || installerError || needsVersionNotice || showInstallHint);
  const noticeKind = footerStatus ? (statusSuccess ? "success" : footerStatus === configureFirstNotice ? "info" : "error") : (installerError || needsVersionNotice ? "error" : "info");
  useEffect(() => setNoticeDismissed(false), [status, installerError, needsVersionNotice, showInstallHint, successNoticeId]);
  const closeNotice = () => {
    setNoticeDismissed(true);
    if (footerStatus) { setStatus(""); setStatusSuccess(false); }
    else if (installerError) setInstallerError("");
    else if (showInstallHint) {
      if (isClaude) { setClaudeInstallHintDismissed(true); return; }
      setInstallHintDismissed(true);
      try { localStorage.setItem("codexbei.desktop-install-hint-dismissed", "true"); } catch { /* Keep dismissal for this session. */ }
    }
  };
  const connectionControls = !isClaude ? (<div className="action-options">
      <div className="login-option preference-row">
        <span className="field-caption">保留官方登录<FieldInfo label="保留官方登录" description="保留 ChatGPT 官方账号登录。立即保存，重启 ChatGPT 后生效。" /></span>
        <input id="keep-official-login" aria-label="保留官方登录" type="checkbox" role="switch" checked={keep} onChange={event => changeLoginPreference(event.target.checked)} disabled={disabled} />
      </div>
      <div className="channel-option provider-option">
        <span className="option-caption provider-caption"><span className="setting-title">模型供应商
          <FieldInfo label="模型供应商" description="切换模型供应商，新对话生效" /></span>
        </span>
        <Select id="model-channel" aria-label="模型供应商" value={inspection?.modelChannel ?? "api"} disabled={disabled} onChange={event => switchChannel(event.target.value as "api" | "official")}>
          <option value="api">API</option><option value="official">官方</option>
        </Select>
      </div>
      <div className="channel-option transport-option">
        <div className="login-option preference-row">
          <span className="field-caption"><span className="setting-title">启用 WebSocket<FieldInfo label="启用 WebSocket" description="使用 WebSocket 传输，需要服务商支持；关闭时使用 HTTP。立即保存，新对话生效。" /></span></span>
          <input id="transport-protocol" aria-label="启用 WebSocket" type="checkbox" role="switch" checked={!!inspection?.supportsWebsockets} disabled={disabled || !inspection?.baseUrl} onChange={event => switchTransport(event.target.checked)} />
        </div>
      </div>
      <div className="channel-option speed-option">
        <span className="option-caption"><span className="setting-title">响应速度<FieldInfo label="响应速度" description="标准为默认速度；快速需要服务商支持。立即保存，新对话生效。" /></span></span>
        <Select id="speed" aria-label="响应速度" value={speed} disabled={disabled} onChange={event => switchSpeed(event.target.value as Speed)}><option value="standard">标准</option><option value="fast">快速</option><option value="ultrafast" disabled>超快</option></Select>
      </div>
    </div>) : null;
  return (
    <>
      <header className="app-header" data-history={page === "history" || undefined}>
        {page === "history" ? (
          <div className="brand-row" data-tauri-drag-region />
        ) : (
          <div className="brand-row" data-tauri-drag-region>
            <div className="brand">
              <img className="logo" src={brand} alt="" />
              CodexBei
            </div>
            <div className="toolbar-actions">
              <div className="tabs" role="tablist" aria-label="选择工具">
                {toolTabs.map(tool => (
                  <button
                    key={tool.id}
                    role="tab"
                    aria-selected={activeTool === tool.id}
                    aria-controls={activeTool === tool.id ? `${activeTool}-panel` : undefined}
                    id={`${tool.id}-tab`}
                    disabled={(busy && !initializing) || tool.disabled}
                    onClick={() => setActiveTool(tool.id)}
                    onKeyDown={event => {
                      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                        event.preventDefault();
                        setActiveTool(activeTool === "codex" ? "claude" : "codex");
                      }
                    }}
                  >
                    <img className={`agent-icon ${tool.iconClass}`} src={tool.icon} alt="" />
                    {tool.name}
                    {tool.disabled && <span>即将支持</span>}
                  </button>
                ))}
              </div>
              <AppSettings baseUrl={baseUrl} theme={<ThemeSelector />} updateAvailable={softwareUpdate.available}
                isWindows={!isClaude && (inspection?.platform === "windows" || (!inspection && /Win/i.test(navigator.platform)))}
                updateRow={softwareUpdate.row} historyBusy={busy} onOpenHistory={() => void run(async () => {
                  setBackups(await api.backups());
                  setPage("history");
                })} />
            </div>
          </div>
        )}
      </header>
      <div className="content-scroll">
        <main data-page={page} data-settings-expanded={page === "config" && expanded || undefined} className={page !== "history" ? "config-main" : undefined} data-restore-ready={restoringDraft.current && !!apiKey.trim() && !!preview && !previewError && !!matching && !matching.needsSelection || undefined} data-restoring={(initializing || previewPending) && restoringDraft.current || undefined} data-channel-updating={channelUpdating || undefined} data-has-key={!!apiKey} data-has-base-url={!!baseUrl} data-template-update={!!matching?.templateUpdateAvailable}>
          {page !== "history" ? (
            <div id="configuration-page">
              <section
                id={`${activeTool}-panel`}
                role="tabpanel"
                aria-labelledby={`${activeTool}-tab`}
              >
                {page === "home" && <div id="connection-home" aria-labelledby="home-title">
                  <div className="connection-summary">
                    <div className="connection-summary-top">
                      <h1 id="home-title" className="config-title" tabIndex={-1} ref={homeTitle}>
                        <img className={selectedTool.iconClass} src={selectedTool.icon} alt="" />
                        {connectedToolName} 已就绪
                      </h1>
                      <button id="edit-connection" type="button" className="text-button settings-toggle" disabled={busy} onClick={() => { setExpanded(true); setPage("config"); }}><SettingsIcon />修改配置</button>
                    </div>
                  </div>
                  {connectionControls && <><h2 className="home-section-title">快速配置</h2>{connectionControls}</>}
                  <div className="home-balance">
                    <h2 className="home-section-title">余额</h2>
                    <QuotaCard inspection={inspection!} tool={activeTool} />
                  </div>


                </div>}
                  <form
                    id="configure"
                    hidden={page === "home"}
                    aria-busy={busy}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void run(async () => {
                        setConfiguring(true);
                        try {
                          const result = await api.configure(
                            { apiKey, baseUrl, model },
                            keep,
                            mapping,
                            selectedChannel,
                            speed,
                          );
                          if (!result.canceled) await completed(result);
                        } finally {
                          setConfiguring(false);
                        }
                      });
                    }}
                  >
                    {!isClaude && matching && !matching.installations.length ? (
                      <div className="config-card install-card">
                        <div className="install-card-icon"><img className={selectedTool.iconClass} src={selectedTool.icon} alt="" /></div>
                        <h2 className="config-title">未检测到 {selectedTool.name}</h2>
                        <p className="install-card-message">
                          请先下载安装 ChatGPT 桌面版，完成后开放配置功能。
                        </p>
                        <div className="install-card-actions">
                          <button
                            type="button"
                            className="primary install-card-action"
                            disabled={openingInstaller}
                            onClick={() => void openInstaller()}
                          >
                            {inspection?.platform === "windows" ? "微软商店下载" : "下载桌面版"}
                          </button>
                          {inspection?.platform === "windows" && (
                            <button type="button" className="secondary install-card-action" disabled={openingInstaller} onClick={() => void openInstaller(true)}>
                              下载安装程序
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                    <div className="config-card">
                      <div className="provider-row">
                        <div className="provider-info">
                          <h2 className="config-title">
                            <img className={selectedTool.iconClass} src={selectedTool.icon} alt="" />
                            配置 {selectedTool.name}
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
                          <SettingsIcon />
                          {expanded ? "折叠" : "展开"}
                        </button>
                      </div>
                      <h2 className="config-section-title connection-section-title">API 连接</h2>
                      <div className="credentials-card">
                      <div className="credential-field">
                            <div className="label-row"><span className="setting-title"><label htmlFor="base-url">API 地址</label><FieldInfo label="API 地址" description="填写服务商提供的 API 地址。" /></span></div>
                            <div className="key-control base-url-control">
                              <input
                                id="base-url"
                                aria-label="API 地址"
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
                                  <CloseIcon />
                                </button>
                              </div>
                            </div>
                            <p className="field-feedback" aria-hidden="true" />
                      </div>
                      <div className="credential-field api-key-field">
                        <div className="label-row">
                          <span className="setting-title"><label htmlFor="key">API 密钥</label><FieldInfo label="API 密钥" description="填写此服务商的 API 密钥。" /></span>
                        </div>
                        <div className="key-control">
                          <input
                            id="key"
                            aria-label="API 密钥"
                            type={visibleKey ? "text" : "password"}
                            value={apiKey}
                            onChange={(e) => {
                              setApiKey(e.target.value);
                              if (isKeyError(status)) setStatus("");
                            }}
                            autoComplete="off"
                            spellCheck={false}
                            required
                            disabled={configuring || !inspection}
                            aria-describedby="key-help"
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
                              {visibleKey ? <EyeOffIcon /> : <EyeIcon />}
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
                              <CloseIcon />
                            </button>
                          </div>
                        </div>
                        <p id="key-help" className={`field-feedback${keyError ? " error" : ""}`} role="status" aria-live="polite">
                          {keyError}
                        </p>
                      </div>
                      </div>
                      <div id="settings" className="settings-collapse" data-expanded={expanded} data-overflow-ready={settingsOverflowReady}
                        aria-hidden={!expanded} ref={element => { if (element) element.inert = !expanded; }}>
                        <div className="settings-clip">
                          <div className="settings-body">
                            <h2 className="config-section-title">快速配置</h2>
                            <div className="quick-config-card">
                            <div className="settings-field-row model-field-row">
                            <div className="label-row model-label">
                              <span className="setting-title"><label htmlFor="model">模型</label><FieldInfo label="模型" description="选择对话使用的模型，保存配置后新对话生效。" /></span>

                            </div>
                            <div className="model-controls">
                            <Select
                              id="model"
                              aria-label="模型"
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
                            </Select>
                              <button
                                type="button"
                                id="refresh-models"
                                aria-label={modelsLoading ? "正在刷新模型" : "刷新模型"}
                                className="text-button"
                                disabled={disabled || modelsLoading}
                                aria-busy={modelsLoading || busy}
                                title="刷新可选模型，点击保存后生效"
                                onClick={() => void run(async () => {
                                  setModelRefresh(v => v + 1);
                                })}
                              >
                                <RefreshIcon />
                              </button>
                            </div>
                            </div>
                            <p
                              id="models-help"
                              className="field-feedback"
                              role="status"
                              title={!isKeyError(modelStatus) && modelStatus || undefined}
                            >
                              {!isKeyError(modelStatus) && modelStatus}
                            </p>
                            {connectionControls}
                            {isClaude && (["opus", "sonnet", "haiku"] as const).map(tier => (
                              <div key={tier} className="settings-field-row">
                                <span className="setting-title"><label htmlFor={`mapping-${tier}`}>{tier[0].toUpperCase() + tier.slice(1)} 模型</label><FieldInfo label={`${tier} 模型`} description="为此类型选择专用模型，也可以跟随所选模型。" /></span>
                                <Select aria-label={`${tier} 模型`} id={`mapping-${tier}`} value={mapping[tier] || ""} disabled={disabled}
                                  onChange={event => { setPreviewPending(true); setMapping(value => ({...value, [tier]: event.target.value || undefined})); }}>
                                  <option value="">跟随所选模型</option>
                                  {[...new Set([model, mapping[tier], ...availableModels].filter((v): v is string => !!v))].map(value => <option key={value} value={value}>{value}</option>)}
                                </Select>
                                <p className="field-feedback" aria-hidden="true" />
                              </div>
                            ))}
                            </div>
                            <h2 className="config-section-title">更多</h2>
                            <div className="more-config-card">
                            <div className="settings-field-row config-file-row">
                            <span className="setting-title"><label htmlFor="target">配置文件</label><FieldInfo label="配置文件" description="配置保存到此文件，可打开查看或更改位置。" /></span>
                            <div className="path-row">
                              <input
                                id="target"
                                aria-label="配置文件"
                                aria-describedby={fileError ? "file-error" : undefined}
                                value={displayPath(inspection?.file)}
                                title={displayPath(inspection?.file)}
                                readOnly
                              />
                              <button
                                id="open-config"
                                type="button"
                                className="secondary"
                                disabled={busy}
                                onClick={() => runFileAction(() => api.openConfigFile())}
                              >
                                打开
                              </button>
                              <button
                                id="choose"
                                type="button"
                                className="secondary"
                                disabled={busy}
                                onClick={() =>
                                  runFileAction(async () => {
                                    acceptInspection(await api.choose());
                                    setVisibleKey(false);
                                  })
                                }
                              >
                                更改
                              </button>
                            </div>
                            </div>
                            <p id="file-error" ref={fileErrorRef} className="field-feedback error file-error" role="alert">{fileError}</p>
                            <p className="preview-heading">配置预览<FieldInfo label="配置预览" description="查看将要写入的配置，密钥已隐藏。" /></p>
                            <div id="preview" aria-busy={previewPending}>
                              <div className="preview-meta">
                                <div className="version-row">
                                  <span id="version-info" className="connection selected-version">
                                    {matching?.selection.mode === "manual"
                                      ? installationLabel(matching.selection)
                                      : matching?.selection.mode === "installed"
                                        ? matching.installations.filter(v => matching.selection.mode === "installed" && v.id === matching.selection.id).map(installationLabel).join(" / ")
                                        : matching?.installations.length
                                          ? installationLabel(matching.installations.find(v => v.kind === "desktop" && v.runtimeVersion) || matching.installations.find(v => v.runtimeVersion) || matching.installations[0])
                                          : "未检测到已安装版本"}
                                  </span>
                                  {missingDesktop && (
                                    <button
                                      type="button"
                                      className="text-button"
                                      disabled={openingInstaller}
                                      onClick={() => void openInstaller()}
                                    >
                                      {installerLabel}
                                    </button>
                                  )}
                                  {!isClaude && <button
                                    type="button"
                                    id="change-version"
                                    className="text-button"
                                    aria-expanded={versionOpen}
                                    aria-haspopup="dialog"
                                    disabled={busy}
                                    onClick={() => setVersionOpen(true)}
                                  >
                                    选择 ChatGPT 版本
                                  </button>}
                                </div>
                                {!isClaude && <div className="template-version-row">
                                  <p id="preview-version" className="preview-version">
                                    {matching?.offline ? (
                                      <>本地模板 {matching.latestTemplate ? `v${matching.latestTemplate.version}` : matching.template ? `v${matching.template.version}` : "未获取"} · 暂时无法检查更新</>
                                    ) : (
                                      <>配置模板：当前 {matching?.template ? `v${matching.template.version}` : "未获取"}
                                        {" · 最新 "}{matching?.latestTemplate ? `v${matching.latestTemplate.version}` : "未获取"}</>
                                    )}
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
                                </div>}
                              </div>
                              <pre id="preview-code" aria-label="配置预览">
                                {previewError || preview}
                              </pre>
                            </div>
                            </div>
                          </div>
                        </div>
                      </div>

                    </div>
                    )}
                  </form>
              </section>
            </div>
          ) : (
            <section id="history-page" aria-labelledby="history-title">
              <div className="history-page-header">
                <button
                  id="back-to-config"
                  className="history-back"
                  disabled={busy}
                  aria-label="返回配置"
                  onClick={() => setPage(inspection?.hasKey && inspection.baseUrl ? "home" : "config")}
                >
                  <ChevronLeftIcon />
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
        </main>
      </div>
      {page === "config" && inspection && (isClaude || !!matching?.installations.length) && (
                      <div className="config-footer">
                      {inspection?.hasKey && <button id="cancel-edit" type="button" disabled={busy} className="text-button cancel-edit" onClick={() => { acceptInspection(inspection); setPage("home"); }}>取消</button>}
                        <button
                          id="apply"
                          data-ready={applyReady}
                          data-login-preview-pending={loginPreviewPending && !busy || undefined}
                          type="submit"
                          form="configure"
                          className="primary"
                          disabled={disabled || !applyReady || previewPending}
                        >
                          {configuring ? "保存中…" : "保存"}
                        </button>
                      </div>
      )}
      <Modal id="notification-dialog" title={noticeKind === "success" ? "配置已更新" : noticeKind === "error" ? "操作提示" : "提示"}
        closeLabel="关闭提示" descriptionId="status"
        open={showNotice && !noticeDismissed && !versionOpen && !officialLoginConfirmOpen && !selectedBackup} onClose={closeNotice}>
        <div id="status" className={noticeKind}
          role={noticeKind === "error" ? "alert" : "status"}>
          <span>
            {footerStatus || installerError || (needsVersionNotice ? (
              <>
                {versionPending && !versionOpen ? "请完成版本匹配。" : "没有匹配的配置模板。"}{" "}
                <button type="button" className="text-button" onClick={() => setVersionOpen(true)}>选择版本</button>
              </>
            ) : showInstallHint && (
              isClaude ? <>
                <span>未检测到 Claude Code，可先保存配置，安装后新会话生效。</span>
                <button type="button" className="text-button" disabled={busy} onClick={() => void run(() => api.openClaudeInstaller())}>安装指南</button>
              </> : <>
                <span>未检测到桌面版，Codex CLI 可正常配置</span>
                <button type="button" className="text-button" disabled={openingInstaller} onClick={() => void openInstaller()}>{installerLabel}</button>
              </>
            ))}
          </span>
        </div>
        <div className="modal-actions"><button type="button" className="primary" onClick={closeNotice}>知道了</button></div>
      </Modal>
      <Modal id="official-login-confirm" title="开启保留官方登录"
        descriptionId="official-login-confirm-description"
        open={officialLoginConfirmOpen} onClose={() => setOfficialLoginConfirmOpen(false)}>
        <p id="official-login-confirm-description">当前未检测到官方账号，是否仍要开启“保留官方登录”？</p>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={() => {
            setOfficialLoginConfirmOpen(false);
            void run(() => applyLoginPreference(true));
          }}>仍要开启</button>
          <button type="button" className="primary" onClick={() => setOfficialLoginConfirmOpen(false)}>保持关闭</button>
        </div>
      </Modal>
      <VersionPicker
        open={versionOpen}
        matching={versionDraft || matching}
        onClose={closeVersion}
        onMatch={acceptVersionMatch}
        onPending={setVersionPending}
      />
      <Modal id="backup-preview" dialogRef={dialog} titleId="backup-dialog-title"
        descriptionId="backup-preview-note" title="历史配置" size="wide" tall
        open={!!selectedBackup} onClose={() => setSelectedBackup(null)}>
        {selectedBackup && (
          <>
            <div className="backup-preview-meta">
              <p id="backup-preview-date" className="field-help">
                {date(selectedBackup.created)}
              </p>
              <p
                id="backup-preview-path"
                className="field-help"
                title={displayPath(selectedBackup.file)}
              >
                {displayPath(selectedBackup.file)}
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
      </Modal>
    </>
  );
}
