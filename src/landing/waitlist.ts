const EMAIL = /^\S+@\S+\.\S+$/;
const MAX_EMAIL_LENGTH = 254;

export const WAITLIST_IDLE = "Free. One email when your spot opens.";
export const WAITLIST_PENDING = "Adding you to the list…";
export const WAITLIST_INVALID = "That email looks incomplete. Check it and try again.";
export const WAITLIST_FAILED = "We could not add you to the list. Try again in a moment.";

/** Trims and lowercases an email, or returns null when it is not a usable address. */
export function normalizeWaitlistEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL.test(email)) return null;
  return email;
}

export function waitlistJoinedMessage(email: string): string {
  return `You are on the list. We will write to ${email} when your spot opens.`;
}
