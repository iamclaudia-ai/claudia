import { describe, expect, it, spyOn } from "bun:test";
import {
  coerceValue,
  exampleValueForSchema,
  formatFlagPlaceholder,
  formatMethodCommand,
  getNamespaces,
  injectSessionIdFromEnv,
  matchesSchemaType,
  parseCliParams,
  printCliHelp,
  printMethodExamples,
  printMethodHelp,
  printMethodList,
  printNamespaceHelp,
  resolveSchema,
  schemaType,
  validateParamsAgainstSchema,
  type JsonSchema,
  type MethodCatalogEntry,
} from "./index";

describe("cli parsing", () => {
  it("coerces booleans, numbers, null, and JSON", () => {
    expect(coerceValue("true")).toBe(true);
    expect(coerceValue("false")).toBe(false);
    expect(coerceValue("null")).toBeNull();
    expect(coerceValue("42")).toBe(42);
    expect(coerceValue("3.5")).toBe(3.5);
    expect(coerceValue('{"a":1}')).toEqual({ a: 1 });
    expect(coerceValue("[1,2]")).toEqual([1, 2]);
    expect(coerceValue("hello")).toBe("hello");
  });

  it("parses --flag value and --flag=value", () => {
    const params = parseCliParams([
      "--sessionId",
      "ses_123",
      "--thinking=true",
      "--effort",
      "medium",
      "--verbose",
    ]);

    expect(params).toEqual({
      sessionId: "ses_123",
      thinking: true,
      effort: "medium",
      verbose: true,
    });
  });

  it("throws on positional args", () => {
    expect(() => parseCliParams(["oops"])).toThrow(
      "Unexpected positional argument: oops. Use --name value.",
    );
  });

  it("rejects invalid empty flag token", () => {
    expect(() => parseCliParams(["--"])).toThrow("Invalid flag: --");
  });
});

describe("schema resolution and validation", () => {
  const sessionPromptSchema: JsonSchema = {
    $ref: "#/definitions/session_send_prompt",
    definitions: {
      session_send_prompt: {
        type: "object",
        required: ["sessionId", "content", "model", "thinking", "effort"],
        additionalProperties: false,
        properties: {
          sessionId: { type: "string" },
          content: { anyOf: [{ type: "string" }, { type: "array" }] },
          model: { type: "string" },
          thinking: { type: "boolean" },
          effort: { type: "string" },
          verbose: { type: "boolean" },
        },
      },
    },
  };

  it("resolves $ref definitions", () => {
    const resolved = resolveSchema(sessionPromptSchema, sessionPromptSchema);
    expect(resolved?.type).toBe("object");
    expect(resolved?.required).toContain("sessionId");
    expect(schemaType(resolved?.properties?.content, sessionPromptSchema)).toBe("string|array");
  });

  it("enforces required params and type checks", () => {
    expect(() =>
      validateParamsAgainstSchema("session.send_prompt", { sessionId: "s1" }, sessionPromptSchema),
    ).toThrow("Missing required params for session.send_prompt: content, model, thinking, effort");

    expect(() =>
      validateParamsAgainstSchema(
        "session.send_prompt",
        {
          sessionId: "s1",
          content: "hello",
          model: "claude-opus-4-6",
          thinking: "true",
          effort: "medium",
        } as unknown as Record<string, unknown>,
        sessionPromptSchema,
      ),
    ).toThrow("Invalid type for session.send_prompt.thinking: expected boolean, got string");

    expect(() =>
      validateParamsAgainstSchema(
        "session.send_prompt",
        {
          sessionId: "s1",
          content: "hello",
          model: "claude-opus-4-6",
          thinking: true,
          effort: "medium",
          extra: "x",
        },
        sessionPromptSchema,
      ),
    ).toThrow("Unknown params for session.send_prompt: extra");
  });

  it("accepts valid payload", () => {
    expect(() =>
      validateParamsAgainstSchema(
        "session.send_prompt",
        {
          sessionId: "s1",
          content: ["hello"],
          model: "claude-opus-4-6",
          thinking: true,
          effort: "medium",
        },
        sessionPromptSchema,
      ),
    ).not.toThrow();
  });

  it("builds useful example values", () => {
    expect(exampleValueForSchema({ type: "string" }, sessionPromptSchema)).toBe('"value"');
    expect(exampleValueForSchema({ type: "boolean" }, sessionPromptSchema)).toBe("true");
    expect(
      exampleValueForSchema({ type: "array", items: { type: "string" } }, sessionPromptSchema),
    ).toBe("'[\"value\"]'");
  });

  it("handles schema edge cases and additional primitive/object types", () => {
    expect(resolveSchema({ $ref: "#/missing" }, sessionPromptSchema)).toEqual({
      $ref: "#/missing",
    });
    expect(resolveSchema(undefined, sessionPromptSchema)).toBeUndefined();
    expect(resolveSchema({ $ref: "#/definitions/session_send_prompt" }, undefined)).toEqual({
      $ref: "#/definitions/session_send_prompt",
    });

    expect(schemaType({ allOf: [{ type: "string" }, { type: "number" }] })).toBe("string&number");
    expect(schemaType(undefined)).toBe("unknown");

    expect(matchesSchemaType(1, { type: "integer" }, sessionPromptSchema)).toBe(true);
    expect(matchesSchemaType(1.5, { type: "integer" }, sessionPromptSchema)).toBe(false);
    expect(matchesSchemaType(null, { type: "null" }, sessionPromptSchema)).toBe(true);
    expect(matchesSchemaType({ a: 1 }, { type: "object" }, sessionPromptSchema)).toBe(true);
    expect(
      matchesSchemaType(
        [1, 2],
        { type: "array", items: [{ type: "number" }] },
        sessionPromptSchema,
      ),
    ).toBe(true);
    expect(
      matchesSchemaType(
        [1, "x"],
        { type: "array", items: { type: "number" } },
        sessionPromptSchema,
      ),
    ).toBe(false);

    expect(exampleValueForSchema({ enum: ["alpha", "beta"] }, sessionPromptSchema)).toBe('"alpha"');
    expect(
      exampleValueForSchema({ type: "array", items: [{ type: "string" }] }, sessionPromptSchema),
    ).toBe("'[]'");
    expect(exampleValueForSchema({ type: "object" }, sessionPromptSchema)).toBe("'{}'");
    expect(exampleValueForSchema({ type: "number" }, sessionPromptSchema)).toBe("1.23");
    expect(exampleValueForSchema({ type: "integer" }, sessionPromptSchema)).toBe("1");
    expect(exampleValueForSchema({ type: "null" }, sessionPromptSchema)).toBe("null");
  });

  it("resolves $ref with $defs (zodToJsonSchema style)", () => {
    const zodSchema: JsonSchema = {
      $ref: "#/$defs/SessionInput",
      $defs: {
        SessionInput: {
          type: "object",
          required: ["sessionId"],
          properties: {
            sessionId: { type: "string" },
          },
        },
      },
    };

    const resolved = resolveSchema(zodSchema, zodSchema);
    expect(resolved?.type).toBe("object");
    expect(resolved?.required).toContain("sessionId");
    expect(resolved?.properties?.sessionId?.type).toBe("string");
  });
});

