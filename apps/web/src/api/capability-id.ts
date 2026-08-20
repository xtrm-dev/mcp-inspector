/**
 * capabilityId helpers matching the gateway's actual scheme
 * (`${serverId}::tool::${name}`, see apps/gateway/src/routes.ts), NOT
 * @mcp-inspector-x/registry's `buildCapabilityId` — that package uses a
 * different `serverId/type/name` format that the gateway's routes don't
 * actually construct or parse. Kept local + tiny rather than reconciling
 * two id schemes across packages for this slice.
 */
export type CapabilityType = "tool" | "resource" | "prompt";

export function buildCapabilityId(serverId: string, type: CapabilityType, name: string): string {
  return `${serverId}::${type}::${name}`;
}

export interface ParsedCapabilityId {
  serverId: string;
  type: CapabilityType;
  name: string;
}

export function parseCapabilityId(capabilityId: string): ParsedCapabilityId | null {
  const parts = capabilityId.split("::");
  if (parts.length !== 3) return null;
  const [serverId, type, name] = parts as [string, string, string];
  if (type !== "tool" && type !== "resource" && type !== "prompt") return null;
  return { serverId, type, name };
}
