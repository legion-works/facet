# AGENTS.md

## Navigation

Search first, then outline the file, then read the relevant symbol. Prefer focused files under 200 lines; split before 300. `index.ts` files are public surfaces only and document their exports.

## Non-negotiables

The service remains byte-dumb: it may hash, store, count lexically, and serve bytes, but must not import renderers or parsers. Fixtures use neutral descriptive names and clean product content.

The test matrix has three layers:

- unit — focused pure behavior
- integration — service and worker boundaries
- acceptance — browser and end-to-end behavior

Public text follows the Legion Works house voice: terse, technical, sentence case, glyphs instead of emoji.
