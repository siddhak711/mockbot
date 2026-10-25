import { connectorSlug, type ConnectorRecord, type ConnectorTransport } from "../src/connectors";

export function ConnectorsPanel({
  connectors,
  error,
  busy,
  onCreate,
  onToggle,
  onRemove,
}: {
  connectors: ConnectorRecord[];
  error: string | null;
  busy: boolean;
  onCreate: (input: {
    name: string;
    transport: ConnectorTransport;
    target: string;
    secretRef: string;
  }) => Promise<string | null>;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}) {
  return (
    <section className="connectors" aria-label="Connectors">
      <div className="label">Connectors</div>
      {connectors.length === 0 ? (
        <p className="empty">No MCP servers yet</p>
      ) : (
        <div className="connector-list">
          {connectors.map((connector) => (
            <article key={connector.id} className="connector" data-connector={connector.name}>
              <div className="connector-top">
                <span className="connector-name">{connector.name}</span>
                <span className={connector.enabled ? "connector-state on" : "connector-state"}>
                  {connector.enabled ? "On" : "Off"}
                </span>
              </div>
              <p className="connector-target" title={connector.target}>
                {connector.transport === "http" ? "HTTP" : "stdio"} · {connector.target}
              </p>
              <p className="connector-meta">
                {connector.secretRef ? `Secret ${connector.secretRef}` : "No secret"} · tools{" "}
                {connectorSlug(connector.name)}_…
              </p>
              <div className="connector-actions">
                <button
                  type="button"
                  className="ghost-text"
                  disabled={busy}
                  onClick={() => void onToggle(connector.id, !connector.enabled)}
                >
                  {connector.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  type="button"
                  className="ghost-text danger"
                  disabled={busy}
                  onClick={() => void onRemove(connector.id)}
                >
                  Remove
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      <ConnectorForm busy={busy} onCreate={onCreate} />
      {error ? (
        <p className="connector-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ConnectorForm({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (input: {
    name: string;
    transport: ConnectorTransport;
    target: string;
    secretRef: string;
  }) => Promise<string | null>;
}) {
  return (
    <form
      className="connector-form"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        const transport = data.get("transport") === "stdio" ? "stdio" : "http";
        void onCreate({
          name: String(data.get("name") ?? ""),
          transport,
          target: String(data.get("target") ?? ""),
          secretRef: String(data.get("secretRef") ?? ""),
        }).then((message) => {
          if (!message) form.reset();
        });
      }}
    >
      <label>
        Name
        <input
          name="name"
          aria-label="Connector name"
          placeholder="Demo"
          required
          disabled={busy}
        />
      </label>
      <label>
        Transport
        <select
          name="transport"
          aria-label="Connector transport"
          disabled={busy}
          defaultValue="http"
        >
          <option value="http">HTTP</option>
          <option value="stdio">stdio</option>
        </select>
      </label>
      <label>
        URL or command
        <input
          name="target"
          aria-label="Connector target"
          placeholder="http://127.0.0.1:8787/mcp"
          required
          disabled={busy}
        />
      </label>
      <label>
        Secret reference
        <input
          name="secretRef"
          aria-label="Secret reference"
          placeholder="MCP_DEMO_TOKEN"
          autoComplete="off"
          disabled={busy}
        />
      </label>
      <button type="submit" className="ghost-text" disabled={busy}>
        Add connector
      </button>
    </form>
  );
}
