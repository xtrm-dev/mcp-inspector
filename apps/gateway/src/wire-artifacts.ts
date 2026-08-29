import type { WireCapture } from "@mcp-inspector-x/protocol";
import type { EvidenceRef, Storage } from "@mcp-inspector-x/storage";

/**
 * Persist a captured HTTP wire round as two `raw_request` + `raw_response`
 * artifacts on the given Execution. Additive to the existing
 * ProtocolEvidence-summary evidence row that dispatch paths already write —
 * this is the true request/response bytes-on-the-wire, matching the shape
 * stdio-proxy emits for the stdio path (see stdio-proxy.test.ts).
 *
 * Bodies are already redacted at the recorder boundary for header values;
 * text-shaped bodies pass through the SecretsRegistry scrub the sdk-adapter
 * was constructed with. Response bodies are stored as-received.
 */
export function persistWireArtifacts(
  storage: Storage,
  executionId: string,
  wire: WireCapture | null | undefined,
): EvidenceRef[] {
  if (!wire) return [];
  const requestBlob = storage.artifacts.put({
    bytes: new TextEncoder().encode(JSON.stringify(wire.request)),
    mediaType: "application/json",
  });
  const requestRow = storage.evidence.append({
    executionId,
    kind: "raw_request",
    artifactRef: requestBlob.hash,
  });
  const rows: EvidenceRef[] = [requestRow];
  if (wire.response) {
    const responseBlob = storage.artifacts.put({
      bytes: new TextEncoder().encode(JSON.stringify(wire.response)),
      mediaType: "application/json",
    });
    rows.push(
      storage.evidence.append({
        executionId,
        kind: "raw_response",
        artifactRef: responseBlob.hash,
      }),
    );
  }
  return rows;
}
