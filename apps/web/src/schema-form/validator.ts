/**
 * JSON-Schema 2020-12 validator for the schema-driven form.
 *
 * Library survey (bead constraint: must support draft 2020-12, not 07 /
 * 2019-09):
 *  - @rjsf/core@6 + @rjsf/validator-ajv8: mature, actively maintained,
 *    React-native, and its validator is a thin wrapper around `ajv` — which
 *    ships a real `Ajv2020` class (`ajv/dist/2020`) implementing the actual
 *    2020-12 meta-schema/vocabulary. `customizeValidator({ AjvClass })` is
 *    the documented rjsf extension point for swapping draft dialects, so
 *    this is a supported integration, not a hack.
 *  - formily/react: heavier (its own schema dialect + reactive engine on
 *    top), no clear 2020-12 win over rjsf — skipped per bead guidance.
 *  - Rolling a validator from scratch: reinventing `$ref`/`$dynamicRef`,
 *    `unevaluatedProperties`, format assertions, etc. — exactly what ajv
 *    already gets right. Not worth it for one form component.
 *
 * Net: @rjsf/core@6 + @rjsf/validator-ajv8, with AjvClass swapped to
 * Ajv2020. This is the "small 2020-12 shim" the bead allows for.
 */
import type Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020";
import { customizeValidator } from "@rjsf/validator-ajv8";

export const schemaFormValidator = customizeValidator({
  // Ajv2020 has the identical constructor/instance shape as the default
  // Ajv export (both extend the same AjvCore) — only the pre-registered
  // meta-schema differs (2020-12 vs draft-07). rjsf's own createAjvInstance
  // already wires up ajv-formats by default, so no extenderFn needed here.
  AjvClass: Ajv2020 as unknown as typeof Ajv,
});
