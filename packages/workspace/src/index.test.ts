import { describe, expect, it } from "vitest";
import { focusNode, selectedNodes, type Workspace } from "./index";

const workspace: Workspace = {
  id: "w1",
  name: "test",
  edges: [],
  nodes: [
    { id: "a", capabilityId: "a", presentation: "focus", selected: true, arguments: {} },
    { id: "b", capabilityId: "b", presentation: "collapsed", selected: false, arguments: {} },
  ],
};

describe("workspace", () => {
  it("allows only the requested node to retain focus", () => {
    const result = focusNode(workspace, "b");
    expect(result.nodes.find((node) => node.id === "a")?.presentation).toBe("expanded");
    expect(result.nodes.find((node) => node.id === "b")?.presentation).toBe("focus");
  });

  it("returns selected nodes", () => {
    expect(selectedNodes(workspace).map((node) => node.id)).toEqual(["a"]);
  });
});
