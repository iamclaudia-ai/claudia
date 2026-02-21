import { describe, expect, it } from "bun:test";
import { matchesEventPattern } from "./events";

describe("matchesEventPattern", () => {
  it("matches everything with *", () => {
    expect(matchesEventPattern("anything", "*")).toBe(true);
    expect(matchesEventPattern("session.abc.xyz", "*")).toBe(true);
  });

  it("matches exact event names", () => {
    expect(matchesEventPattern("voice.speak", "voice.speak")).toBe(true);
    expect(matchesEventPattern("voice.speak", "voice.stop")).toBe(false);
  });

  it("trailing wildcard matches any depth under prefix", () => {
    expect(matchesEventPattern("session.content_block_delta", "session.*")).toBe(true);
    expect(matchesEventPattern("session.abc123.content_block_delta", "session.*")).toBe(true);
    expect(matchesEventPattern("voice.stream_start", "session.*")).toBe(false);
  });

  it("middle wildcard matches exactly one segment", () => {
    expect(
      matchesEventPattern("session.abc123.content_block_delta", "session.*.content_block_delta"),
    ).toBe(true);
    expect(
      matchesEventPattern("session.xyz789.content_block_delta", "session.*.content_block_delta"),
    ).toBe(true);
    expect(
      matchesEventPattern("session.content_block_delta", "session.*.content_block_delta"),
    ).toBe(false);
    expect(
      matchesEventPattern("session.a.b.content_block_delta", "session.*.content_block_delta"),
    ).toBe(false);
  });

  it("middle wildcard with message_stop", () => {
    expect(matchesEventPattern("session.abc123.message_stop", "session.*.message_stop")).toBe(true);
    expect(matchesEventPattern("voice.abc123.message_stop", "session.*.message_stop")).toBe(false);
  });

  it("does not match different prefixes", () => {
    expect(matchesEventPattern("voice.speak", "session.*")).toBe(false);
    expect(matchesEventPattern("hooks.something", "session.*")).toBe(false);
  });

  it("does not match partial segments", () => {
    expect(matchesEventPattern("session_extra.foo", "session.*")).toBe(false);
  });

  it("handles multiple wildcards", () => {
    expect(matchesEventPattern("a.b.c", "a.*.c")).toBe(true);
    expect(matchesEventPattern("a.b.c", "*.b.*")).toBe(true);
    expect(matchesEventPattern("a.b.c", "*.*.c")).toBe(true);
    expect(matchesEventPattern("a.b.d", "*.*.c")).toBe(false);
  });
});
