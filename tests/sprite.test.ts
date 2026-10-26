import { expect, it } from "vitest";
import {
  DONE_HOLD_MS,
  lastAssistantId,
  liveAssistantId,
  shouldStartDoneHold,
  spritePixels,
  spriteSrc,
  spriteStateForRun,
  type SpriteRun,
} from "../src/sprite";

function run(patch: Partial<SpriteRun> = {}): SpriteRun {
  return {
    streaming: false,
    livePhase: null,
    turnError: null,
    activities: [],
    liveMessageId: null,
    lastMessageId: null,
    finishedAgoMs: null,
    ...patch,
  };
}

it("stays idle when nothing is running", () => {
  expect(spriteStateForRun(run())).toBe("idle");
  expect(
    spriteStateForRun(
      run({
        lastMessageId: "a1",
        activities: [{ messageId: "a1", state: "done" }],
        finishedAgoMs: DONE_HOLD_MS,
      }),
    ),
  ).toBe("idle");
});

it("maps reasoning and an in-progress reply to thinking", () => {
  for (const livePhase of ["start", "reasoning", "text", "end", null] as const) {
    expect(spriteStateForRun(run({ streaming: true, livePhase, liveMessageId: "a1" }))).toBe(
      "thinking",
    );
  }
});

it("maps a running tool to working and keeps approval off that state", () => {
  expect(
    spriteStateForRun(
      run({
        streaming: true,
        livePhase: "tool",
        liveMessageId: "a1",
        activities: [{ messageId: "a1", state: "running" }],
      }),
    ),
  ).toBe("working");

  expect(
    spriteStateForRun(
      run({
        streaming: true,
        livePhase: "tool",
        liveMessageId: "a1",
        activities: [{ messageId: "a1", state: "approval" }],
      }),
    ),
  ).toBe("thinking");

  expect(
    spriteStateForRun(
      run({
        streaming: true,
        livePhase: "reasoning",
        liveMessageId: "a1",
        activities: [{ messageId: "older", state: "running" }],
      }),
    ),
  ).toBe("thinking");
});

it("holds done for two seconds after a successful turn, then idle", () => {
  expect(spriteStateForRun(run({ finishedAgoMs: 0 }))).toBe("done");
  expect(spriteStateForRun(run({ finishedAgoMs: DONE_HOLD_MS - 1 }))).toBe("done");
  expect(spriteStateForRun(run({ finishedAgoMs: DONE_HOLD_MS }))).toBe("idle");
  expect(spriteStateForRun(run({ finishedAgoMs: -1 }))).toBe("idle");
  expect(
    shouldStartDoneHold({
      wasStreaming: true,
      streaming: false,
      turnError: null,
      toolFailed: false,
    }),
  ).toBe(true);
  expect(
    shouldStartDoneHold({
      wasStreaming: true,
      streaming: false,
      turnError: "The model request failed",
      toolFailed: false,
    }),
  ).toBe(false);
  expect(
    shouldStartDoneHold({
      wasStreaming: false,
      streaming: false,
      turnError: null,
      toolFailed: false,
    }),
  ).toBe(false);
});

it("maps a failed turn or a failed tool on that turn to error", () => {
  expect(spriteStateForRun(run({ turnError: "The model request failed" }))).toBe("error");
  expect(
    spriteStateForRun(
      run({
        streaming: true,
        livePhase: "tool",
        liveMessageId: "a1",
        activities: [{ messageId: "a1", state: "error" }],
      }),
    ),
  ).toBe("error");
  expect(
    spriteStateForRun(
      run({
        lastMessageId: "a1",
        activities: [{ messageId: "a1", state: "error" }],
        finishedAgoMs: 0,
      }),
    ),
  ).toBe("error");
  expect(
    spriteStateForRun(
      run({
        streaming: true,
        liveMessageId: "a2",
        livePhase: "reasoning",
        activities: [{ messageId: "a1", state: "error" }],
      }),
    ),
  ).toBe("thinking");
  expect(
    spriteStateForRun(
      run({
        lastMessageId: "a1",
        activities: [{ messageId: "a1", state: "denied" }],
      }),
    ),
  ).toBe("idle");
});

it("ignores the previous assistant row until the live turn has its own", () => {
  const before = new Set(["a1"]);
  const messages = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant" },
  ];
  expect(liveAssistantId(true, messages, before)).toBeNull();
  expect(liveAssistantId(false, [...messages, { id: "a2", role: "assistant" }], before)).toBeNull();
  expect(liveAssistantId(true, [...messages, { id: "a2", role: "assistant" }], before)).toBe("a2");
  expect(lastAssistantId(messages)).toBe("a1");
  expect(lastAssistantId([{ id: "u1", role: "user" }])).toBeNull();
});

it("serves a theme-specific sprite and the static file when motion is reduced", () => {
  expect(spriteSrc("idle", "light", false)).toBe("/sprites/mochi/svg/mochi-idle-light.svg");
  expect(spriteSrc("working", "dark", false)).toBe("/sprites/mochi/svg/mochi-working-dark.svg");
  expect(spriteSrc("error", "light", true)).toBe("/sprites/mochi/svg/mochi-error-light.static.svg");
  expect(spriteSrc("done", "dark", true)).toBe("/sprites/mochi/svg/mochi-done-dark.static.svg");
  expect(spriteSrc("thinking", "light", false)).toBe("/sprites/mochi/svg/mochi-thinking-light.svg");
});

it("never draws Mochi below 24px", () => {
  expect(spritePixels(16)).toBe(24);
  expect(spritePixels(24)).toBe(24);
  expect(spritePixels(32.4)).toBe(32);
  expect(spritePixels(Number.NaN)).toBe(24);
});
