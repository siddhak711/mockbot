import { expect, it } from "vitest";
import { canSendMessage } from "../components/composer";

it("blocks send while an approval is pending", () => {
  expect(canSendMessage(false, true)).toBe(false);
  expect(canSendMessage(true, false)).toBe(false);
  expect(canSendMessage(true, true)).toBe(false);
  expect(canSendMessage(false, false)).toBe(true);
});
