# Security reference

Facet uses two bearer capabilities:

• The install token authorizes ordinary agent/service commands.
• The distinct operator promote capability authorizes `promote`.

Promotion requires the operator token and records the operator identity and timestamp. Structured logs contain request, artifact, revision, and timestamp identifiers only; source bytes and bearer tokens are redacted and never logged.

TTY presence is not authorization. An agent can allocate a PTY; only the distinct operator token can promote. Promotion changes retention and audit state, not validation tier or sandbox trust.

## Static HTML artifact policy

HTML artifacts are static, script-free, and carry no `<style>` block or
`style=` attribute. The verifier rejects:

- the short known-dangerous element set: `script`, `iframe`, `object`,
  `embed`, `form`, `link`, `meta`, `base`, `style`
- every `on*=` event handler attribute
- non-https, protocol-relative, and `javascript:` URLs on `<a>`, `<img>`,
  and `<source>` (`<a>` allows `mailto:`; `<img>` and `<source>` allow
  `data:` and `https:`)

This is not the same surface the other artifact types police. Static
HTML is the only type that can carry text-format risk inside its body,
so the policy applies at parse time in Tier 0 and again in the Tier 1
renderer. The verdict is bound to the bytes the operator published; the
frame never injects script or styles into the artifact, only wraps the
sanitized body in a marker-bearing wrapper that never reaches storage
or export.

### The two CSP jobs

The frozen CSP at `src/shared/security/frozen-csp.ts` does two unrelated
jobs, and the HTML widening widens only one of them:

| job                  | directives                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verdict protection   | `script-src 'nonce-<BOOTSTRAP_NONCE>'`, `connect-src 'none'`, `frame-src 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `worker-src 'none'`, `default-src 'none'` |
| Display-time privacy | `img-src`, `font-src`                                                                                                                                                                     |

A page that can run attacker code or open a network socket can forge a
verdict or exfiltrate, so the verdict-protection directives stay closed
on every artifact type. `img-src` and `font-src` protect PRIVACY at
display time only — the verifier never follows these URLs, so widening
`img-src` to `https:` (from `data:`) cannot weaken the verdict. The
widening was an over-restriction being corrected: artifacts are authored
by the operator's own agents, which hold bash and unrestricted network,
so the artifact channel is strictly weaker than its author.

The full frozen CSP, verbatim:

```
default-src 'none';
script-src 'nonce-<BOOTSTRAP_NONCE>';
style-src 'unsafe-inline';
img-src data: https:;
font-src data:;
worker-src 'none';
connect-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none';
frame-src 'none';
media-src 'none'
```

`style-src 'unsafe-inline'` exists for the vendored Tailwind/daisyUI
stylesheet, which is loaded into the frame by `src/gallery-web/frame/styles/html-source.css`
under the per-frame nonce. A custom `data:` font ships in the bundle as
`font-src data:` allows; no remote font ever loads.

→ [HTML reference](html.md) for the full HTML contract.

## Insecure mode

Insecure mode is never enabled by default. It is boot-only: set `FACET_INSECURE=1`,
`2`, or `3`, then restart the service. Environment changes do not alter a live
service.

| level | contract                                                                                      |
| ----: | --------------------------------------------------------------------------------------------- |
|   `0` | Secure defaults. Tier 0 and Tier 1 use their normal isolation.                                |
|   `1` | Removes Tier 1 network-namespace isolation only. Real Tier 0 and Tier 1 validators still run. |
|   `2` | Removes Tier 0 and Tier 1 network-namespace isolation. Real validators still run.             |
|   `3` | Performs no validation and records `insecure:unvalidated`.                                    |

Levels compose as a forced floor: the effective level is never below the
operator's `FACET_INSECURE` value. `FACET_INSECURE_AUTO=1` may raise a level when
startup probes fail, but it never selects level 3. With auto mode off, hard
`tier*_unavailable` errors remain hard errors.

Every insecure-level verdict carries its `Verdict.insecure` marker. L1 and L2
statuses are real validator results — do not call them unvalidated. L3 also
carries the marker and owns `insecure:unvalidated`. Startup, the service-ready
envelope, CLI output, and gallery badge are intentionally loud. The CLI emits
an `INSECURE` line.
