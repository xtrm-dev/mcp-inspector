import { useMemo, useState } from "react";
import Form from "@rjsf/core";
import type { IChangeEvent } from "@rjsf/core";
import type { JsonObject, JsonSchema } from "../api/types";
import { schemaFormValidator } from "./validator";


export interface SchemaFormProps {
  /** capability.inputSchema (JSON-Schema 2020-12). Undefined -> raw-JSON only. */
  schema: JsonSchema | undefined;
  value: JsonObject;
  onChange: (value: JsonObject, valid: boolean) => void;
}

type Tab = "form" | "raw";

/**
 * Schema-driven argument editor for a tool node. Renders a JSON-Schema form
 * when `schema` is present; always offers a raw-JSON fallback tab. Blocks
 * Run by reporting `valid: false` through onChange when either the form has
 * validation errors or the raw JSON doesn't parse.
 */
export function SchemaForm({ schema, value, onChange }: SchemaFormProps) {
  const hasSchema = schema !== undefined && Object.keys(schema).length > 0;
  const [tab, setTab] = useState<Tab>(hasSchema ? "form" : "raw");
  const [rawText, setRawText] = useState(() => JSON.stringify(value, null, 2));
  const [rawError, setRawError] = useState<string | null>(null);

  const rjsfSchema = useMemo(() => (hasSchema ? (schema as object) : {}), [hasSchema, schema]);

  // rjsf is generic over the form-data shape; JsonObject's recursive
  // definition blows up TS's instantiation depth when fed through rjsf's
  // own (also recursive) schema types, so the rjsf boundary uses a plain
  // Record and casts at the edges instead.
  function handleFormChange(e: IChangeEvent<Record<string, unknown>>) {
    const next = (e.formData ?? {}) as JsonObject;
    setRawText(JSON.stringify(next, null, 2));
    // rjsf's `errors` on the change event only reflects field-level errors
    // it has surfaced under liveValidate; missing-required-property is not
    // in that list until the user has interacted. Run the full validator
    // ourselves so `valid` is honest from the first onChange.
    const valid = hasSchema
      ? schemaFormValidator.validateFormData(next as never, rjsfSchema as never).errors.length === 0
      : true;
    onChange(next, valid);
  }

  function handleRawChange(text: string) {
    setRawText(text);
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setRawError("must be a JSON object");
        onChange(value, false);
        return;
      }
      setRawError(null);
      onChange(parsed as JsonObject, true);
    } catch (err) {
      setRawError(err instanceof Error ? err.message : "invalid JSON");
      onChange(value, false);
    }
  }

  return (
    <div className="schema-form">
      <div className="local-tabs">
        <button className={tab === "form" ? "active" : ""} disabled={!hasSchema} onClick={() => setTab("form")}>
          Form
        </button>
        <button className={tab === "raw" ? "active" : ""} onClick={() => setTab("raw")}>
          Raw JSON
        </button>
      </div>

      {tab === "form" && hasSchema && (
        <Form<Record<string, unknown>>
          schema={rjsfSchema}
          formData={value}
          validator={schemaFormValidator}
          liveValidate
          onChange={handleFormChange}
          onSubmit={() => {}}
        >
          {/* no built-in submit button — Run lives in the toolbar */}
          <span />
        </Form>
      )}

      {tab === "raw" && (
        <div className="raw-json-editor">
          <textarea
            value={rawText}
            onChange={(e) => handleRawChange(e.target.value)}
            spellCheck={false}
            rows={10}
          />
          {rawError && <p className="form-error">{rawError}</p>}
        </div>
      )}
    </div>
  );
}
