import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { CloseIcon } from "./icons";

export function Modal({ open, onClose, title, children, id, titleId, descriptionId,
  closeLabel, closeDisabled = false, size = "default", tall = false, dialogRef,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  id?: string;
  titleId?: string;
  descriptionId?: string;
  closeLabel?: string;
  closeDisabled?: boolean;
  size?: "default" | "wide";
  tall?: boolean;
  dialogRef?: RefObject<HTMLDialogElement>;
}) {
  const internal = useRef<HTMLDialogElement>(null);
  const ref = dialogRef || internal;
  const generatedId = useId();
  const headingId = titleId || generatedId;
  useEffect(() => {
    const element = ref.current;
    if (open && element && !element.open) {
      element.showModal();
      element.focus({ preventScroll: true });
    } else if (!open && element?.open) element.close();
  }, [open, ref]);
  return <dialog id={id} ref={ref} tabIndex={-1}
    className={`modal modal--${size}${tall ? " modal--tall" : ""}`}
    aria-labelledby={headingId} aria-describedby={descriptionId}
    onCancel={event => {
      event.preventDefault();
      if (!closeDisabled) onClose();
    }} onClose={onClose}>
    <div className="modal-header">
      <h2 id={headingId}>{title}</h2>
      <button type="button" className="modal-close" disabled={closeDisabled}
        aria-label={closeLabel || `关闭${title}`} onClick={onClose}>
        <CloseIcon />
      </button>
    </div>
    <div className="modal-body">{children}</div>
  </dialog>;
}
