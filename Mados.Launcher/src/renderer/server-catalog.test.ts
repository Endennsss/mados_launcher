import { describe, expect, it } from "vitest";
import type { ServerListResult } from "../contracts/launcher";
import { acceptCatalogSnapshot, catalogError } from "./server-catalog";

const result = (revision: number, refreshing = false): ServerListResult => ({
  servers: [], failedHubs: [], partialError: false, revision, refreshing,
});

describe("progressive server catalog", () => {
  it("does not let an older RPC response overwrite a newer ping event", () => {
    const current = result(8);
    expect(acceptCatalogSnapshot(current, result(5, true))).toBe(current);
    expect(acceptCatalogSnapshot(current, result(8, true))).toBe(current);
    const next = result(9, true);
    expect(acceptCatalogSnapshot(current, next)).toBe(next);
  });

  it("accepts initial loading and completed empty catalogs", () => {
    const loading = result(1, true);
    expect(acceptCatalogSnapshot(null, loading)).toBe(loading);
    const empty = result(2);
    expect(acceptCatalogSnapshot(loading, empty)).toBe(empty);
    expect(catalogError(empty)).toBeNull();
  });

  it("distinguishes network failure from an empty search and stale cached results", () => {
    const failed = { ...result(3), failedHubs: ["https://hub.example/"] };
    expect(catalogError(failed)).toMatch(/Не удалось загрузить/);
    expect(catalogError({ ...failed, stale: true })).toMatch(/сохранённый список/);
    expect(catalogError({ ...failed, partialError: true })).toMatch(/Часть/);
  });
});
