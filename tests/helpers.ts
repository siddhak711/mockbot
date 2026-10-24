import { SseParser } from "../src/sse";

export async function readSse(
  response: Response,
): Promise<Array<{ event: string; data: unknown }>> {
  if (!response.body) throw new Error("Expected a response body");
  const parser = new SseParser();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: unknown }> = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const message of parser.push(decoder.decode(value, { stream: true }))) {
      events.push({ event: message.event, data: JSON.parse(message.data) as unknown });
    }
  }
  return events;
}

export function deltas(events: Array<{ event: string; data: unknown }>): string {
  return events
    .filter((event) => event.event === "delta")
    .map((event) => String((event.data as { text?: string }).text ?? ""))
    .join("");
}
