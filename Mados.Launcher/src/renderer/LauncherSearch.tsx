import { useEffect, useMemo, useRef, useState } from "react";
import type { LaunchProfile, LauncherState, ServerListResult } from "../contracts/launcher";
import { buildCommandPaletteCommands, CommandPalette, type CommandAction } from "./CommandPalette";
import { acceptCatalogSnapshot, catalogError } from "./server-catalog";

export function LauncherSearch({ state, hasLastServer, onClose, onExecute }: {
  state: LauncherState; hasLastServer: boolean; onClose: () => void; onExecute: (action: CommandAction) => void;
}) {
  const accountId = state.activeAccount?.id;
  const [sources, setSources] = useState<{accountId?: string; catalog: ServerListResult | null; profiles: LaunchProfile[]; catalogFailure: string | null; profileFailure: string | null; loading: boolean}>({ catalog: null, profiles: [], catalogFailure: null, profileFailure: null, loading: true });
  const [retry, setRetry] = useState(0);
  const revision = useRef(0);
  useEffect(() => {
    let live = true, profileRequest = 0;
    const request = ++revision.current;
    setSources(current => ({ accountId, catalog: current.accountId === accountId ? current.catalog : null, profiles: [], catalogFailure: null, profileFailure: null, loading: true }));
    const loadProfiles = async () => {
      const sequence = ++profileRequest;
      try {
        const profiles = await window.mados.launchProfiles.list();
        if (live && request === revision.current && sequence === profileRequest) setSources(current => ({...current, profiles, profileFailure:null}));
      } catch {
        if (live && request === revision.current && sequence === profileRequest) setSources(current => ({...current, profileFailure: "Не удалось загрузить профили. Попробуйте ещё раз."}));
      }
    };
    const apply = (catalog: ServerListResult) => setSources(current => {
      const accepted = acceptCatalogSnapshot(current.catalog, catalog);
      return accepted===current.catalog ? current : {...current, catalog: accepted, catalogFailure:null};
    });
    const unsubscribe = window.mados.onEvent(event => {
      if (!live) return;
      if (event.event === "servers.updated" && Array.isArray((event.data as ServerListResult)?.servers)) apply(event.data as ServerListResult);
      if (event.event === "launchProfiles.updated") void loadProfiles();
    });
    const catalog = window.mados.invoke<ServerListResult>(retry ? "servers.refresh" : "servers.list").then(result => {
      if (live && request === revision.current) apply(result);
    }).catch(() => {
      if (live && request === revision.current) setSources(current => ({...current, catalogFailure: "Каталог недоступен. Можно искать в избранном и настройках."}));
    });
    void Promise.all([catalog, loadProfiles()]).finally(() => {
      if (live && request === revision.current) setSources(current => ({...current, loading: false}));
    });
    return () => { live = false; unsubscribe(); };
  }, [accountId, retry]);
  const scoped = sources.accountId === accountId;
  const commands = useMemo(() => buildCommandPaletteCommands({ hasLastServer, favorites: state.favorites, servers: scoped ? sources.catalog?.servers : [], profiles: scoped ? sources.profiles : [] }), [hasLastServer, state.favorites, scoped, sources.catalog, sources.profiles]);
  const error = scoped ? [sources.catalogFailure || (sources.catalog && catalogError(sources.catalog)), sources.profileFailure].filter(Boolean).join(" ") : null;
  return <CommandPalette commands={commands} onClose={onClose} onExecute={onExecute} loading={!scoped || sources.loading || sources.catalog?.refreshing} error={error} onRetry={() => setRetry(value => value + 1)}/>;
}
