import { useEffect, useRef, useState } from "react";
import { ChevronRightIcon, RefreshIcon } from "./icons";
import { toolApi, type Tool, type Inspection, type Quota, type QuotaRow } from "./api";

const time = (value: number) => new Date(value * 1000).toLocaleString("zh-CN", {
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});
const expiryLabel = (value: number) => {
  const seconds = value - Date.now() / 1000;
  if (seconds <= 0) return "已到期";
  if (seconds < 86400) return <>剩余不足 <strong className="quota-expiry-days">1</strong> 天</>;
  return <>剩余 <strong className="quota-expiry-days">{Math.floor(seconds / 86400)}</strong> 天</>;
};
function Rows({ rows, amounts = false }: { rows: QuotaRow[]; amounts?: boolean }) {
  return <div className="quota-content">{rows.map((row, index) => <div className="quota-row" key={index}>
    <div><span>{row.label}</span><strong title={row.remaining != null ? row.value : undefined}>{row.remaining != null ? `剩余 ${Math.round(row.remaining)}%` : row.value}</strong></div>
    <div className="quota-meter" role="progressbar" aria-label={row.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.remaining == null ? undefined : Math.max(0, Math.min(100, row.remaining))} aria-hidden={row.remaining == null || undefined} style={{ visibility: row.remaining == null ? "hidden" : "visible" }}><div className="quota-meter-fill" style={{ width: `${Math.max(0, Math.min(100, row.remaining ?? 0))}%` }} /></div>
    <div className="quota-row-footer"><small>{row.resetPending ? "等待额度重置" : row.resetAt ? `${time(row.resetAt)} 重置` : "\u00a0"}</small>{amounts && row.remaining != null && <small className="quota-amount">{row.value}</small>}</div>
  </div>)}</div>;
}
type QuotaResult = { identity: string; data?: Quota; error?: string };
type QuotaEntry = { identity: string; settled: boolean; result?: QuotaResult; promise: Promise<QuotaResult> };
// Session-only cache survives tool-tab remounts. Keep just the current identity
// per source; credentials and quota snapshots are never persisted to storage.
const quotaCache = new Map<Tool, QuotaEntry>();
const retryDelays = [5000, 15000, 30000];
function loadQuota(tool: Tool, channel: "api", identity: string, force: boolean): QuotaEntry {
  const cached = quotaCache.get(tool);
  // Share pending requests and successful snapshots, but allow failed queries to recover.
  if (cached?.identity === identity && (!cached.settled || (!force && cached.result?.data))) return cached;
  const entry: QuotaEntry = { identity, settled: false, result: cached?.identity === identity ? cached.result : undefined, promise: Promise.resolve({ identity }) };
  entry.promise = toolApi(tool).quota(channel).then(data => {
    if (!data || data.channel !== channel || !Array.isArray(data.rows)) throw new Error("Invalid quota source");
    return { identity, data };
  }).catch(error => ({ identity, error: typeof error === "string" ? error : "暂时无法获取额度。" })).then(result => {
    entry.result = result;
    entry.settled = true;
    return result;
  });
  quotaCache.set(tool, entry);
  return entry;
}
function Source({ tool, channel, identity, baseUrl }: { tool: Tool; channel: "api"; identity: string; baseUrl: string }) {
  const [refresh, setRefresh] = useState(0);
  const [walletError, setWalletError] = useState("");
  const [plansOpen, setPlansOpen] = useState(false);
  const showPlans = tool !== "claude";
  const retryCount = useRef(0);
  const cached = quotaCache.get(tool);
  const initial = cached?.identity === identity ? cached.result : undefined;
  const [result, setResult] = useState<QuotaResult | undefined>(initial);
  const [loading, setLoading] = useState(cached?.identity === identity ? !cached.settled : true);
  useEffect(() => {
    let active = true;
    const entry = loadQuota(tool, channel, identity, refresh > 0);
    setResult(previous => entry.result ?? (previous?.identity === identity ? previous : undefined));
    setLoading(!entry.settled);
    void entry.promise.then(value => {
      if (active) { setResult(value); setLoading(false); }
    });
    return () => { active = false; };
  }, [tool, channel, identity, refresh]);
  useEffect(() => { setPlansOpen(false); }, [identity]);
  const current = result?.identity === identity ? result : undefined;
  useEffect(() => {
    if (current?.error === undefined) { retryCount.current = 0; return; }
    if (loading) return;
    const canRetry = () => document.visibilityState !== "hidden" && navigator.onLine;
    const delay = retryDelays[retryCount.current];
    const timer = delay === undefined ? undefined : window.setTimeout(() => {
      if (!canRetry()) return;
      retryCount.current += 1;
      setRefresh(value => value + 1);
    }, delay);
    const retryOnReturn = () => {
      if (!canRetry()) return;
      retryCount.current = 0;
      setRefresh(value => value + 1);
    };
    window.addEventListener("online", retryOnReturn);
    window.addEventListener("focus", retryOnReturn);
    document.addEventListener("visibilitychange", retryOnReturn);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("online", retryOnReturn);
      window.removeEventListener("focus", retryOnReturn);
      document.removeEventListener("visibilitychange", retryOnReturn);
    };
  }, [current, loading, identity]);
  if (!current?.data || (!current.data.rows.length && (!showPlans || !current.data.groups?.some(group => group.rows.length)))) return null;
  return <aside className="quota-panel" aria-label="API 额度">
    <section className="quota-source quota-api" aria-label="API 额度详情" aria-busy={loading}>
      <header className="quota-heading">
        <div className="quota-inline" aria-live="polite">{current.data.rows.map((row, index) => <span className="quota-inline-item" key={index}><span>{row.label}</span><strong>{row.value}</strong>{row.label === "余额" && (baseUrl === "https://api.beiapi.cn/v1" || (tool === "claude" && baseUrl === "https://api.beiapi.cn")) && <button className="quota-recharge" type="button" title={walletError || "打开充值页面"} onClick={() => { setWalletError(""); void toolApi(tool).openWallet().catch(() => setWalletError("无法打开充值页面，请重试")); }}>充值</button>}</span>)}</div>
        <button className="quota-refresh" type="button" aria-label="刷新API 额度" title="刷新" disabled={loading} onClick={() => setRefresh(v => v + 1)}><RefreshIcon /></button>
        {showPlans && !!current.data.groups?.length && <button className="quota-plans-toggle" type="button" aria-label={`生效套餐 ${current.data.groups.length}`} aria-expanded={plansOpen} aria-controls="api-quota-plans" onClick={() => setPlansOpen(open => !open)}><span className="quota-package-count"><span>生效套餐</span><strong>{current.data.groups.length}</strong></span><ChevronRightIcon /></button>}
      </header>
      {showPlans && !!current.data.groups?.length && <div id="api-quota-plans" className="quota-plans" hidden={!plansOpen} aria-live="polite">{current.data.groups.map(group => <div className="quota-plan" key={group.id}>
        <div className="quota-plan-heading"><span>{group.title}</span>{group.expiresAt && <small>{expiryLabel(group.expiresAt)}</small>}</div>
        <Rows rows={group.rows} amounts />
      </div>)}</div>}
    </section>
  </aside>;
}
export function QuotaCard({ inspection, tool }: { inspection: Inspection; tool: Tool }) {
  if (!inspection.hasKey || !inspection.baseUrl) return null;
  return <Source key={tool} tool={tool} channel="api" baseUrl={inspection.baseUrl} identity={`${inspection.file}\n${inspection.baseUrl}\n${inspection.apiKey}`} />;
}
