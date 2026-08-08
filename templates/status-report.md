# Q3 ingest pipeline — status

**Summary.** What changed, what is verified, what is blocked. One paragraph,
verdict first.

## Numbers

| metric                |  value |  delta |
| --------------------- | -----: | -----: |
| verified renders      |  9,412 |   +261 |
| tampered caught       |      3 |     +1 |
| p95 publish → visible | 214 ms | −12 ms |

## Flow

```mermaid
%%{init: {"theme": "base", "themeVariables": {"background": "transparent", "primaryColor": "#1e2030", "primaryTextColor": "#c8d3f5", "primaryBorderColor": "#3b4261", "secondaryColor": "#222436", "tertiaryColor": "#16161e", "lineColor": "#545c7e", "textColor": "#a9b1d6", "fontFamily": "ui-monospace, Menlo, monospace", "fontSize": "14px", "edgeLabelBackground": "#16161e", "clusterBkg": "#1a1b26", "clusterBorder": "#2e2e3a"}}}%%
flowchart LR
  A([source bytes]) --> B[hash + store]
  B --> C{validate}
  C -->|tier 0| D[parse counts]
  C -->|tier 1| E[browser verify]
  D --> F([verdict])
  E --> F
  classDef ok stroke:#c3e88d,color:#c3e88d
  class F ok
```

## Next

- [ ] one action, one owner, one date
- [ ] keep the list short enough to finish
