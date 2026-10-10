import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { InfoIcon } from "./icons";

export function FieldInfo({ label, description }: { label: string; description: string }) {
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
