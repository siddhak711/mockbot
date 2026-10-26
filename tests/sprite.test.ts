import { expect, it } from "vitest";
import { readdirSync } from "node:fs";
import {
  DONE_HOLD_MS,
  SPRITE_COLORS,
  SPRITE_STATES,
  alertAfterConversationSwitch,
  alertMessageForView,
  doneHoldStillApplies,
  lastAssistantId,
  liveAssistantId,
  shouldStartDoneHold,
  spriteAnimSrc,
  spriteColorForAgent,
  spritePixels,
  spriteSrc,
  spriteSrcSet,
  spriteStateForRun,
  spriteStaticSrc,
  spriteTurnErrorForView,
  type SpriteRun,
} from "../src/sprite";
import { LEAD_AGENT_ID } from "../src/agents/ids";

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

it("serves the crown animation and the static png when motion is reduced", () => {
  expect(spriteSrc("idle")).toBe("/sprites/crown3d/anim/violet-idle.webp");
  expect(spriteAnimSrc("blue", "working")).toBe("/sprites/crown3d/anim/blue-working.webp");
  expect(spriteSrc("working", "teal", false)).toBe("/sprites/crown3d/anim/teal-working.webp");
  expect(spriteSrc("error", "pink", true)).toBe("/sprites/crown3d/static/pink-error@1x.png");
  expect(spriteStaticSrc("green", "done", 2)).toBe("/sprites/crown3d/static/green-done@2x.png");
  expect(spriteStaticSrc("violet", "thinking", 3)).toBe(
    "/sprites/crown3d/static/violet-thinking@3x.png",
  );
  expect(spriteSrcSet("done", "blue", false)).toBeUndefined();
  expect(spriteSrcSet("done", "blue", true)).toBe(
    "/sprites/crown3d/static/blue-done@1x.png 1x, /sprites/crown3d/static/blue-done@2x.png 2x, /sprites/crown3d/static/blue-done@3x.png 3x",
  );
});

it("keeps violet for mockbot and a stable crew color for other agents", () => {
  expect(spriteColorForAgent(null)).toBe("violet");
  expect(spriteColorForAgent({ id: LEAD_AGENT_ID })).toBe("violet");
  expect(spriteColorForAgent({ id: "agent_other", isLead: true })).toBe("violet");
  const color = spriteColorForAgent({ id: "agent_research", isLead: false });
  expect(color).not.toBe("violet");
  expect(spriteColorForAgent({ id: "agent_research", isLead: false })).toBe(color);
});

it("ships one animation and three static scales for every color and state", () => {
  const anim = readdirSync("public/sprites/crown3d/anim");
  const still = readdirSync("public/sprites/crown3d/static");
  for (const color of SPRITE_COLORS) {
    for (const state of SPRITE_STATES) {
      expect(anim).toContain(`${color}-${state}.webp`);
      expect(still).toContain(`${color}-${state}@1x.png`);
      expect(still).toContain(`${color}-${state}@2x.png`);
      expect(still).toContain(`${color}-${state}@3x.png`);
    }
  }
  expect(anim).toHaveLength(25);
  expect(still).toHaveLength(75);
});

it("ignores rename, delete, and expired-approval alerts when choosing the bot's error face", () => {
  const workspace = (message: string) =>
    spriteTurnErrorForView({ message, kind: "workspace", ownerId: "c1" }, "c1");
  expect(workspace("Could not rename conversation")).toBeNull();
  expect(workspace("Could not delete conversation")).toBeNull();
  expect(workspace("That approval expired. Send the request again.")).toBeNull();

  const failed = { message: "The model request failed", kind: "turn" as const, ownerId: "c1" };
  expect(spriteTurnErrorForView(failed, "c1")).toBe("The model request failed");
  expect(spriteTurnErrorForView(failed, "c2")).toBeNull();
  expect(
    spriteTurnErrorForView({ message: "Request failed", kind: "turn", ownerId: null }, null),
  ).toBe("Request failed");
  expect(
    spriteTurnErrorForView({ message: "Request failed", kind: "turn", ownerId: null }, "c1"),
  ).toBeNull();
  expect(spriteTurnErrorForView(null, null)).toBeNull();
});

it("a turn alert owned by chat A is hidden while chat B is open, and it reappears after switching back to A", () => {
  const ownedByA = {
    message: "The model request failed",
    kind: "turn" as const,
    ownerId: "A",
  };
  const whileAway = alertAfterConversationSwitch(ownedByA);
  expect(whileAway).toBe(ownedByA);
  expect(spriteTurnErrorForView(whileAway, "B")).toBeNull();
  expect(alertMessageForView(whileAway, "B")).toBeNull();
  expect(spriteTurnErrorForView(whileAway, "A")).toBe("The model request failed");
  expect(alertMessageForView(whileAway, "A")).toBe("The model request failed");
  expect(
    alertAfterConversationSwitch({
      message: "Could not rename conversation",
      kind: "workspace",
      ownerId: "A",
    }),
  ).toBeNull();
});

it("drops the done hold when the conversation or the turn changes", () => {
  const hold = { conversationId: "c1", turnId: "a1" };
  expect(doneHoldStillApplies(hold, hold)).toBe(true);
  expect(doneHoldStillApplies(hold, { conversationId: "c2", turnId: "a1" })).toBe(false);
  expect(doneHoldStillApplies(hold, { conversationId: "c1", turnId: "a2" })).toBe(false);
  expect(doneHoldStillApplies(hold, { conversationId: null, turnId: null })).toBe(false);
  expect(doneHoldStillApplies(null, hold)).toBe(false);
});

it("never draws the bot below 24px", () => {
  expect(spritePixels(16)).toBe(24);
  expect(spritePixels(24)).toBe(24);
  expect(spritePixels(32.4)).toBe(32);
  expect(spritePixels(Number.NaN)).toBe(24);
});
