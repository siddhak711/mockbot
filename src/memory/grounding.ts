const STOP = new Set([
  "that",
  "this",
  "with",
  "from",
  "your",
  "have",
  "user",
  "about",
  "just",
  "like",
  "into",
  "what",
  "when",
  "where",
  "which",
  "would",
  "could",
  "should",
  "please",
  "remember",
  "forget",
  "they",
  "them",
  "then",
  "than",
  "been",
  "were",
  "will",
  "shall",
  "because",
  "really",
  "there",
  "their",
  "dont",
  "does",
]);

export function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? []).filter(
    (word) => !STOP.has(word),
  );
}

export function groundedInUserMessages(text: string, userMessages: readonly string[]): boolean {
  const words = contentWords(text);
  if (words.length === 0) return false;
  const corpus = userMessages.join("\n").toLowerCase();
  const hits = words.filter((word) => corpus.includes(word));
  return hits.length / words.length >= 0.5;
}

export function copiedFromToolOutput(
  text: string,
  userMessages: readonly string[],
  toolOutputs: readonly string[],
): boolean {
  if (toolOutputs.length === 0) return false;
  const words = contentWords(text);
  if (words.length === 0) return false;
  const userCorpus = userMessages.join("\n").toLowerCase();
  const toolCorpus = toolOutputs.join("\n").toLowerCase();
  let toolOnly = 0;
  for (const word of words) {
    if (toolCorpus.includes(word) && !userCorpus.includes(word)) toolOnly += 1;
  }
  return toolOnly / words.length >= 0.5;
}
