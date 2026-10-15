import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

export function TooltipLayer() {
  const id = useId();
  const [tip, setTip] = useState<{ text: string; left: number; top: number; below: boolean } | null>(null);
  useEffect(() => {
    let anchor: HTMLElement | null = null, timer: number | undefined;
    const hide = () => {
      clearTimeout(timer);
      if (anchor) {
        const described = (anchor.getAttribute("aria-describedby") ?? "").split(" ").filter(value => value && value !== id).join(" ");
        if (described) anchor.setAttribute("aria-describedby", described); else anchor.removeAttribute("aria-describedby");
      }
      anchor = null; setTip(null);
    };
    const show = (event: Event) => {
      const next = (event.target as Element).closest<HTMLElement>("[data-tooltip]");
      if (!next || next === anchor) return;
      hide(); anchor = next;
      timer = window.setTimeout(() => {
        if (!next.isConnected) return;
        const text = next.dataset.tooltip?.trim(); if (!text) return;
        const rect = next.getBoundingClientRect();
        next.setAttribute("aria-describedby", [next.getAttribute("aria-describedby"), id].filter(Boolean).join(" "));
        setTip({text, left: Math.max(150, Math.min(innerWidth - 150, rect.left + rect.width / 2)), top: rect.top > 74 ? rect.top - 8 : rect.bottom + 8, below: rect.top <= 74});
      }, event.type === "focusin" ? 120 : 450);
    };
    const leave = (event: Event) => { if (anchor && !anchor.contains((event as MouseEvent).relatedTarget as Node)) hide(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    document.addEventListener("pointerover", show); document.addEventListener("focusin", show);
    document.addEventListener("pointerout", leave); document.addEventListener("focusout", leave);
    document.addEventListener("pointerdown", hide); window.addEventListener("scroll", hide, true); window.addEventListener("resize", hide); window.addEventListener("keydown", escape);
    return () => { hide(); document.removeEventListener("pointerover", show); document.removeEventListener("focusin", show); document.removeEventListener("pointerout", leave); document.removeEventListener("focusout", leave); document.removeEventListener("pointerdown", hide); window.removeEventListener("scroll", hide, true); window.removeEventListener("resize", hide); window.removeEventListener("keydown", escape); };
  }, [id]);
  return tip ? createPortal(<div id={id} role="tooltip" className={`mados-tooltip ${tip.below ? "below" : ""}`} style={{left:tip.left,top:tip.top}}>{tip.text}</div>, document.body) : null;
}
