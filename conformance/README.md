# MCP conformance

MCP Inspector X does not claim protocol conformance merely because it uses the official SDK.

The supported client adapter must pass the official MCP conformance suite for the protocol revisions and scenarios that the product claims to support.

Target matrix:

```text
client
├── modern 2026-07-28
└── explicitly supported legacy era(s)
```

The live SDK adapter is intentionally kept behind `McpClientAdapter` until the conformance harness is wired. Expected failures must be documented and temporary; they must not be silently ignored.
