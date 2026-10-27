/**
 * The roster line under an agent's name: the first line of its newest message,
 * with markdown marks removed. The line is never shortened; the sidebar wraps it.
 */
export function rosterPreview(content: string): string {
  const firstLine =
    content
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("```")) ?? "";
  return firstLine
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^>\s*/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
