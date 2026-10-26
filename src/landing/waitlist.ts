const EMAIL = /^\S+@\S+\.\S+$/;

export const WAITLIST_IDLE = "Free. One email when your spot opens.";

export function waitlistMessage(email: string): { ok: boolean; text: string } {
  if (!EMAIL.test(email)) {
    return {
      ok: false,
      text: "That email looks incomplete. Check it and try again.",
    };
  }
  return {
    ok: true,
    text: `You are on the list. We will write to ${email} when your spot opens.`,
  };
}
