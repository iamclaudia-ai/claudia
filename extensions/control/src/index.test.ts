import { describe, expect, it } from "bun:test";
import { createControlExtension } from "./index";

describe("control extension", () => {
  it("exposes standardized health_check", async () => {
    const ext = createControlExtension();
    expect(ext.methods.some((m) => m.name === "control.health_check")).toBe(true);

    await ext.start({
      on: () => () => {},
      emit: () => {},
      async call() {
        throw new Error("Not implemented in test");
      },
      connectionId: null,
      config: {},
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const res = (await ext.handleMethod("control.health_check", {})) as {
      ok: boolean;
      status: string;
      label: string;
      metrics?: Array<{ label: string; value: string | number }>;
    };

    expect(res.ok).toBe(true);
    expect(res.status).toBe("healthy");
    expect(res.label).toBe("Control");
    expect(Array.isArray(res.metrics)).toBe(true);
  });
});
