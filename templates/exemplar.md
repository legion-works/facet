# Render verification dossier

**Verdict first.** Everything below rendered from one published markdown
artifact — tables, checklists, and three live diagrams — inside a sandboxed
frame with no network, no host capabilities, and a verdict its own code
cannot forge.

> The diagrams are not screenshots. They are mermaid sources in this file,
> rendered in isolation and counted: three fences here means the verifier
> expects exactly three renderer-owned SVG roots. Agreement is the verdict.

## Scope

| check                 | tier | expectation            |
| --------------------- | :--: | ---------------------- |
| fenced blocks counted |  0   | 3 mermaid · 1 json     |
| renderer roots        |  1   | 3 — one per fence      |
| layout observable     |  1   | non-degenerate viewBox |
| forgery probes        |  1   | shim = protocol        |

## Trust boundaries

```mermaid
%%{init: {"theme": "base", "themeVariables": {"background": "transparent", "primaryColor": "#1e2030", "primaryTextColor": "#c8d3f5", "primaryBorderColor": "#3b4261", "lineColor": "#545c7e", "textColor": "#a9b1d6", "fontFamily": "ui-monospace, Menlo, monospace", "fontSize": "13px", "clusterBkg": "#1a1b26", "clusterBorder": "#2e2e3a", "edgeLabelBackground": "#16161e"}}}%%
flowchart TB
  subgraph host [host · operator session]
    CLI[facet cli]
    SVC[service · byte-dumb]
  end
  subgraph netns [network namespace · no egress]
    T0[tier 0 parser worker]
    T1[tier 1 headless shell]
  end
  subgraph browser [your browser · display only]
    SHELL[gallery shell]
    FRAME[opaque frame · nonce CSP]
  end
  CLI --> SVC
  SVC -->|bytes| T0
  SVC -->|bytes| T1
  SVC -->|lease| SHELL
  SHELL -->|one-shot ingress| FRAME
  classDef ok stroke:#c3e88d,color:#c3e88d
```

## Publish lifecycle

```mermaid
%%{init: {"theme": "base", "themeVariables": {"background": "transparent", "primaryColor": "#1e2030", "primaryTextColor": "#c8d3f5", "primaryBorderColor": "#3b4261", "lineColor": "#545c7e", "textColor": "#a9b1d6", "fontFamily": "ui-monospace, Menlo, monospace", "fontSize": "13px", "actorBkg": "#1e2030", "actorBorder": "#3b4261", "actorTextColor": "#c8d3f5", "signalColor": "#545c7e", "signalTextColor": "#a9b1d6", "noteBkgColor": "#222436", "noteBorderColor": "#3b4261", "noteTextColor": "#c8d3f5"}}}%%
sequenceDiagram
  participant agent
  participant svc as service
  participant t1 as tier 1
  agent->>svc: publish (bytes)
  svc->>svc: sha256 · store · lexical counts
  svc->>t1: verify revision
  t1-->>svc: verdict + evidence paths
  svc-->>agent: envelope · ✓ ok · tier 1
```

## Service states

```mermaid
%%{init: {"theme": "base", "themeVariables": {"background": "transparent", "primaryColor": "#1e2030", "primaryTextColor": "#c8d3f5", "primaryBorderColor": "#3b4261", "lineColor": "#545c7e", "textColor": "#a9b1d6", "fontFamily": "ui-monospace, Menlo, monospace", "fontSize": "13px"}}}%%
stateDiagram-v2
  [*] --> dormant
  dormant --> active : first command
  active --> active : requests
  active --> dormant : idle deadline
  note right of dormant : zero processes · zero ports
```

## The contract

```json
{
  "schemaVersion": "facet.v1",
  "ok": true,
  "data": { "command": "readBack", "verdict": { "status": "ok", "tier": 1 } }
}
```

## Checks

- [x] no raw HTML — markup renders as visible text, never elements
- [x] no external fetch — url-bearing sources fail closed
- [x] evidence on disk — screenshot, console, protocol observation
- [ ] promote this revision if the read-back agrees

Published with `facet publish --type markdown` · verified with
`facet read-back --tier visual`.
