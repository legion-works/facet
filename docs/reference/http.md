# HTTP surface

Facet binds loopback only.

## Routes

• `POST /api/v1/commands` — versioned command envelope.
• `GET /api/v1/stream` — revision SSE stream.
• `GET /api/v1/gallery/bootstrap` — gallery bootstrap data.
• `POST /api/v1/gallery/release` — release a gallery lease.

## Authentication

Command and bootstrap requests require `Authorization: Bearer <install-token>`.
Stream requests also require `X-Gallery-Lease: <lease-id>`.

## Host and CSRF

Requests must use the loopback `Host` value issued by the service. Missing or
foreign hosts are rejected. State-changing routes require the authenticated
loopback request; browser origins are not trusted as authorization.

## Status shape

Status reports `state` (`dormant` or `active`), `process` (`pid`, `uptimeMs`,
`rssBytes`, `pssBytes`), `dbBytes`, `evidenceBytes`, `activeLeases`,
`activeJobs`, `browserJobs`, `idleDeadline`, `version`, and `contractVersion`.
Unavailable memory values are `null`; RSS from multiple processes is not summed.