describe("sessionId auto-inject", () => {
  const requiredSchema: JsonSchema = {
    type: "object",
    required: ["sessionId", "content"],
    properties: {
      sessionId: { type: "string" },
      content: { type: "string" },
    },
  };

  const optionalSchema: JsonSchema = {
    type: "object",
    properties: {
      sessionId: { type: "string" },
    },
  };

  it("auto-injects sessionId from env when required", () => {
    const params: Record<string, unknown> = {};
    const result = injectSessionIdFromEnv(
      params,
      { method: "session.send_prompt", source: "gateway", inputSchema: requiredSchema },
      "session.send_prompt",
      { CLAUDIA_SESSION_ID: "ses_123" },
    );

    expect(result.didInject).toBe(true);
    expect(result.error).toBeUndefined();
    expect(params.sessionId).toBe("ses_123");
  });

  it("errors when required sessionId is missing and env not set", () => {
    const params: Record<string, unknown> = {};
    const result = injectSessionIdFromEnv(
      params,
      { method: "session.send_prompt", source: "gateway", inputSchema: requiredSchema },
      "session.send_prompt",
      {},
    );

    expect(result.didInject).toBe(false);
    expect(result.error).toBe(
      "session.send_prompt requires --sessionId but $CLAUDIA_SESSION_ID is not set.",
    );
    expect(params.sessionId).toBeUndefined();
  });

  it("does nothing when sessionId is optional and env not set", () => {
    const params: Record<string, unknown> = {};
    const result = injectSessionIdFromEnv(
      params,
      { method: "session.send_prompt", source: "gateway", inputSchema: optionalSchema },
      "session.send_prompt",
      {},
    );

    expect(result.didInject).toBe(false);
    expect(result.error).toBeUndefined();
    expect(params.sessionId).toBeUndefined();
  });

  it("does not override explicit sessionId", () => {
    const params: Record<string, unknown> = { sessionId: "ses_explicit" };
    const result = injectSessionIdFromEnv(
      params,
      { method: "session.send_prompt", source: "gateway", inputSchema: requiredSchema },
      "session.send_prompt",
      { CLAUDIA_SESSION_ID: "ses_env" },
    );

    expect(result.didInject).toBe(false);
    expect(result.error).toBeUndefined();
    expect(params.sessionId).toBe("ses_explicit");
  });
});

