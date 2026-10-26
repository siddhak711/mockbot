/** Matches the default agent id milestone 3 will use for memories. */
export const LEAD_AGENT_ID = "agent_default";

/** The lead may delegate. Per-user leads keep that role when their id is not the legacy default. */
export function isLeadAgent(agent: { id: string; isLead?: boolean }): boolean {
  return agent.isLead === true || agent.id === LEAD_AGENT_ID;
}

export const LEAD_AGENT_NAME = "Mockbot";

export const DELEGATE_TOOL_NAME = "delegate";

export const USE_COMPUTER_TOOL = "use_computer";

export const USE_CONNECTOR_TOOL = "use_connector";
