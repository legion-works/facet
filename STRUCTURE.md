# Structure

Planned tree:

| Directory              | Purpose                                 | Public symbols                                                                       |
| ---------------------- | --------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/shared`           | Shared schemas and protocol types       | `contracts/artifact.ts`: ArtifactTypeSchema, Artifact, Revision, RenderRun, Template |
| `src/service`          | Byte-dumb storage and serving service   | `store/`: openDatabase, runMigrations, ArtifactRepository                            |
| `src/cli`              | User-facing command line interface      | Planned                                                                              |
| `src/gallery-web`      | Sandboxed gallery shell and frames      | Planned                                                                              |
| `src/validation`       | Tiered validation workers               | Planned                                                                              |
| `src/harness-adapters` | Harness integration adapters            | Planned                                                                              |
| `scripts`              | Build and repository checks             | `verify-decisions.ts`, `egress-penetration.ts`                                       |
| `tests`                | Unit, integration, and acceptance tests | Planned                                                                              |
| `docs`                 | Product and decision documentation      | `docs/decisions`                                                                     |
