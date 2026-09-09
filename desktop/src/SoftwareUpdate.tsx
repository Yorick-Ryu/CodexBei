// @refresh reset
// Native update resources must be recreated when this module is hot-reloaded.
import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

type Phase = "idle" | "checking" | "downloading" | "ready" | "installing" | "installed" | "error";

export function SoftwareUpdate({ busy, run, open, onClose, onAvailable }: {
  open: boolean;
  onClose: () => void;
  onAvailable: (value: boolean) => void;
  busy: boolean;
  run: (action: () => Promise<void>, inDialog?: boolean, clearStatus?: boolean) => Promise<void>;
}) {
  const [version, setVersion] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("启动后自动检查更新。");
  const [notes, setNotes] = useState("");
  const [nextVersion, setNextVersion] = useState("");
  const [progress, setProgress] = useState<number>();
  const dialog = useRef<HTMLDialogElement>(null);
  const update = useRef<Update | null>(null);
  const pending = useRef(false);
  const installed = useRef(false);
  const mounted = useRef(true);

  const checkNow = useCallback(async () => {
    if (pending.current || update.current || installed.current) return;
    pending.current = true;
    setPhase("checking");
    setMessage("正在检查更新…");
    let candidate: Update | null = null;
    try {
      candidate = await check({ timeout: 15000 });
      if (!mounted.current) return;
      if (!candidate) {
        setPhase("idle");
        setMessage("已是最新版本。");
        return;
      }
      setNextVersion(candidate.version);
      setNotes(candidate.body || "");
      setPhase("downloading");
      setMessage("正在后台下载更新…");
      setProgress(undefined);
      let received = 0;
      let total = 0;
      await candidate.download(event => {
        if (!mounted.current) return;
        if (event.event === "Started") total = event.data.contentLength || 0;
        if (event.event === "Progress") received += event.data.chunkLength;
        if (total) setProgress(Math.min(100, Math.round(received / total * 100)));
      }, { timeout: 120000 });
      if (!mounted.current) return;
      // download resolves only after the plugin verifies the package signature.
      update.current = candidate;
      candidate = null;
      setPhase("ready");
      setMessage("更新已准备好，重启后生效。");
    } catch {
      if (mounted.current) {
        setPhase("error");
        setMessage(candidate ? "更新下载或校验失败，请重试。" : "无法检查更新，请检查网络后重试。");
      }
    } finally {
      await candidate?.close().catch(() => {});
      pending.current = false;
    }
  }, []);

  useEffect(() => {
    void getVersion().then(setVersion).catch(() => {});
    return () => {
      mounted.current = false;
      void update.current?.close().catch(() => {});
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void checkNow(), 5000);
    const interval = setInterval(() => void checkNow(), 4 * 60 * 60 * 1000);
    return () => { clearTimeout(timer); clearInterval(interval); };
  }, [checkNow]);
  useEffect(() => {
    if (open && !dialog.current?.open) {
      dialog.current?.showModal();
      dialog.current?.focus({ preventScroll: true });
    } else if (!open) dialog.current?.close();
  }, [open]);

  const install = () => void run(async () => {
    if ((!update.current && !installed.current) || pending.current) return;
    pending.current = true;
    setPhase("installing");
    setMessage("正在安装更新…");
    try {
      if (!installed.current) {
        await update.current!.install();
        installed.current = true;
        await update.current!.close().catch(() => {});
        update.current = null;
      }
      await relaunch();
    } catch {
      setPhase(installed.current ? "installed" : "ready");
      setMessage(installed.current ? "更新已安装，请重启应用。" : "安装失败，请重试。当前版本仍可使用。");
    } finally {
      pending.current = false;
    }
  }, false, false);

  const canInstall = phase === "ready" || phase === "installed";
  useEffect(() => onAvailable(canInstall), [canInstall, onAvailable]);
  return <>
    <dialog id="software-update" ref={dialog} tabIndex={-1} aria-labelledby="software-update-title"
      onCancel={event => { if (phase === "installing") event.preventDefault(); }} onClose={onClose}>
      <div className="version-dialog-header">
        <h2 id="software-update-title">软件更新</h2>
        <button type="button" className="version-dialog-close" disabled={phase === "installing"}
          aria-label="关闭软件更新" onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </div>
      <p className="field-help">CodexBei · 当前版本 {version || "—"}</p>
      <p className="software-update-status" role="status" aria-live="polite">{message}</p>
      <div className="software-update-detail">
        {nextVersion && <p>新版本 {nextVersion}</p>}
        {phase === "downloading" && <progress max={100} value={progress} aria-label="更新下载进度" />}
        {notes && <p className="software-update-notes">{notes}</p>}
      </div>
      <div className="software-update-actions">
        <button className={canInstall ? "primary" : "secondary"} disabled={busy || ["checking", "downloading", "installing"].includes(phase)}
          onClick={canInstall ? install : () => void checkNow()}>
          {phase === "installing" ? "正在安装…" : canInstall ? "重启更新" : phase === "checking" ? "正在检查…" : phase === "downloading" ? "正在下载…" : "检查更新"}
        </button>
      </div>
    </dialog>
  </>;
}