describe("help/example output", () => {
  const entry: MethodCatalogEntry = {
    method: "session.send_prompt",
    source: "gateway",
    description: "Send prompt",
    inputSchema: {
      $ref: "#/definitions/schema",
      definitions: {
        schema: {
          type: "object",
          required: ["sessionId", "content"],
          properties: {
            sessionId: { type: "string" },
            content: { type: "string" },
            verbose: { type: "boolean" },
          },
        },
      },
    },
  };

  const methods: MethodCatalogEntry[] = [
    entry,
    {
      method: "dominatrix.html",
      source: "extension",
      extensionId: "dominatrix",
      inputSchema: {
        type: "object",
        required: ["tab-id"],
        properties: {
          "tab-id": { type: "string" },
          selector: { type: "string" },
        },
      },
    },
  ];

  it("prints resolved help fields", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => undefined);
    printMethodHelp(entry);

    const lines = logSpy.mock.calls.flat().map((v) => String(v));
    expect(lines.some((l) => l.includes("claudia session send_prompt"))).toBe(true);
    expect(lines.some((l) => l.includes("--sessionId <SESSIONID> (string, required)"))).toBe(true);
    expect(lines.some((l) => l.includes("--verbose [VERBOSE] (boolean, optional)"))).toBe(true);

    logSpy.mockRestore();
  });

  it("prints examples", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => undefined);
    printMethodExamples(entry);

    const lines = logSpy.mock.calls.flat().map((v) => String(v));
    expect(
      lines.some((l) =>
        l.includes('claudia session send_prompt --sessionId "value" --content "value"'),
      ),
    ).toBe(true);

    logSpy.mockRestore();
  });

  it("prints top-level help with namespaces", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => undefined);
    printCliHelp(methods);

    const lines = logSpy.mock.calls.flat().map((v) => String(v));
    expect(lines.some((l) => l.includes("Usage:"))).toBe(true);
    expect(lines.some((l) => l.trim() === "dominatrix")).toBe(true);
    expect(lines.some((l) => l.trim() === "session")).toBe(true);

    logSpy.mockRestore();
  });

  it("prints methods as space-separated commands with params", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => undefined);
    printMethodList(methods);

    const lines = logSpy.mock.calls.flat().map((v) => String(v));
    expect(
      lines.some((l) =>
        l.includes("claudia dominatrix html --tab-id <TAB-ID> --selector [SELECTOR]"),
      ),
    ).toBe(true);
    expect(
      lines.some((l) =>
        l.includes(
          "claudia session send_prompt --sessionId <SESSIONID> --content <CONTENT> --verbose [VERBOSE]",
        ),
      ),
    ).toBe(true);

    logSpy.mockRestore();
  });

  it("prints namespace-only help", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => undefined);
    printNamespaceHelp("dominatrix", methods);

    const lines = logSpy.mock.calls.flat().map((v) => String(v));
    expect(lines.some((l) => l.includes("Namespace: dominatrix"))).toBe(true);
    expect(lines.some((l) => l.includes("claudia dominatrix html"))).toBe(true);
    expect(lines.some((l) => l.includes("claudia session send_prompt"))).toBe(false);

    logSpy.mockRestore();
  });

  it("prints fallbacks for unknown namespaces and methods", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = spyOn(console, "error").mockImplementation(() => undefined);

    printNamespaceHelp("missing", methods);
    printMethodList(methods, "missing");

    expect(errSpy.mock.calls.flat().map(String)).toContain("Unknown namespace: missing");

    expect(formatFlagPlaceholder("tab-id", true)).toBe("<TAB-ID>");
    expect(formatFlagPlaceholder("verbose", false)).toBe("[VERBOSE]");
    expect(formatMethodCommand({ method: "broken", source: "gateway" })).toBe("claudia broken");
    expect(getNamespaces(methods)).toEqual(["dominatrix", "session"]);

    printMethodHelp({ method: "gateway.health_check", source: "gateway" });
    printMethodHelp({
      method: "hooks.list",
      source: "gateway",
      inputSchema: { type: "object", properties: {} },
    });
    printMethodExamples({ method: "broken", source: "gateway", inputSchema: { type: "object" } });

    const lines = logSpy.mock.calls.flat().map((v) => String(v));
    expect(lines.some((l) => l.includes("No input schema available."))).toBe(true);
    expect(lines.some((l) => l.includes("No parameters."))).toBe(true);
    expect(lines.some((l) => l.includes("claudia broken examples"))).toBe(true);

    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});
