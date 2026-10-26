export type GrantKind = "connector" | "computer";

export type Agent = {
  id: string;
  name: string;
  instructions: string;
  memoryNote: string;
  isLead: boolean;
  createdAt: string;
};

export type AgentGrant = {
  id: string;
  agentId: string;
  kind: GrantKind;
  resourceId: string;
};

export type AgentMemoryFact = {
  key: string;
  content: string;
};

/** Later: the memory repository from milestone 3. Facts are scoped by agent id. */
export interface AgentMemoryPort {
  list(agentId: string): Promise<readonly AgentMemoryFact[]>;
}

/** Later: the milestone 4 computer control API. */
export interface ComputerPort {
  read(computerId: string, path: string): Promise<string>;
}

/** Later: a connector tool on the milestone 2 registry. */
export interface ConnectorPort {
  call(connectorId: string, tool: string, args: Record<string, unknown>): Promise<string>;
}
