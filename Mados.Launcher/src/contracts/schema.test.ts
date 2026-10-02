import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rendererInvokeSchema, workerEventSchema, workerResponseSchema } from "./schema";

const ipcContract = JSON.parse(readFileSync(join(process.cwd(), "src", "contracts", "ipc.schema.json"), "utf8")) as {
  "x-methods": Record<string, string[]>;
};

describe("Mados worker contract", () => {
  it("accepts a versioned successful response", () => {
    expect(workerResponseSchema.parse({ v: 1, id: "request-1", result: { ready: true } })).toMatchObject({ id: "request-1" });
  });

  it("accepts events without exposing an unversioned shape", () => {
    expect(workerEventSchema.parse({ v: 1, event: "app.ready", data: {} }).event).toBe("app.ready");
  });

  it("keeps renderer IPC methods on the explicit allowlist", () => {
    expect(rendererInvokeSchema.safeParse({ method: "servers.list", params: {} }).success).toBe(true);
    expect(rendererInvokeSchema.safeParse({ method: "playtime.getSummary", params: { period: "all" } }).success).toBe(true);
    expect(rendererInvokeSchema.safeParse({ method: "playtime.clear", params: {} }).success).toBe(true);
    expect(rendererInvokeSchema.safeParse({ method: "fs.readFile", params: {} }).success).toBe(false);
  });

  it("checks the TypeScript allowlist against the versioned JSON contract", () => {
    const documented = new Set(Object.entries(ipcContract["x-methods"]).flatMap(([group, methods]) => methods.map((method) => `${group}.${method}`)));
    expect(rendererInvokeSchema.shape.method.options.every((method) => documented.has(method))).toBe(true);
  });
});
