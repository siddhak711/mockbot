// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextRequest } from "next/server";
import { afterEach, expect, it, vi } from "vitest";
import { POST as joinWaitlist } from "../app/api/waitlist/route";
import { LandingPage } from "../components/landing/landing-page";
import { proxy } from "../proxy";
import { resetAppContext, setAppContext } from "../src/context";
import {
  WAITLIST_FAILED,
  WAITLIST_INVALID,
  WAITLIST_PENDING,
  normalizeWaitlistEmail,
} from "../src/landing/waitlist";
import { MockProvider } from "../src/llm";
import { ConversationStore } from "../src/store";

afterEach(async () => {
  cleanup();
  await resetAppContext();
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

it("posts the waitlist email and shows pending, success, and failure states", async () => {
  let resolve: (response: Response) => void = () => {};
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementationOnce(() => new Promise<Response>((done) => (resolve = done)))
    .mockRejectedValueOnce(new TypeError("Failed to fetch"));
  render(<LandingPage />);

  const email = screen.getAllByLabelText("Email address")[0] as HTMLInputElement;
  const form = email.closest("form");
  expect(form).toBeTruthy();

  fireEvent.change(email, { target: { value: "not-an-email" } });
  fireEvent.submit(form!);
  expect(screen.getByText(WAITLIST_INVALID)).toBeTruthy();
  expect(fetchSpy).not.toHaveBeenCalled();

  fireEvent.change(email, { target: { value: " Ada@Example.com " } });
  fireEvent.submit(form!);
  expect(screen.getByText(WAITLIST_PENDING)).toBeTruthy();
  expect(email.disabled).toBe(true);
  expect(fetchSpy).toHaveBeenCalledWith(
    "/api/waitlist",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ email: "ada@example.com" }) }),
  );
  resolve(Response.json({ ok: true }));
  await waitFor(() =>
    expect(
      screen.getByText(
        "You are on the list. We will write to ada@example.com when your spot opens.",
      ),
    ).toBeTruthy(),
  );
  expect(email.disabled).toBe(false);

  fireEvent.submit(form!);
  await waitFor(() => expect(screen.getByText(WAITLIST_FAILED)).toBeTruthy());
  expect(email.disabled).toBe(false);
  fetchSpy.mockRestore();
});

it("normalizes a simple address and rejects a blank one", () => {
  expect(normalizeWaitlistEmail(" Ada@Example.com ")).toBe("ada@example.com");
  expect(normalizeWaitlistEmail("")).toBeNull();
  expect(normalizeWaitlistEmail("ada@example")).toBeNull();
  expect(normalizeWaitlistEmail(42)).toBeNull();
});

it("stores waitlist emails once, without a session", async () => {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });
  const post = (body: unknown) =>
    joinWaitlist(
      new Request("http://localhost/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  expect((await post({ email: "nope" })).status).toBe(400);
  expect((await post({ email: "Ada@Example.com" })).status).toBe(200);
  expect((await post({ email: "ada@example.com" })).status).toBe(200);
  const rows = await store.connection.query<{ email: string }>("SELECT email FROM waitlist");
  expect(rows.rows).toEqual([{ email: "ada@example.com" }]);
  expect(await store.joinWaitlist("ada@example.com")).toEqual({ created: false });

  expect(proxy(new NextRequest("http://localhost:3000/api/waitlist")).status).toBe(200);
});
