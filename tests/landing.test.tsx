// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LandingPage } from "../components/landing/landing-page";
import { waitlistMessage } from "../src/landing/waitlist";

afterEach(() => {
  cleanup();
});

it("keeps the violet actually word, the example names, and placeholder legal links", () => {
  render(<LandingPage />);

  const heading = screen.getByRole("heading", { level: 1 });
  expect(heading.querySelector("em")?.textContent).toBe("actually");
  expect(screen.getByText("Send to alex@northwind.co")).toBeTruthy();
  expect(screen.getByText("Book Lupa · Thu 7:45 PM · 4 people")).toBeTruthy();
  expect(screen.getAllByText("Reply to Alex").length).toBeGreaterThan(0);
  expect(
    screen.getByText("Mockbot hands the fare to Scout, Scout books, Inkwell writes the note."),
  ).toBeTruthy();

  expect(screen.getByRole("link", { name: "Privacy" }).getAttribute("href")).toBe("#");
  expect(screen.getByRole("link", { name: "Terms" }).getAttribute("href")).toBe("#");

  const css = readFileSync("components/landing/landing.css", "utf8");
  const fonts = readFileSync("app/globals.css", "utf8");
  expect(css).toMatch(/\.daylight h1 em\s*\{[^}]*color:\s*var\(--v\)/);
  expect(css).toContain("--v: #6e4df5");
  expect(css).not.toContain("fonts.googleapis.com");
  expect(fonts).toContain('url("/fonts/inter.woff2")');
  expect(fonts).toContain('url("/fonts/jetbrains-mono-500.woff2")');
});

it("treats the waitlist as a browser demo and does not call the network", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  render(<LandingPage />);

  const email = screen.getAllByLabelText("Email address")[0];
  const form = email.closest("form");
  expect(form).toBeTruthy();

  fireEvent.change(email, { target: { value: "not-an-email" } });
  fireEvent.submit(form!);
  expect(screen.getByText("That email looks incomplete. Check it and try again.")).toBeTruthy();

  fireEvent.change(email, { target: { value: "ada@example.com" } });
  fireEvent.submit(form!);
  expect(
    screen.getByText("You are on the list. We will write to ada@example.com when your spot opens."),
  ).toBeTruthy();
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

it("accepts a simple address and rejects a blank one", () => {
  expect(waitlistMessage("ada@example.com").ok).toBe(true);
  expect(waitlistMessage("").ok).toBe(false);
  expect(waitlistMessage("ada@example").ok).toBe(false);
});
