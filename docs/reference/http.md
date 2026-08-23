# HTTP surface

Facet binds loopback only. The CLI is the supported client; these routes are the
service and gallery contract.

## Routes

| method | route                                                      | purpose                                                                                      | success |
| ------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------: |
| `POST` | `/api/v1/commands`                                         | Parse and dispatch a versioned command envelope.                                             |   `200` |
| `GET`  | `/api/v1/stream`                                           | Stream committed revisions for one leased artifact as SSE.                                   |   `200` |
| `POST` | `/api/v1/gallery/bootstrap`                                | Consume the one-shot `open` capability and return the artifact, revision, bearer, and lease. |   `200` |
| `POST` | `/api/v1/gallery/release`                                  | Release a gallery lease.                                                                     |   `204` |
| `GET`  | `/api/v1/gallery/source?revisionSha=<sha>`                 | Read source bytes and the latest stored verdict for the leased revision.                     |   `200` |
| `GET`  | `/api/v1/gallery/evidence?revisionSha=<sha>`               | Read retained Tier 1 screenshot bytes for the leased revision without rerendering.           |   `200` |
| `GET`  | `/gallery` and `/gallery/*`                                | Serve the built gallery shell and static assets.                                             |   `200` |
| `GET`  | `/gallery/frame?nonce=<32 hex>&type=<type>&theme=<theme>`  | Return a frame document for `markdown`, `mermaid`, `svg`, `chart`, `html`, or `tsx`.         |   `200` |
| `GET`  | `/gallery/frame/bootstrap/*` and `/gallery/frame/chunks/*` | Serve bundled frame scripts.                                                                 |   `200` |

The gallery source route requires a non-empty `revisionSha`. It returns
`artifactId`, the bound SHA, `artifactType`, `renderer`, UTF-8 `source`, and
`verdict` (or `null`); TSX source responses also carry `execution`.
The source and stream routes match both the lease ID and the artifact ID,
preventing a valid lease for one artifact from reading another.

The evidence route requires the same lease and artifact headers as the source
route. It serves retained screenshot bytes with a content type sniffed from
the bytes: `image/webp` or `image/png`. `screenshot_format` metadata does not
override the file signature, and the route never rerenders the artifact.

`theme` is validated as `dark` or `light` when supplied. It selects resolved
frame display state; it is not an authorization or validation control.

## Authentication

`/api/v1/commands` accepts the install bearer or operator bearer. `promote`
requires the operator bearer. Mutations require
`Content-Type: application/json`.

The stream requires:

```text
Authorization: Bearer <install-token>
X-Gallery-Lease: <lease-id>
X-Gallery-Artifact: <artifact-id>
```

The release and source routes use the same bearer plus the two gallery headers.
The bootstrap route uses the one-shot capability returned by `open`; it does
not accept a reusable query-string lease. `X-Gallery-Lease` is deliberately a
header because URL tokens leak through logs, referrers, and browser history.

## Host and CSRF

Requests must use the loopback `Host` value issued by the service. Missing or
foreign hosts are rejected. Missing `Host` is `421`; a foreign host is `400`.
State-changing routes require an authenticated loopback request with `Origin`
absent or equal to the service origin and `Sec-Fetch-Site` absent,
`same-origin`, or `none`. Cross-site mutations return `403`. Browser origins
are not trusted as authorization.

## Status codes

| status | meaning                                                                                                                |
| -----: | ---------------------------------------------------------------------------------------------------------------------- |
|  `200` | Successful envelope, JSON response, SSE stream, gallery file, or frame.                                                |
|  `204` | Gallery lease released.                                                                                                |
|  `400` | Invalid JSON/envelope/request, unsupported frame input, invalid `revisionSha`, invalid content type, or host mismatch. |
|  `401` | Missing or invalid bearer, lease, artifact header, or one-shot bootstrap capability.                                   |
|  `403` | Cross-site mutation or operator-only command attempted with the install bearer.                                        |
|  `404` | Unknown route, missing gallery file, artifact, revision, or template.                                                  |
|  `405` | `GET` sent to the command endpoint.                                                                                    |
|  `409` | Store constraint, duplicate or immutable revision, unsupported artifact type, or pinned revision capacity.             |
|  `413` | Raw request body exceeds the 16 MiB HTTP cap.                                                                          |
|  `422` | Tier 0 worker timeout, protocol error, death, or output cap.                                                           |
|  `503` | Tier 0 sandbox is unavailable.                                                                                         |
|  `500` | Unhandled internal error or gallery build failure.                                                                     |

## Status shape

Status reports artifact-scoped `latestRevisionSha`, `revisionCount`,
`pinnedCount`, and `templateCount` alongside `state` (`dormant` or `active`), `process` (`pid`, `uptimeMs`,
`rssBytes`, `pssBytes`), `dbBytes`, `evidenceBytes`, `activeLeases`,
`activeJobs`, `browserJobs`, `idleDeadline`, `version`, and `contractVersion`.
Unavailable memory values are `null`; RSS from multiple processes is not summed.
