export type SseMessage = {
  event: string;
  data: string;
};

export class SseParser {
  private buffer = "";

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const parts = this.buffer.split("\n\n");
    this.buffer = parts.pop() ?? "";
    const messages: SseMessage[] = [];
    for (const part of parts) {
      if (!part.trim()) continue;
      let event = "message";
      const dataLines: string[] = [];
      for (const line of part.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      if (dataLines.length === 0) continue;
      messages.push({ event, data: dataLines.join("\n") });
    }
    return messages;
  }
}

export function encodeSse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function ssePadding(): Uint8Array {
  return new TextEncoder().encode(`: ${" ".repeat(2048)}\n\n`);
}
