import { useCallback, useState } from "react";
import {
  activityDisclosure,
  activityDisclosureOnRunning,
  activityDisclosureToggle,
} from "../src/tools/activity-open";
import { readAskUser } from "../src/tools/ask-user";
import { isMockToolResult, type ToolActivity } from "../src/tools/display";
import {
  formatPlanText,
  parsePlanText,
  PROPOSE_PLAN_TOOL,
  readPlan,
  type PlanStep,
} from "../src/tools/plan";

function useActivityDisclosure(running: boolean) {
  const [disclosure, setDisclosure] = useState(() => activityDisclosure(running));
  const [wasRunning, setWasRunning] = useState(running);
  if (running !== wasRunning) {
    setWasRunning(running);
    setDisclosure((current) => activityDisclosureOnRunning(current, running));
  }
  const toggle = useCallback(() => {
    setDisclosure((current) => activityDisclosureToggle(current));
  }, []);
  return { open: disclosure.open, toggle };
}

export type { ToolActivity };

export function ToolActivityCards({
  activities,
  decidingId,
  onDecide,
  onAnswer,
  onPlan,
  onSelect,
  reconnectFor,
  onReconnect,
}: {
  activities: ToolActivity[];
  decidingId?: string | null;
  onDecide?: (id: string, decision: "approve" | "deny") => void;
  onAnswer?: (id: string, answer: string) => void;
  onPlan?: (
    id: string,
    action:
      | { type: "approve"; steps?: PlanStep[] }
      | { type: "edit"; steps: PlanStep[] }
      | { type: "cancel" },
  ) => void;
  onSelect?: (id: string) => void;
  reconnectFor?: (activity: ToolActivity) => string | null;
  onReconnect?: (activity: ToolActivity) => void;
}) {
  if (activities.length === 0) return null;

  return (
    <div className="cards" aria-live="polite">
      {activities.map((activity) => (
        <ActivityRow
          key={activity.id}
          activity={activity}
          decidingId={decidingId}
          onDecide={onDecide}
          onAnswer={onAnswer}
          onPlan={onPlan}
          onSelect={onSelect}
          reconnectLabel={reconnectFor?.(activity) ?? null}
          onReconnect={onReconnect ? () => onReconnect(activity) : undefined}
        />
      ))}
    </div>
  );
}

