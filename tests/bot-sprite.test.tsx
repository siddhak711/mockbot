// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BotSprite } from "../components/bot-sprite";

function mockMotion(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  vi.stubGlobal("matchMedia", (query: string) => {
    expect(query).toBe("(prefers-reduced-motion: reduce)");
    return {
      matches,
      media: query,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
    };
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("renders the violet idle animation at 32px", () => {
  mockMotion(false);
  render(<BotSprite state="idle" label="Mockbot, ready" />);
  const img = screen.getByRole("img", { name: "Mockbot, ready" });
  expect(img.getAttribute("src")).toBe("/sprites/crown3d/anim/violet-idle.webp");
  expect(img.hasAttribute("srcset")).toBe(false);
  expect(img.getAttribute("width")).toBe("32");
  expect(img.getAttribute("height")).toBe("32");
  const slot = img.parentElement;
  expect(slot?.getAttribute("data-sprite-state")).toBe("idle");
  expect(slot?.getAttribute("data-sprite-color")).toBe("violet");
  expect(slot?.getAttribute("data-sprite-motion")).toBe("animated");
});

it("renders a crew color and the static srcset when motion is reduced", () => {
  mockMotion(true);
  const { container } = render(<BotSprite state="working" color="teal" size={16} />);
  const img = container.querySelector("img.bot-sprite:not(.bot-sprite-out)");
  expect(img?.getAttribute("src")).toBe("/sprites/crown3d/static/teal-working@1x.png");
  expect(img?.getAttribute("srcset")).toBe(
    "/sprites/crown3d/static/teal-working@1x.png 1x, /sprites/crown3d/static/teal-working@2x.png 2x, /sprites/crown3d/static/teal-working@3x.png 3x",
  );
  expect(img?.getAttribute("width")).toBe("24");
  expect(img?.getAttribute("alt")).toBe("");
  expect(img?.parentElement?.getAttribute("data-sprite-motion")).toBe("static");
});
