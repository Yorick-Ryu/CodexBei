import { useEffect, useRef, useState } from "react";
import { type Inspection, type Tool } from "./api";
import { FieldInfo } from "./FieldInfo";
import { CloseIcon, EyeIcon, EyeOffIcon } from "./icons";

type Values = { baseUrl: string; apiKey: string };
type Failure = { field: "baseUrl" | "apiKey"; message: string };
const values = (inspection: Inspection): Values => ({ baseUrl: inspection.baseUrl || "", apiKey: inspection.apiKey || "" });
const same = (left: Values, right: Values) => left.baseUrl === right.baseUrl && left.apiKey === right.apiKey;
function normalized(draft: Values, tool: Tool): Values | Failure {
  let url: URL;
  try { url = new URL(draft.baseUrl.trim()); } catch { return { field: "baseUrl", message: "请输入有效的 API 地址。" }; }
  if (draft.baseUrl.length > 2048 || !["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    return { field: "baseUrl", message: "请输入有效的 API 地址。" };
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/v1")) path += "/v1";
  if (tool === "claude") path = path.slice(0, -3);
  url.pathname = path;
  const apiKey = draft.apiKey.trim();
  if (!/^sk-[A-Za-z0-9_-]{12,512}$/.test(apiKey) || apiKey === "sk-your-api-key") {
    return { field: "apiKey", message: apiKey ? "请提供有效的 API 密钥" : "请输入 API 密钥。" };
  }
  return { baseUrl: url.toString().replace(/\/+$/, ""), apiKey };
}

export function LiveConnectionCard({ inspection, tool, disabled, compact = false, onCommit, onSaved, onSavingChange }: {
  inspection: Inspection; tool: Tool; disabled: boolean;
  compact?: boolean;
  onCommit: (draft: Values, baseline: Inspection) => Promise<Inspection>;
  onSaved: (inspection: Inspection) => void; onSavingChange: (saving: boolean) => void;
}) {
  const [draft, setDraft] = useState(() => values(inspection));
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<"idle" | "waiting" | "saving" | "saved" | "error">("idle");
  const [failure, setFailure] = useState<Failure | null>(null);
  const saved = useRef(inspection);
  const current = useRef(draft);
  const generation = useRef(0);
  const mounted = useRef(true);
  const composing = useRef(false);
  const inFlight = useRef(false);
  const callbacks = useRef({ onCommit, onSaved, onSavingChange });
  callbacks.current = { onCommit, onSaved, onSavingChange };
  const saveRef = useRef<() => Promise<void>>(async () => {});
  const dirty = !same(draft, values(saved.current));
  const edit = (next: Values) => {
    current.current = next;
    generation.current++;
    setDraft(next);
    setFailure(null);
    setState(same(next, values(saved.current)) ? "idle" : "waiting");
  };
  saveRef.current = async () => {
    if (composing.current || same(current.current, values(saved.current))) return;
    if (inFlight.current) return;
    const parsed = normalized(current.current, tool);
    if ("field" in parsed) {
      if (mounted.current) { setFailure(parsed); setState("error"); }
      return;
    }
    if (same(parsed, values(saved.current))) {
      current.current = parsed;
      if (mounted.current) { setDraft(parsed); setState("idle"); }
      return;
    }
    const version = generation.current;
    inFlight.current = true;
    if (mounted.current) setState("saving");
    callbacks.current.onSavingChange(true);
    try {
      const updated = await callbacks.current.onCommit(parsed, saved.current);
      saved.current = updated;
      if (generation.current === version) current.current = values(updated);
      if (mounted.current) {
        callbacks.current.onSaved(updated);
        if (generation.current === version) {
          current.current = values(updated);
          setDraft(current.current);
          setVisible(false);
          setFailure(null);
          setState("saved");
        }
      }
    } catch (error) {
      if (mounted.current) {
        setFailure({ field: "apiKey", message: typeof error === "string" ? error : "保存失败，请重试。" });
        setState("error");
      }
    } finally {
      inFlight.current = false;
      callbacks.current.onSavingChange(false);
    }
  };
  useEffect(() => {
    if (saved.current.revision === inspection.revision && saved.current.file === inspection.file) return;
    if (inFlight.current) return;
    const pending = !same(current.current, values(saved.current));
    if (pending && (saved.current.file !== inspection.file || !same(values(inspection), values(saved.current)))) return;
    saved.current = inspection;
    if (pending) return;
    current.current = values(inspection);
    setDraft(current.current);
    setVisible(false);
    setFailure(null);
    setState("idle");
  }, [inspection]);
  useEffect(() => () => { mounted.current = false; }, []);
  const inputEvents = {
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void saveRef.current(); }
    },
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: () => { composing.current = false; setDraft({ ...current.current }); },
  };
  const feedback = <p id="connection-save-status" className={`connection-save-status${failure ? " error" : ""}`} role="status" aria-live="polite">
    {failure?.message || (state === "saving" ? "保存中…" : state === "saved" ? "已保存" : "")}
  </p>;
  return <section className={`live-connection${compact ? " live-connection--compact" : ""}`} aria-labelledby={compact ? "live-key-label" : "live-connection-title"}>
    {!compact && <div className="live-connection-heading">
      <h2 id="live-connection-title" className="home-section-title">API 连接</h2>
      {feedback}
    </div>}
    <div className="credentials-card" aria-busy={state === "saving"}>
      <div className="credential-field">
        <div className="live-key-caption"><span className="setting-title"><label id="live-key-label" htmlFor="live-key">API 密钥</label><FieldInfo label="API 密钥" description="点击保存或按回车保存" /></span>{compact && feedback}</div>
        <div className="live-key-editor">
        <div className="key-control">
          <input id="live-key" aria-label="API 密钥" type={visible ? "text" : "password"} value={draft.apiKey} disabled={disabled} autoComplete="off" spellCheck={false}
            aria-invalid={failure?.field === "apiKey"} aria-describedby="connection-save-status" {...inputEvents} onChange={event => edit({ ...current.current, apiKey: event.target.value })} />
          <div className="key-actions">
            <button type="button" className="key-action" aria-label={visible ? "隐藏密钥" : "显示密钥"} aria-pressed={visible} disabled={disabled || !draft.apiKey} onClick={() => setVisible(value => !value)}>{visible ? <EyeOffIcon /> : <EyeIcon />}</button>
            <button type="button" className="key-action" aria-label="清空输入的密钥" disabled={disabled || !draft.apiKey} onClick={() => { edit({ ...current.current, apiKey: "" }); setVisible(false); }}><CloseIcon /></button>
          </div>
        </div>
        <button id="save-connection" type="button" className="secondary live-connection-save" disabled={disabled || inFlight.current || !dirty} aria-busy={inFlight.current} onClick={() => void saveRef.current()}>保存</button>
        </div>
      </div>
    </div>
  </section>;
}
