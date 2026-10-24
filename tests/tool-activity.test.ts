import { expect, it } from "vitest";
import { toolActivity } from "../src/chat";

it("labels each memory tool failure instead of calling every error a blocked write", () => {
  const forgotten = toolActivity(
    { id: "1", name: "memory_delete", output: "No memory with that key is stored.", isError: true },
    "done",
  );
  expect(forgotten.title).toBe("Could not forget that memory");
  expect(forgotten.title).not.toMatch(/write blocked/i);

  const searched = toolActivity(
    { id: "2", name: "memory_search", output: "sk-test-1234567890abcdefghij", isError: false },
    "done",
  );
  expect(searched.title).toBe("Searching memory");
  expect(searched.detail).not.toContain("sk-test");
  expect(searched.detail).not.toMatch(/not stored/i);

  const blocked = toolActivity(
    {
      id: "3",
      name: "memory_write",
      output: "Blocked. The text looks like a secret (openai_key) and was not stored.",
      isError: true,
    },
    "done",
  );
  expect(blocked.title).toBe("Memory write blocked");
  expect(blocked.detail).toBe("Blocked. A secret was not stored.");
  expect(blocked.detail).not.toContain("openai_key");

  const updated = toolActivity(
    { id: "4", name: "memory_update", output: "No memory with that key is stored.", isError: true },
    "done",
  );
  expect(updated.title).toBe("Could not update that memory");
});
