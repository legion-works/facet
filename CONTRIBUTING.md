# Contributing

Keep changes focused and use conventional-commit style. Before opening a change, run:

```sh
bun run lint
bun run format:check
bun run typecheck
bun test
bun run check:boundaries
bun run verify-adapter-size
```

The `ci` and `security-egress` checks are required branch-protection checks. Changes to shell launchers, CSP, iframe sandboxing, token handling, or network namespaces must include passing evidence from both the egress and gate-forgery acceptance tests. `security-egress` always reports a status: irrelevant paths pass without running the expensive probes; relevant paths run them on the named self-hosted runner with user namespaces enabled. It may not be relabeled optional because a hosted image lacks namespaces — move the check to the named runner instead.

Install the native gitleaks binary; package wrappers are not accepted.

Test, build, and boundary gates activate as their trees land in later stages.

oxlint and oxfmt provide a fast Rust oxc toolchain with deny-warnings and deterministic formatting, avoiding plugin-ecosystem drift. Lefthook keeps hooks runtime-agnostic. Zod is the single schema source of truth for compile-time types and runtime boundary validation. oxfmt is pinned exactly because it is pre-1.0.
