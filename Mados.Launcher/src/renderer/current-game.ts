import { useCallback, useEffect, useRef, useState } from "react";
import type { PresenceSnapshot, ServerDetails } from "../contracts/launcher";
import type { LaunchActivity } from "./launch-status";
import { sanitizeServerAddress } from "./ui-helpers";

export function useCurrentGame(activity: LaunchActivity) {
  const address = activity.status === "ClientRunning" && !activity.contentBundle ? sanitizeServerAddress(activity.address ?? "") : null;
  const key = address ? `${address}:${activity.startedAt}` : "";
  const [state, setState] = useState({ key, details: null as ServerDetails | null, loading: false, error: null as string | null });
  const sequence = useRef(0), activeKey = useRef(key);
  activeKey.current = key;
  const refresh = useCallback(async () => {
    if (!address) return;
    const request = ++sequence.current;
    setState(old => ({ key, details: old.key === key ? old.details : null, loading: true, error: null }));
    try {
      const details = await window.mados.invoke<ServerDetails>("servers.info", { address });
      if (request === sequence.current && activeKey.current === key) setState({ key, details, loading: false, error: null });
    } catch (caught) {
      if (request === sequence.current && activeKey.current === key) setState(old => ({ ...old, loading: false, error: caught instanceof Error ? caught.message : "Не удалось обновить сервер" }));
    }
  }, [key, address]);
  useEffect(() => {
    setState({ key, details: null, loading: !!address, error: null });
    if (!address) return;
    void refresh();
    const unsubscribe = window.mados.onEvent(event => {
      if (event.event !== "presence.updated" || activeKey.current !== key) return;
      const data = event.data as PresenceSnapshot;
      if (data?.state !== "playing" || !data.enabled || sanitizeServerAddress(data.address ?? "") !== address) return;
      // Do not accept a previous game's delayed snapshot after reconnecting.
      const started = Date.parse(data.startedAt ?? "");
      if (!Number.isFinite(started) || activity.startedAt != null && started < activity.startedAt - 5000) return;
      ++sequence.current;
      setState({ key, loading: false, error: null, details: {name:data.serverName, map:data.map, mode:data.mode, playerCount:data.playerCount, softMaxPlayerCount:data.softMaxPlayerCount, pingMs:data.pingMs} });
    });
    return () => { sequence.current++; unsubscribe(); };
  }, [key, address, activity.startedAt, refresh]);
  return { ...(state.key === key ? state : {key, details:null, loading:!!address, error:null}), refresh };
}