function ActivityRow({
  activity,
  decidingId,
  onDecide,
  onAnswer,
  onPlan,
  onSelect,
  reconnectLabel,
  onReconnect,
}: {
  activity: ToolActivity;
  decidingId?: string | null;
  onDecide?: (id: string, decision: "approve" | "deny") => void;
  onAnswer?: (id: string, answer: string) => void;
  onPlan?: (
    id: string,
    action:
      | { type: "approve"; steps?: PlanStep[] }
      | { type: "edit"; steps: PlanStep[] }
      | { type: "cancel" },
  ) => void;
  onSelect?: (id: string) => void;
  reconnectLabel?: string | null;
  onReconnect?: () => void;
}) {
  const { open, toggle } = useActivityDisclosure(activity.state === "running");
  const meta =
    activity.state === "approval"
      ? activity.summary
      : activity.state === "running"
        ? activity.detail
        : activity.preview || activity.detail;

  if (activity.name === PROPOSE_PLAN_TOOL) {
    return (
      <PlanCard
        activity={activity}
        disabled={decidingId === activity.id}
        onPlan={onPlan}
        onSelect={onSelect}
      />
    );
  }

  if (activity.state === "ask" && onAnswer) {
    return (
      <AskUserCard
        activity={activity}
        disabled={decidingId === activity.id}
        onAnswer={onAnswer}
        onSelect={onSelect}
      />
    );
  }

  if (activity.state === "approval" && onDecide) {
    return (
      <article
        className="approval-card"
        data-tool={activity.name}
        data-state={activity.state}
        onClick={() => onSelect?.(activity.id)}
      >
        <div className="approval-copy">
          <div className="approval-title">{activity.title}</div>
          {activity.summary ? <div className="approval-meta">{activity.summary}</div> : null}
        </div>
        <div className="card-actions" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="btn ghost deny"
            disabled={decidingId === activity.id}
            onClick={() => onDecide(activity.id, "deny")}
          >
            Skip
          </button>
          <button
            type="button"
            className="btn primary approve"
            disabled={decidingId === activity.id}
            onClick={() => {
              onSelect?.(activity.id);
              onDecide(activity.id, "approve");
            }}
          >
            Run
          </button>
        </div>
        <span className="sr-only">{statusLabel(activity.state)}</span>
      </article>
    );
  }

  return (
    <div data-tool={activity.name} data-state={activity.state}>
      <button
        type="button"
        className="tool-line"
        aria-expanded={open}
        onClick={() => {
          toggle();
          onSelect?.(activity.id);
        }}
      >
        <span className="tool-mark" aria-hidden="true">
          ◦
        </span>
        <span className="tool-line-title">{activity.title}</span>
        {isMockToolResult(activity.name, activity.output) ? <MockBadge /> : null}
        {meta ? <span className="tool-line-meta">· {meta}</span> : null}
        <span className="sr-only">{statusLabel(activity.state)}</span>
      </button>
      {reconnectLabel && onReconnect ? (
        <button type="button" className="text-link tool-reconnect" onClick={onReconnect}>
          Reconnect {reconnectLabel}
        </button>
      ) : null}
      {open ? (
        <div className="tool-expanded">
          {activity.arguments ? (
            <>
              <div className="tool-label">Arguments</div>
              <ToolText text={activity.arguments} streaming={activity.state === "running"} />
            </>
          ) : null}
          {activity.output ? (
            <>
              <div className="tool-label">{activity.state === "error" ? "Error" : "Result"}</div>
              <ToolText text={activity.output} />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function MockBadge() {
  return <span className="mock-badge">MOCK</span>;
}

function AskUserCard({
  activity,
  disabled,
  onAnswer,
  onSelect,
}: {
  activity: ToolActivity;
  disabled: boolean;
  onAnswer: (id: string, answer: string) => void;
  onSelect?: (id: string) => void;
}) {
  const request = readAskUser(activity.arguments);
  const [custom, setCustom] = useState("");
  if (!request) return null;
  return (
    <article
      className="ask-card"
      data-tool={activity.name}
      data-state={activity.state}
      onClick={() => onSelect?.(activity.id)}
    >
      <div className="approval-title">{request.question}</div>
      {request.options.length > 0 ? (
        <div className="ask-options" onClick={(event) => event.stopPropagation()}>
          {request.options.map((option) => (
            <button
              key={option}
              type="button"
              className="btn secondary"
              disabled={disabled}
              onClick={() => onAnswer(activity.id, option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      {request.allowCustom ? (
        <form
          className="ask-custom"
          onClick={(event) => event.stopPropagation()}
          onSubmit={(event) => {
            event.preventDefault();
            const text = custom.trim();
            if (!text || disabled) return;
            onAnswer(activity.id, text);
          }}
        >
          <input
            aria-label="Your answer"
            value={custom}
            disabled={disabled}
            onChange={(event) => setCustom(event.target.value)}
          />
          <button type="submit" className="btn primary" disabled={disabled || !custom.trim()}>
            Send
          </button>
        </form>
      ) : null}
      <span className="sr-only">{statusLabel(activity.state)}</span>
    </article>
  );
}

function PlanCard({
  activity,
  disabled,
  onPlan,
  onSelect,
}: {
  activity: ToolActivity;
  disabled: boolean;
  onPlan?: (
    id: string,
    action:
      | { type: "approve"; steps?: PlanStep[] }
      | { type: "edit"; steps: PlanStep[] }
      | { type: "cancel" },
  ) => void;
  onSelect?: (id: string) => void;
}) {
  const plan = readPlan(activity.arguments);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const waiting = activity.state === "plan" && Boolean(onPlan);
  const [wasWaiting, setWasWaiting] = useState(waiting);
  if (waiting !== wasWaiting) {
    setWasWaiting(waiting);
    if (!waiting) setEditing(false);
  }
  if (!plan) return null;
  return (
    <article
      className="ask-card plan-card"
      data-tool={activity.name}
      data-state={activity.state}
      onClick={() => onSelect?.(activity.id)}
    >
      <div className="approval-title">Plan</div>
      {editing ? (
        <textarea
          className="plan-editor"
          aria-label="Plan steps"
          value={draft}
          disabled={disabled}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setDraft(event.target.value)}
        />
      ) : (
        <ol className="plan-steps">
          {plan.steps.map((step, index) => (
            <li key={`${index}:${step.title}`} className="plan-step" data-step-state={step.state}>
              <span className="plan-check" aria-hidden="true">
                {step.state === "done" ? "✓" : step.state === "active" ? "●" : "○"}
              </span>
              <span>
                <span className="plan-step-title">{step.title}</span>
                {step.detail && step.detail !== step.title ? (
                  <span className="plan-step-detail">{step.detail}</span>
                ) : null}
              </span>
              <span className="sr-only">
                {step.state === "done"
                  ? "Done"
                  : step.state === "active"
                    ? "In progress"
                    : "Pending"}
              </span>
            </li>
          ))}
        </ol>
      )}
      {error ? <div className="plan-error">{error}</div> : null}
      {activity.output && activity.state !== "plan" && activity.state !== "running" ? (
        <div className="approval-meta">{activity.output}</div>
      ) : null}
      {waiting ? (
        <div className="card-actions" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="btn ghost deny"
            disabled={disabled}
            onClick={() => onPlan?.(activity.id, { type: "cancel" })}
          >
            Cancel
          </button>
          {editing ? (
            <button
              type="button"
              className="btn secondary"
              disabled={disabled}
              onClick={() => {
                const parsed = parsePlanText(draft);
                if (!parsed.ok) {
                  setError(parsed.error);
                  return;
                }
                setError("");
                setEditing(false);
                onPlan?.(activity.id, { type: "edit", steps: parsed.steps });
              }}
            >
              Save
            </button>
          ) : (
            <button
              type="button"
              className="btn secondary"
              disabled={disabled}
              onClick={() => {
                setDraft(formatPlanText(plan.steps));
                setError("");
                setEditing(true);
              }}
            >
              Edit
            </button>
          )}
          <button
            type="button"
            className="btn primary approve"
            disabled={disabled}
            onClick={() => {
              if (!editing) {
                onPlan?.(activity.id, { type: "approve" });
                return;
              }
              const parsed = parsePlanText(draft);
              if (!parsed.ok) {
                setError(parsed.error);
                return;
              }
              setError("");
              setEditing(false);
              onPlan?.(activity.id, { type: "approve", steps: parsed.steps });
            }}
          >
            Approve
          </button>
        </div>
      ) : null}
      <span className="sr-only">{statusLabel(activity.state)}</span>
    </article>
  );
}

function statusLabel(state: ToolActivity["state"]): string {
  if (state === "running") return "Running";
  if (state === "approval") return "Needs approval";
  if (state === "ask") return "Waiting for an answer";
  if (state === "plan") return "Needs plan approval";
  if (state === "denied") return "Denied";
  if (state === "error") return "Failed";
  return "Done";
}

export function ToolText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const lines = text.split("\n");
  const diff = lines.some(
    (line) =>
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---")),
  );
  const className = ["tool-block", diff ? "diff" : "", streaming ? "streaming" : ""]
    .filter(Boolean)
    .join(" ");
  if (!diff) return <pre className={className}>{text}</pre>;
  return (
    <pre className={className}>
      {lines.map((line, index) => {
        const kind =
          line.startsWith("+") && !line.startsWith("+++")
            ? "diff-add"
            : line.startsWith("-") && !line.startsWith("---")
              ? "diff-del"
              : undefined;
        return (
          <span key={`${index}:${line.slice(0, 12)}`} className={kind}>
            {line}
            {index < lines.length - 1 ? "\n" : ""}
          </span>
        );
      })}
    </pre>
  );
}
