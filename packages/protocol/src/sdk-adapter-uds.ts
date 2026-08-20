import { connect as netConnect, type Socket } from "node:net";
import { ReadBuffer, serializeMessage, type Transport, type JSONRPCMessage } from "@modelcontextprotocol/client";

/**
 * Transport over a Unix domain socket already opened by the privileged
 * runner (see ADR-0003 — the runner spawns stdio MCP children, never the
 * gateway). Frames one JSON-RPC message per line using the SDK's own
 * ReadBuffer/serializeMessage helpers (the same framing StdioClientTransport
 * uses), so the runner's raw byte pump needs no protocol awareness.
 *
 * Lives in its own module (not sdk-adapter.ts) so the top-level `node:net`
 * import never reaches the browser bundle — sdk-adapter.ts loads this via
 * dynamic import inside the stdio branch only, keeping apps/web's bundle
 * free of Node builtins.
 */
export class UdsLineTransport implements Transport {
  private socket: Socket | undefined;
  private readonly readBuffer = new ReadBuffer();
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: ((message: JSONRPCMessage) => void) | undefined;

  constructor(private readonly socketPath: string) {}

  async start(): Promise<void> {
    if (this.socket) throw new Error("UdsLineTransport already started");
    this.socket = await new Promise<Socket>((resolve, reject) => {
      const s = netConnect(this.socketPath);
      const onErr = (err: Error) => {
        s.off("connect", onOk);
        reject(err);
      };
      const onOk = () => {
        s.off("error", onErr);
        resolve(s);
      };
      s.once("error", onErr);
      s.once("connect", onOk);
    });
    this.socket.on("data", (chunk: Buffer) => {
      this.readBuffer.append(chunk);
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          message = this.readBuffer.readMessage();
        } catch (err) {
          this.onerror?.(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        if (message === null) break;
        this.onmessage?.(message);
      }
    });
    this.socket.on("close", () => this.onclose?.());
    this.socket.on("error", (err: Error) => this.onerror?.(err));
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const socket = this.socket;
    if (!socket) throw new Error("UdsLineTransport: send() before start()");
    await new Promise<void>((resolve, reject) => {
      socket.write(serializeMessage(message), (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    this.socket?.end();
  }
}
