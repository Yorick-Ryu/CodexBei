import type { ReactNode } from "react";
import { CloseIcon } from "./icons";

export function StatusNotice({ visible, kind, children, actions, formWidth, onClose }: {
  visible: boolean;
  kind: "error" | "success" | "info";
  children: ReactNode;
  actions?: ReactNode;
  formWidth?: boolean;
  onClose?: () => void;
}) {
  return <div className="status-region" data-form-width={formWidth || undefined} hidden={!visible}>
    <div id="status" className={kind} hidden={!visible} role={kind === "error" ? "alert" : "status"}>
      <span>{children}</span>
      {actions && <div className="status-actions">{actions}</div>}
      {onClose && <button type="button" className="status-close" aria-label="关闭提示"
        onClick={onClose}><CloseIcon /></button>}
    </div>
  </div>;
}
