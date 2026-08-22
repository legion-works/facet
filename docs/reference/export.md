# Export reference

## Syntax

```sh
facet export <artifactId> [--revision <sha>] [--format source|render] [--out <path>] [--force] [--include-bytes]
```

The default format is `source`. The command returns one JSON envelope on
stdout and writes the exported bytes plus a mandatory sidecar locally. In
file-output mode the CLI envelope reports `paths`, `byteCount`, and `sidecar`
instead of duplicating base64 bytes. Pass `--include-bytes` to retain the wire
payload in the CLI envelope; the HTTP/API contract always retains it.

## Source and render

`source` exports the exact bytes stored for the selected revision. For TSX that
is the immutable `.tsx` source, not the derived compiled bundle. `render`
exports the stored Tier 1 screenshot for that revision. Render export reads
retained evidence; it serves the stored bytes, never starts a renderer or
reruns validation. The detected PNG or WebP format is preserved. Legacy `.png`
evidence remains backward compatible and can still be read and exported.

Both formats carry the selected revision and its stored verdict in the
sidecar. A missing render screenshot is an `evidence_unavailable` error.

## Default extensions

| Format   | Artifact type       | Extension |
| -------- | ------------------- | --------- |
| `source` | markdown or Mermaid | `.md`     |
| `source` | SVG                 | `.svg`    |
| `source` | chart               | `.json`   |
| `source` | TSX                 | `.tsx`    |
| `render` | new evidence        | `.webp`   |
| `render` | legacy evidence     | `.png`    |

The default name is `<slug>-<revisionSha prefix><extension>`.

## `--out` and sidecar names

`--out` sets the artifact path. The sidecar replaces the artifact extension
with `.facet.json`:

```sh
facet export art-123 --out exports/chart.json
# writes exports/chart.json and exports/chart.facet.json
```

An extensionless path gets `.facet.json` appended:

```sh
facet export art-123 --out exports/chart
# writes exports/chart and exports/chart.facet.json
```

## Overwrite and `--force`

The command checks both output paths before writing. If either exists, export
fails unless `--force` is present. With `--force`, both files are staged in
their target directory and replaced as a pair. A failed write leaves existing
output content untouched.

## Sidecar

Every successful export writes a sidecar. All sidecars contain:

`artifactId`, `slug`, `revisionSha`, `artifactType`, `renderer`, `verdict`,
`format`, and `exportedAt`. Render sidecars additionally require `renderFormat`;
source sidecars omit `renderFormat`. It is the detected stored evidence format
(`webp` for new captures, `png` for legacy captures).

There is no flag to suppress the sidecar. A successful artifact file without
its sidecar is not a valid export.

## Verdict honesty

The sidecar describes the stored verdict. Export does not approve, promote,
revalidate, or otherwise change the artifact.

## `evidence_unavailable`

Render export returns typed `evidence_unavailable` when the selected revision
has no Tier 1 run, the run has no capture, retention evicted the evidence, or
the recorded screenshot file is missing.

It does not fall back to an older run or substitute source bytes.

## Security boundary

The service serves stored bytes and metadata. The CLI owns filesystem writes,
including `--out`, `--force`, and sidecar creation. Export does not rerender
artifact content and does not import renderers or parsers into the service.
