# Security policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Use the repository's **Security → Advisories
→ Report a vulnerability** flow so the report can be discussed privately. Include the affected
commit, reproduction steps, expected impact and any suggested mitigation.

Ordinary crashes, rendering defects and protocol incompatibilities can use the public issue tracker
as long as logs contain no credentials, account names, private addresses or filesystem paths.

## Deployment model

TSWoW WebClient is experimental software. The Node gateway is an unauthenticated HTTP/WebSocket
bridge to the configured authserver and worldserver and can trigger expensive local asset work.
`ALLOWED_ORIGINS` is not an authentication boundary because non-browser clients can choose their
own `Origin` header.

- The supported default is loopback-only (`127.0.0.1:8090`).
- Never expose the raw gateway port directly to the public Internet.
- Public hosting of the gateway or `dist/web` is not supported by this educational release.
  Data-equipped build output may contain locally generated client tables and must remain local.
- Keep `MODULE_UI_WRITE=0` except during trusted local authoring.
- Treat `.env`, server configs and generated metadata as sensitive even when the repository ignores
  them.

Only the current `main` branch receives security fixes. This policy does not promise a particular
response time or production support level.
