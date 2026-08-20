/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SchemaForm } from "../src/schema-form";
import type { JsonObject, JsonSchema } from "../src/api/types";

const schema: JsonSchema = {
  type: "object",
  properties: {
    a: { type: "number" },
    b: { type: "string", format: "email" },
  },
  required: ["a", "b"],
};

// React tracks the native input/textarea value setter to detect real user
// input; assigning `.value =` directly gets swallowed by that tracker, so
// tests set the value through the native prototype setter first (the same
// trick @testing-library/react's fireEvent uses under the hood).
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

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

describe("SchemaForm", () => {
  it("renders a number input and a string input from the JSON-Schema 2020-12 shape", async () => {
    await act(async () => {
      root.render(<SchemaForm schema={schema} value={{}} onChange={() => {}} />);
    });
    const numberInput = container.querySelector('input[type="number"]');
    const textInput = container.querySelector('input[type="text"], input[type="email"]');
    expect(numberInput).not.toBeNull();
    expect(textInput).not.toBeNull();
  });

  it("blocks Run (reports valid=false) when the email field fails format validation", async () => {
    let lastValid: boolean | null = null;
    const value: JsonObject = { a: 1, b: "not-an-email" };
    await act(async () => {
      root.render(
        <SchemaForm
          schema={schema}
          value={value}
          onChange={(_next, valid) => {
            lastValid = valid;
          }}
        />,
      );
    });
    // liveValidate runs on mount via rjsf's onChange-less initial validation path;
    // trigger a form change event to force validation to run and report back.
    const numberInput = container.querySelector('input[type="number"]') as HTMLInputElement;
    await act(async () => {
      setNativeValue(numberInput, "2");
    });
    expect(lastValid).toBe(false);
  });

  it("blocks Run when the raw-JSON fallback tab has invalid JSON", async () => {
    let lastValid: boolean | null = null;
    await act(async () => {
      root.render(
        <SchemaForm
          schema={undefined}
          value={{}}
          onChange={(_next, valid) => {
            lastValid = valid;
          }}
        />,
      );
    });
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      setNativeValue(textarea, "{not valid json");
    });
    expect(lastValid).toBe(false);
  });
});
