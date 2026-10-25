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

export const defaultComputer: ComputerPort = {
  async read(computerId: string, path: string): Promise<string> {
    return `Granted computer ${computerId} (${path}).`;
  },
};

export const defaultConnector: ConnectorPort = {
  async call(connectorId: string, tool: string): Promise<string> {
    return `Granted connector ${connectorId} tool ${tool}.`;
  },
};
