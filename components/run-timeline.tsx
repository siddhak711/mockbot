import {
  eventSummary,
  formatCost,
  formatDuration,
  formatTokenCount,
  runTotals,
  type RunEvent,
} from "../src/runs/events";

function body(value: string | null): string {
  if (!value) return "(empty)";
  return value;
}

export function RunTimeline({ runId, events }: { runId: string; events: RunEvent[] }) {
  const totals = runTotals(events);
  return (
    <div className="routines-column">
      <p className="run-id">
        Run <code>{runId}</code>
      </p>
      <section className="run-totals" aria-label="Run totals">
        <div className="run-total">
          <span>Tokens</span>
          <strong data-testid="run-total-tokens">{totals.tokens}</strong>
        </div>
        <div className="run-total">
          <span>Cost</span>
          <strong data-testid="run-total-cost">{formatCost(totals.costUsd)}</strong>
        </div>
        <div className="run-total">
          <span>Time</span>
          <strong data-testid="run-total-time">{formatDuration(totals.ms)}</strong>
        </div>
      </section>
      <ol className="run-timeline">
        {events.map((event) => (
          <li key={event.seq}>
            <details className="run-event" data-type={event.type}>
              <summary>
                <span className={`run-type ${event.type}`}>{event.type}</span>
                <span className="run-summary">{eventSummary(event)}</span>
                <span className="run-metric">{formatTokenCount(event.tokens)}</span>
                <span className="run-metric">{formatCost(event.costUsd)}</span>
                <span className="run-metric">{formatDuration(event.ms)}</span>
              </summary>
              <div className="run-body">
                <div>
                  <h2>Input</h2>
                  <pre>{body(event.input)}</pre>
                </div>
                <div>
                  <h2>Output</h2>
                  <pre>{body(event.output)}</pre>
                </div>
              </div>
            </details>
          </li>
        ))}
      </ol>
    </div>
  );
}
