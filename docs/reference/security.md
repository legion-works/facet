# Security reference

Facet uses two bearer capabilities:

• The install token authorizes ordinary agent/service commands.
• The distinct operator promote capability authorizes `promote`.

Promotion requires the operator token and records the operator identity and timestamp. Structured logs contain request, artifact, revision, and timestamp identifiers only; source bytes and bearer tokens are redacted and never logged.

TTY presence is not authorization. An agent can allocate a PTY; only the distinct operator token can promote. Promotion changes retention and audit state, not validation tier or sandbox trust.
