import type { McpToolDefinition, ProtocolNegotiation } from "@mcp-inspector-x/protocol";

export type CapabilityType = "tool" | "resource" | "prompt" | "extension";

export interface CapabilityRecord {
  id: string;
  serverId: string;
  type: CapabilityType;
  name: string;
  displayName: string;
  description?: string;
  tool?: McpToolDefinition;
}

export interface ServerRecord {
  id: string;
  displayName: string;
  protocol: ProtocolNegotiation;
  capabilities: CapabilityRecord[];
}

function encode(part: string): string {
  return encodeURIComponent(part.trim());
}

export function buildCapabilityId(serverId: string, type: CapabilityType, name: string): string {
  return `${encode(serverId)}/${type}/${encode(name)}`;
}

export function registerTool(serverId: string, tool: McpToolDefinition): CapabilityRecord {
  return {
    id: buildCapabilityId(serverId, "tool", tool.name),
    serverId,
    type: "tool",
    name: tool.name,
    displayName: tool.title ?? tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    tool,
  };
}
