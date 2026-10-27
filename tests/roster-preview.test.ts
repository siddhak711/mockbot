import { expect, it } from "vitest";
import { rosterPreview } from "../src/agents/preview";

it("uses the first readable line without markdown marks", () => {
  expect(rosterPreview("\n## **Done.** See [PR #38](https://x)\nmore")).toBe("Done. See PR #38");
  expect(rosterPreview("```ts\ncode\n```")).toBe("code");
  expect(rosterPreview("- `npm test` passed")).toBe("npm test passed");
  expect(rosterPreview("")).toBe("");
});

it("keeps the whole line", () => {
  const line = "word ".repeat(60).trim();
  expect(rosterPreview(line)).toBe(line);
});
