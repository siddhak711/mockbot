import { CronError, parseCron } from "./cron";

export class RoutineInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutineInputError";
  }
}

const EVENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

export function validateName(value: string): string {
  const name = value.trim();
  if (!name) throw new RoutineInputError("Name is required.");
  if (name.length > 80) throw new RoutineInputError("Name is too long.");
  if ([...name].some((char) => char.charCodeAt(0) < 32)) {
    throw new RoutineInputError("Name cannot include line breaks.");
  }
  return name;
}

export function validatePrompt(value: string): string {
  const prompt = value.trim();
  if (!prompt) throw new RoutineInputError("Prompt is required.");
  if (prompt.length > 20_000) throw new RoutineInputError("Prompt is too long.");
  return prompt;
}

export function validateCron(value: string): string {
  const cron = value.trim().replace(/\s+/g, " ");
  try {
    parseCron(cron);
  } catch (error) {
    if (error instanceof CronError) throw new RoutineInputError(error.message);
    throw error;
  }
  return cron;
}

export function validateEventName(value: string): string {
  const name = value.trim();
  if (!EVENT_NAME.test(name)) {
    throw new RoutineInputError(
      "Event name must be 1–80 characters: letters, numbers, and . _ : -",
    );
  }
  return name;
}

export function validatePayload(value: string | null | undefined): string | null {
  if (value == null) return null;
  const payload = value.trim();
  if (!payload) return null;
  if (payload.length > 4_000) throw new RoutineInputError("Event payload is too long.");
  return payload;
}
