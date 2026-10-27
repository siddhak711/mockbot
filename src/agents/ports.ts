import type { AgentDirectory } from "./directory";
import type { AgentMemoryPort, ComputerPort, ConnectorPort } from "./types";

/** Stand-in memory: one note stored on the agent row, never another agent's note. */
export class NoteMemory implements AgentMemoryPort {
  constructor(private readonly directory: AgentDirectory) {}

  async list(agentId: string) {
    const agent = await this.directory.get(agentId);
    const content = agent?.memoryNote.trim() ?? "";
    if (!content) return [];
    return [{ key: "note", content }];
  }
}

/**
 * Child runs have no real computer or connector bridge yet. These ports fail with
 * a clear reason instead of returning made-up content.
 */
export const COMPUTER_NOT_WIRED =
  "use_computer is not available: child runs are not connected to a sandbox computer yet.";
export const CONNECTOR_NOT_WIRED =
  "use_connector is not available: child runs are not connected to connectors yet.";

export const defaultComputer: ComputerPort = {
  async read(): Promise<string> {
    throw new Error(COMPUTER_NOT_WIRED);
  },
};

export const defaultConnector: ConnectorPort = {
  async call(): Promise<string> {
    throw new Error(CONNECTOR_NOT_WIRED);
  },
};
