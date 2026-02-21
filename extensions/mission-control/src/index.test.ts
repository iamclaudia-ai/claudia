import { describe, expect, it } from "bun:test";
import { createMissionControlExtension } from "./index";

describe("mission-control extension", () => {
  it("exposes standardized health-check", async () => {
    const ext = createMissionControlExtension();
    expect(ext.methods.some((m) => m.name === "mission-control.health-check")).toBe(true);

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

    const res = (await ext.handleMethod("mission-control.health-check", {})) as {
      ok: boolean;
      status: string;
      label: string;
      metrics?: Array<{ label: string; value: string | number }>;
    };

    expect(res.ok).toBe(true);
    expect(res.status).toBe("healthy");
    expect(res.label).toBe("Mission Control");
    expect(Array.isArray(res.metrics)).toBe(true);
  });
});
