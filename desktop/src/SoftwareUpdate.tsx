// @refresh reset
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ArrowRightIcon } from "./icons";

type Phase = "idle" | "checking" | "available" | "downloading" | "ready" | "installing" | "installed" | "restarting" | "error";

export function useSoftwareUpdate({ busy, run }: {
  busy: boolean;
  run: (action: () => Promise<void>, inDialog?: boolean, clearStatus?: boolean) => Promise<void>;
}) {
  const [version, setVersion] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [nextVersion, setNextVersion] = useState("");
  const [progress, setProgress] = useState<number>();
  const update = useRef<Update | null>(null);
  const pending = useRef(false);
  const installed = useRef(false);
  const mounted = useRef(true);

  const checkNow = useCallback(async () => {
    if (pending.current || update.current || installed.current) return null;
    pending.current = true;
    setPhase("checking");
    setMessage("");
    try {
      const candidate = await check({ timeout: 15000 });
      if (!mounted.current) { await candidate?.close(); return null; }
      update.current = candidate;
      setNextVersion(candidate?.version || "");
      setPhase(candidate ? "available" : "idle");
      setMessage(candidate ? "" : "已是最新版本");
      return candidate;
    } catch {
      setPhase("error");
      setMessage("检查失败，点击重试");
      return null;
    } finally { pending.current = false; }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void getVersion().then(setVersion).catch(() => {});
    const timer = setTimeout(() => void checkNow(), 5000);
    const interval = setInterval(() => void checkNow(), 4 * 60 * 60 * 1000);
    return () => {
      mounted.current = false;
      clearTimeout(timer); clearInterval(interval);
      void update.current?.close().catch(() => {});
    };
  }, [checkNow]);

  const act = () => void run(async () => {
    if (pending.current) return;
    if (phase === "installed") {
      pending.current = true;
      setPhase("restarting");
      try { await relaunch(); }
      catch { setPhase("installed"); setMessage("重启失败，点击重试"); }
      finally { pending.current = false; }
      return;
    }
    const candidate = update.current || await checkNow();
    if (!candidate) return;
    pending.current = true;
    let verified = phase === "ready";
    try {
      if (!verified) {
        setPhase("downloading"); setMessage(""); setProgress(undefined);
        let received = 0;
        let total = 0;
        await candidate.download(event => {
          if (!mounted.current) return;
          if (event.event === "Started") total = event.data.contentLength || 0;
          if (event.event === "Progress") received += event.data.chunkLength;
          if (total) setProgress(Math.min(100, Math.round(received / total * 100)));
        }, { timeout: 120000 });
        verified = true; // The plugin has verified the package signature.
      }
      setPhase("installing");
      await candidate.install();
      installed.current = true;
      update.current = null;
      await candidate.close().catch(() => {});
      setPhase("restarting"); setMessage("");
      await relaunch();
    } catch {
      setPhase(installed.current ? "installed" : verified ? "ready" : "error");
      setMessage(installed.current ? "重启失败，点击重试" : verified ? "安装失败，点击重试" : "下载或校验失败，点击重试");
      if (!verified) { update.current = null; await candidate.close().catch(() => {}); }
    } finally { pending.current = false; }
  }, false, false);

  const working = ["checking", "downloading", "installing", "restarting"].includes(phase);
  const status = message || ({ idle: "", checking: "检查中", available: "发现新版本", downloading: "下载中", ready: "待安装", installing: "安装中", installed: "立即重启", restarting: "重启中", error: "重试" }[phase]);
  const available = !!nextVersion;
  const row = <button type="button" className="settings-diagnostic-row settings-update-row" aria-label="检查更新" disabled={busy || working} onClick={act} title={nextVersion ? `新版本 ${nextVersion}` : "检查更新"}>
    <span>检查更新</span>
    <span className="settings-row-tail">
      {working && <span className={`update-ring${phase === "downloading" && progress !== undefined ? " update-ring--determinate" : ""}`} role="progressbar" aria-label="更新进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={phase === "downloading" ? progress : undefined} style={{ "--progress": `${progress || 0}%` } as CSSProperties} />}
      {status && <small className="settings-update-status" role="status" aria-live="polite">{available && <span className="software-update-dot" role="img" aria-label="有新版本" />}<span>{status}{phase === "downloading" && <span className="update-percentage">{progress === undefined ? "\u00a0" : `${progress}%`}</span>}</span></small>}
      <small className="settings-update-versions" aria-label={nextVersion ? `当前版本 ${version || "未知"}，新版本 ${nextVersion}` : `当前版本 ${version || "未知"}`}>
        <span title="当前版本">{version ? `v${version}` : "版本未知"}</span>
        {nextVersion && <><ArrowRightIcon /><span title="新版本">v{nextVersion}</span></>}
      </small>
    </span>
  </button>;
  return { available, row };
}
