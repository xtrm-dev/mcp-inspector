import type { JsonObject } from "@mcp-inspector-x/protocol";

export type ToolNodePresentation = "collapsed" | "expanded" | "focus";

export interface WorkspaceNode {
  id: string;
  capabilityId: string;
  presentation: ToolNodePresentation;
  selected: boolean;
  arguments: JsonObject;
  renderer?: string;
  credentialsRef?: string;
}

export interface WorkspaceEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  binding?: { fromPath: string; toArgument: string };
}

export interface Workspace {
  id: string;
  name: string;
  nodes: WorkspaceNode[];
  edges: WorkspaceEdge[];
}

export function focusNode(workspace: Workspace, nodeId: string): Workspace {
  if (!workspace.nodes.some((node) => node.id === nodeId)) throw new Error(`Unknown workspace node: ${nodeId}`);
  return {
    ...workspace,
    nodes: workspace.nodes.map((node) => ({
      ...node,
      presentation: node.id === nodeId ? "focus" : node.presentation === "focus" ? "expanded" : node.presentation,
    })),
  };
}

export function selectedNodes(workspace: Workspace): WorkspaceNode[] {
  return workspace.nodes.filter((node) => node.selected);
}
