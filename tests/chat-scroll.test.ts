import { expect, it } from "vitest";
import { distanceFromBottom, isPinnedToBottom, SCROLL_PIN_PX } from "../src/chat-scroll";

it("treats the bottom of the transcript as pinned", () => {
  expect(isPinnedToBottom({ scrollTop: 400, scrollHeight: 800, clientHeight: 400 })).toBe(true);
  expect(distanceFromBottom({ scrollTop: 400, scrollHeight: 800, clientHeight: 400 })).toBe(0);
});

it("stays pinned within the follow threshold and lets go above it", () => {
  expect(isPinnedToBottom({ scrollTop: 352, scrollHeight: 800, clientHeight: 400 })).toBe(true);
  expect(
    isPinnedToBottom({
      scrollTop: 400 - SCROLL_PIN_PX - 1,
      scrollHeight: 800,
      clientHeight: 400,
    }),
  ).toBe(false);
});
