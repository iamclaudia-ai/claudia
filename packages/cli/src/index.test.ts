import { describe, expect, it, spyOn } from "bun:test";
import {
  coerceValue,
  exampleValueForSchema,
  parseCliParams,
  printMethodExamples,
  printMethodHelp,
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
      "--speakResponse",
    ]);

    expect(params).toEqual({
      sessionId: "ses_123",
      thinking: true,
      effort: "medium",
      speakResponse: true,
    });
  });

  it("throws on positional args", () => {
    expect(() => parseCliParams(["oops"]))
      .toThrow("Unexpected positional argument: oops. Use --name value.");
  });
});

describe("schema resolution and validation", () => {
  const sessionPromptSchema: JsonSchema = {
    $ref: "#/definitions/session_prompt",
    definitions: {
      session_prompt: {
        type: "object",
        required: ["sessionId", "content", "model", "thinking", "effort"],
        additionalProperties: false,
        properties: {
          sessionId: { type: "string" },
          content: { anyOf: [{ type: "string" }, { type: "array" }] },
          model: { type: "string" },
          thinking: { type: "boolean" },
          effort: { type: "string" },
          speakResponse: { type: "boolean" },
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
      validateParamsAgainstSchema("session.prompt", { sessionId: "s1" }, sessionPromptSchema),
    ).toThrow("Missing required params for session.prompt: content, model, thinking, effort");

    expect(() =>
      validateParamsAgainstSchema(
        "session.prompt",
        {
          sessionId: "s1",
          content: "hello",
          model: "claude-opus-4-6",
          thinking: "true",
          effort: "medium",
        } as unknown as Record<string, unknown>,
        sessionPromptSchema,
      ),
    ).toThrow("Invalid type for session.prompt.thinking: expected boolean, got string");

    expect(() =>
      validateParamsAgainstSchema(
        "session.prompt",
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
    ).toThrow("Unknown params for session.prompt: extra");
  });

  it("accepts valid payload", () => {
    expect(() =>
      validateParamsAgainstSchema(
        "session.prompt",
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
    expect(exampleValueForSchema({ type: "array", items: { type: "string" } }, sessionPromptSchema)).toBe("'[\"value\"]'");
  });
});

describe("help/example output", () => {
  const entry: MethodCatalogEntry = {
    method: "session.prompt",
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
            speakResponse: { type: "boolean" },
          },
        },
      },
    },
  };

  it("prints resolved help fields", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => undefined);
    printMethodHelp(entry);

    const lines = logSpy.mock.calls.flat().map((v) => String(v));
    expect(lines.some((l) => l.includes("--sessionId <string> (required)"))).toBe(true);
    expect(lines.some((l) => l.includes("--speakResponse <boolean> (optional)"))).toBe(true);

    logSpy.mockRestore();
  });

  it("prints examples", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => undefined);
    printMethodExamples(entry);

    const lines = logSpy.mock.calls.flat().map((v) => String(v));
    expect(lines.some((l) => l.includes("claudia session prompt --sessionId \"value\" --content \"value\""))).toBe(true);

    logSpy.mockRestore();
  });
});
