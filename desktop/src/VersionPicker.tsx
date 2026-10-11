import { Modal } from "./Modal";
import { useEffect, useRef, useState } from "react";
import { api, installationLabel, type Matching, type Selection } from "./api";
import { Select } from "./Select";
export function VersionPicker({
  open,
  matching,
  onClose,
  onMatch,
  onPending,
}: {
  open: boolean;
  matching: Matching | null;
  onClose: () => void;
  onMatch: (value: Matching) => void;
  onPending: (value: boolean) => void;
}) {
  const [mode, setMode] = useState("");
  const [kind, setKind] = useState<"cli" | "desktop">("cli");
  const [runtime, setRuntime] = useState("");
  const [app, setApp] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const revision = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (!matching) return;
    const s = matching.selection;
    setMode(s.mode === "installed" ? s.id : s.mode === "manual" ? "manual" : "");
    if (s.mode === "manual") {
      setKind(s.kind);
      setRuntime(s.runtimeVersion);
      setApp(s.appVersion || "");
    }
  }, [matching]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const request = (
    nextMode: string,
    nextKind = kind,
    nextRuntime = runtime,
    nextApp = app,
    immediate = false,
  ) => {
    clearTimeout(timer.current);
    const current = ++revision.current;
    onPending(true);
    setLoading(true);
    setError("");
    const selection: Selection =
      nextMode === "manual"
        ? {
            mode: "manual",
            kind: nextKind,
            runtimeVersion: nextRuntime.trim(),
            appVersion:
              nextKind === "desktop"
                ? nextApp.trim() || undefined
                : undefined,
          }
        : { mode: "installed", id: nextMode };
    timer.current = setTimeout(
      async () => {
        try {
          const result = await api.check(selection, true);
          if (revision.current === current) {
            onMatch(result);
            onPending(false);
          }
        } catch (e) {
          if (revision.current === current)
            setError(typeof e === "string" ? e : "版本匹配失败，请重试。");
        } finally {
          if (revision.current === current) setLoading(false);
        }
      },
      immediate || nextMode !== "manual" ? 0 : 400,
    );
  };
  return (
    <Modal id="version-choice" titleId="version-dialog-title" title="选择 ChatGPT 版本"
      open={open} onClose={onClose} closeLabel="关闭版本选择">
      <label htmlFor="installation">使用的 ChatGPT</label>
      <Select
        id="installation"
        aria-label="使用的 ChatGPT"
        value={mode}
        onChange={(e) => {
          setMode(e.target.value);
          request(e.target.value);
        }}
      >
        {mode === "" && <option value="" disabled>{matching ? "未检测到可用版本" : "正在检测版本…"}</option>}
        {matching?.installations.map((v) => (
          <option key={v.id} value={v.id}>
            {installationLabel(v)}
          </option>
        ))}
        <option value="manual">手动输入版本</option>
      </Select>
      {mode === "manual" && (
        <div id="manual-version">
          <label htmlFor="codex-kind">版本类型</label>
          <Select
            id="codex-kind"
            aria-label="版本类型"
            value={kind}
            onChange={(e) => {
              const value = e.target.value as "cli" | "desktop";
              setKind(value);
              request(mode, value);
            }}
          >
            <option value="cli">Codex CLI</option>
            <option value="desktop">ChatGPT 桌面版</option>
          </Select>
          <label htmlFor="runtime-version">{kind === "cli" ? "Codex CLI 版本" : "内核版本"}</label>
          <input
            id="runtime-version"
            value={runtime}
            placeholder="例如 0.153.4"
            maxLength={100}
            autoComplete="off"
            onChange={(e) => {
              setRuntime(e.target.value);
              request(mode, kind, e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                request(mode, kind, runtime, app, true);
              }
            }}
          />
          {kind === "desktop" && (
            <>
              <label htmlFor="app-version">桌面版应用版本（可选）</label>
              <input
                id="app-version"
                value={app}
                maxLength={64}
                placeholder="例如 26.901.51231"
                autoComplete="off"
                onChange={(e) => {
                  setApp(e.target.value);
                  request(mode, kind, runtime, e.target.value);
                }}
              />
            </>
          )}
        </div>
      )}
      <p
        id="version-status"
        role="status"
        className={`version-status ${error ? "error" : ""}`}
      >
        {error ||
          (loading
            ? "正在匹配…"
            : matching?.needsSelection
              ? "暂无匹配模板，请选择其他版本。"
              : "版本已匹配。")}
      </p>
    </Modal>
  );
}
