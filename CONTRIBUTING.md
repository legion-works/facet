# Contributing

Keep changes focused and use conventional-commit style. Before opening a change, run:

```sh
bun run lint
bun run format:check
bun run typecheck
bun test
bun run check:boundaries
```

Changes to CSP, iframe sandboxing, or network namespaces require rerunning the egress and forgery gates. Install the native gitleaks binary; package wrappers are not accepted.

oxlint and oxfmt provide a fast Rust oxc toolchain with deny-warnings and deterministic formatting, avoiding plugin-ecosystem drift. Lefthook keeps hooks runtime-agnostic. Zod is the single schema source of truth for compile-time types and runtime boundary validation. oxfmt is pinned exactly because it is pre-1.0.
