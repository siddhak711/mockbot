export type ComputerAction =
  | { name: "write"; args: { path: string; content: string } }
  | { name: "read"; args: { path: string } }
  | { name: "list"; args: { path: string } }
  | { name: "exec"; args: { command: string } };

export function planComputerTurn(message: string): ComputerAction[] | null {
  const text = message.trim();
  if (!text) return null;
  const path = fileName(text);
  const actions: ComputerAction[] = [];
  if (path && /\b(create|write|save)\b/i.test(text)) {
    actions.push({ name: "write", args: { path, content: fileContent(text) } });
  }
  if (path && /\bread\b/i.test(text)) {
    actions.push({ name: "read", args: { path } });
  }
  const command = commandOf(text, path);
  if (command) actions.push({ name: "exec", args: { command } });
  if (
    actions.length === 0 &&
    /\blist\b/i.test(text) &&
    /\b(file|files|sandbox|computer|workspace)\b/i.test(text)
  ) {
    actions.push({ name: "list", args: { path: "." } });
  }
  return actions.length > 0 ? actions : null;
}

function fileName(text: string): string | null {
  const match = text.match(/\b(?:named|called)\s+`?([A-Za-z0-9._/-]+)`?/i);
  if (!match?.[1]) return null;
  return match[1].replace(/[.,]$/, "");
}

function fileContent(text: string): string {
  const quoted = text.match(/\bsays\s+"([^"]*)"/i) ?? text.match(/\bsays\s+'([^']*)'/i);
  if (quoted) return quoted[1] ?? "";
  const plain = text.match(/\bsays\s+(.+?)(?=,|\.|$)/i);
  return plain?.[1]?.trim() ?? "";
}

function commandOf(text: string, path: string | null): string | null {
  const quoted = text.match(/`([^`\n]+)`/);
  if (quoted?.[1]?.trim()) return quoted[1].trim();
  if (path && /\b(run|exec|command|print)\b/i.test(text)) return `cat ${path}`;
  return null;
}
