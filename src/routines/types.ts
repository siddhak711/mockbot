export type RoutineStatus = "active" | "paused";

export type RunStatus = "pending" | "running" | "succeeded" | "failed";

export type RoutineTrigger = { kind: "cron"; cron: string } | { kind: "event"; eventName: string };

export type Routine = {
  id: string;
  name: string;
  prompt: string;
  trigger: RoutineTrigger;
  status: RoutineStatus;
  conversationId: string | null;
  userId: string | null;
  agentId: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RoutineRun = {
  id: string;
  routineId: string;
  status: RunStatus;
  source: "cron" | "event";
  eventId: string | null;
  scheduledFor: string;
  claimedBy: string | null;
  claimedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  conversationId: string | null;
  assistantMessageId: string | null;
  error: string | null;
  createdAt: string;
  resultExcerpt: string | null;
};

export type RoutineEvent = {
  id: string;
  name: string;
  payload: string | null;
  createdAt: string;
};
