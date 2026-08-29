/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SchemaSummary } from "../src/schema-form/SchemaSummary";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("SchemaSummary", () => {
  it("renders — when schema and arguments are absent", async () => {
    await act(async () => {
      root.render(<SchemaSummary />);
    });
    expect(container.textContent).toBe("—");
  });

  it("renders empty-properties schema as —", async () => {
    await act(async () => {
      root.render(<SchemaSummary schema={{ type: "object", properties: {} }} />);
    });
    expect(container.textContent).toBe("—");
  });

  it("renders name, type, required flag and description from a schema", async () => {
    await act(async () => {
      root.render(
        <SchemaSummary
          schema={{
            type: "object",
            properties: {
              ids: { type: "array", description: "article ids" },
              limit: { type: "number" },
            },
            required: ["ids"],
          }}
        />,
      );
    });
    const text = container.textContent ?? "";
    expect(text).toContain("ids");
    expect(text).toContain("array");
    expect(text).toContain("required");
    expect(text).toContain("article ids");
    expect(text).toContain("limit");
    expect(text).toContain("number");
    // limit is not required
    expect(text.match(/required/g)?.length).toBe(1);
  });

  it("prefers prompt arguments over schema when provided", async () => {
    await act(async () => {
      root.render(
        <SchemaSummary
          arguments={[{ name: "topic", description: "topic to greet about", required: true }]}
        />,
      );
    });
    const text = container.textContent ?? "";
    expect(text).toContain("topic");
    expect(text).toContain("required");
    expect(text).toContain("topic to greet about");
  });
});
