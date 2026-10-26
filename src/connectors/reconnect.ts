/** Tracks a reconnect so a later pasted URL is not saved as that connector. */
export class ReconnectAttempt {
  id: string | null = null;

  start(id: string) {
    this.id = id;
  }

  clear() {
    this.id = null;
  }

  take(): string | null {
    const id = this.id;
    this.id = null;
    return id;
  }
}
