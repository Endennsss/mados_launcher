import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, X } from "lucide-react";

type Confirmation = { title?: string; message: string; confirmLabel?: string; destructive?: boolean };
type Confirm = (request: Confirmation | string) => Promise<boolean>;
type ConfirmationService = { confirm: (request: Confirmation | string, owner: string) => Promise<boolean>; cancel: (owner: string) => void };
const Context = createContext<ConfirmationService | null>(null);

export function useConfirm(scopeKey?: string | null): Confirm {
  const service = useContext(Context);
  const owner = useId();
  if (!service) throw new Error("Confirmation controls require ConfirmProvider");
  const { confirm, cancel } = service;
  // A decision belongs to the screen/account that requested it.
  useLayoutEffect(() => () => cancel(owner), [cancel, owner, scopeKey]);
  return useCallback(request => confirm(request, owner), [confirm, owner]);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Confirmation | null>(null);
  const resolver = useRef<{ owner: string; resolve: (accepted: boolean) => void } | null>(null);
  const confirm = useCallback<ConfirmationService["confirm"]>((options, owner) => new Promise(resolve => {
    resolver.current?.resolve(false);
    resolver.current = { owner, resolve };
    setRequest(typeof options === "string" ? { message: options } : options);
  }), []);
  const finish = useCallback((accepted: boolean) => {
    const pending = resolver.current;
    resolver.current = null; setRequest(null); pending?.resolve(accepted);
  }, []);
  const cancel = useCallback((owner: string) => { if (resolver.current?.owner === owner) finish(false); }, [finish]);
  const service = useMemo(() => ({ confirm, cancel }), [confirm, cancel]);
  useEffect(() => () => { resolver.current?.resolve(false); resolver.current = null; }, []);
  return <Context.Provider value={service}>{children}{request && <ConfirmationDialog request={request} finish={finish} />}</Context.Provider>;
}

function ConfirmationDialog({ request, finish }: { request: Confirmation; finish: (value: boolean) => void }) {
  const dialog = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId(), descriptionId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const appRoot = document.getElementById("root");
    const wasInert = appRoot?.inert ?? false;
    if (appRoot) appRoot.inert = true;
    cancel.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); finish(false); }
      if (event.key !== "Tab") return;
      const buttons = [...dialog.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", keydown, true);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      if (appRoot) appRoot.inert = wasInert;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [finish]);
  return createPortal(<div className="mados-dialog-overlay" onMouseDown={event => { if (event.target === event.currentTarget) finish(false); }}>
    <section ref={dialog} className="mados-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
      <div className="mados-dialog-symbol"><AlertTriangle size={24} /></div>
      <h2 id={titleId}>{request.title ?? "Подтвердите действие"}</h2>
      <p id={descriptionId}>{request.message}</p>
      <div className="mados-dialog-actions"><button ref={cancel} className="secondary-button" onClick={() => finish(false)}><X size={16} />Отмена</button><button className={`primary-button ${request.destructive ? "destructive-button" : ""}`} onClick={() => finish(true)}><Check size={16} />{request.confirmLabel ?? "Продолжить"}</button></div>
    </section>
  </div>, document.body);
}
