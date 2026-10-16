import type { ReactNode } from "react";
import { AlertCircle, ArrowRight, LoaderCircle, RefreshCw, X } from "lucide-react";

export function ViewState({ kind = "empty", icon, title, description, action, onAction, details, compact = false, onDismiss, actionId }: {
  kind?: "empty" | "error" | "loading" | "offline"; icon?: ReactNode; title: string; description?: string;
  action?: string; onAction?: () => void; details?: string; compact?: boolean; onDismiss?: () => void; actionId?:string;
}) {
  return <div className={`view-state state-${kind} ${compact ? "compact-state" : ""}`} role={kind === "error" ? "alert" : kind === "loading" || kind === "offline" ? "status" : undefined}>
    <span className="view-state-symbol">{icon ?? (kind === "loading" ? <LoaderCircle size={22} className="spin"/> : <AlertCircle size={22}/>)}</span>
    <div className="view-state-copy"><strong>{title}</strong>{description && <p>{description}</p>}{details && <details><summary>Подробности</summary><p>{details}</p></details>}</div>
    {action && onAction && <button type="button" className="secondary-button compact-button" data-action={actionId} onClick={onAction}>{kind === "error" ? <RefreshCw size={15}/> : null}{action}{kind === "empty" && <ArrowRight size={14}/>}</button>}
    {onDismiss && <button className="icon-button view-state-dismiss" aria-label="Закрыть сообщение" onClick={onDismiss}><X size={15}/></button>}
  </div>;
}
export function LoadingCards({ count = 3, label = "Загружаем данные…", className = "", itemClassName="" }: {count?:number;label?:string;className?:string;itemClassName?:string}) {
  return <div className={`state-skeleton-grid ${className}`} role="status" aria-label={label}>{Array.from({length:count},(_,i)=><div className={`state-skeleton ${itemClassName}`} key={i} aria-hidden="true"><i/><span/><span/><span/></div>)}</div>;
}
