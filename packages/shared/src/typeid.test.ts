import { describe, expect, it } from "bun:test";
import {
  ID_PREFIXES,
  generateId,
  generateSessionId,
  generateWorkspaceId,
  parseId,
  validateIdPrefix,
} from "./typeid";

describe("typeid utilities", () => {
  it("generates ids with expected prefixes", () => {
    const ws = generateWorkspaceId();
    const ses = generateSessionId();

    expect(ws.startsWith(`${ID_PREFIXES.workspace}_`)).toBe(true);
    expect(ses.startsWith(`${ID_PREFIXES.session}_`)).toBe(true);
    expect(ws).not.toBe(ses);
  });

  it("parses ids into prefix and suffix", () => {
    const id = generateId(ID_PREFIXES.workspace);
    const parsed = parseId(id);

    expect(parsed.prefix).toBe(ID_PREFIXES.workspace);
    expect(parsed.suffix.length > 0).toBe(true);
  });

  it("throws on invalid id format and validates prefix safely", () => {
    expect(() => parseId("invalid")).toThrow("Invalid TypeID format");
    expect(validateIdPrefix("invalid", ID_PREFIXES.workspace)).toBe(false);
  });

  it("validates expected prefixes", () => {
    const ws = generateWorkspaceId();
    const ses = generateSessionId();

    expect(validateIdPrefix(ws, ID_PREFIXES.workspace)).toBe(true);
    expect(validateIdPrefix(ws, ID_PREFIXES.session)).toBe(false);
    expect(validateIdPrefix(ses, ID_PREFIXES.session)).toBe(true);
    expect(validateIdPrefix(ses, ID_PREFIXES.workspace)).toBe(false);
  });
});
