import type { ServerListResult } from "../contracts/launcher";

/** Events can reach the renderer before the reply to the request that started them. */
export function acceptCatalogSnapshot(current: ServerListResult | null, incoming: ServerListResult): ServerListResult {
  if (current?.revision != null && incoming.revision != null && incoming.revision <= current.revision) return current;
  return incoming;
}

export function catalogError(result: ServerListResult): string | null {
  if (result.stale) return "Не удалось обновить каталог. Показан сохранённый список; попробуйте обновить ещё раз.";
  if (result.partialError) return "Часть hub-серверов недоступна. Показаны доступные результаты.";
  if (result.failedHubs.length > 0 && !result.refreshing && result.servers.length === 0)
    return "Не удалось загрузить список серверов. Проверьте соединение и повторите обновление.";
  return null;
}
