import { sanitizeServerAddress } from "./ui-helpers";

type Destination = "details" | "launch";
let pending: { address: string; destination: Destination; rect: DOMRect; mark: HTMLElement; time: number } | null = null;
const reduced = () => document.documentElement.classList.contains("reduce-motion") || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Capture only a real, visible server badge at the point of the user's action. */
export function queueServerHandoff(address: string, origin: HTMLElement, destination: Destination) {
  pending = null;
  if (reduced()) return;
  const mark = origin.closest("[data-server-address]")?.querySelector<HTMLElement>(".server-mark, .station-tile");
  if (!mark) return;
  const rect = mark.getBoundingClientRect();
  if (rect.width <= 0 || rect.bottom <= 42 || rect.top >= innerHeight) return;
  pending = { address: sanitizeServerAddress(address), destination, rect, mark: mark.cloneNode(true) as HTMLElement, time: performance.now() };
}

/** A short visual handoff; never delays connecting or changes scroll/layout. */
export function playServerHandoff(address: string | null, destination: Destination, target: HTMLElement): (() => void) | null {
  const source = pending;
  if (!source || source.destination !== destination) return null;
  pending = null;
  if (reduced() || source.address !== sanitizeServerAddress(address) || performance.now() - source.time > 2500 || typeof target.animate !== "function") return null;
  const end = target.getBoundingClientRect();
  if (end.width <= 0) return null;
  const ghost = source.mark;
  ghost.className = "server-mark server-handoff-flight";
  ghost.removeAttribute("id"); ghost.setAttribute("aria-hidden", "true");
  Object.assign(ghost.style, { left: `${source.rect.left}px`, top: `${source.rect.top}px`, width: `${source.rect.width}px`, height: `${source.rect.height}px` });
  document.body.append(ghost);
  const dx = end.left + end.width / 2 - source.rect.left - source.rect.width / 2;
  const dy = end.top + end.height / 2 - source.rect.top - source.rect.height / 2;
  const animation = ghost.animate([
    { transform: "translate(0, 0) scale(1)", opacity: .95 },
    { transform: `translate(${dx}px, ${dy}px) scale(${end.width / source.rect.width})`, opacity: 0 },
  ], { duration: 360, easing: "cubic-bezier(.22,.75,.22,1)", fill: "both" });
  const cleanup = () => { animation.cancel(); ghost.remove(); };
  animation.onfinish = cleanup;
  return cleanup;
}
