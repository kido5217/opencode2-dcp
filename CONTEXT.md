# opencode2-dcp

Glossary for this project. No implementation details here.

- **DCP (Dynamic Context Pruning)** — replacing pruned conversation content with placeholders before the LLM request; session history itself is never modified.
- **Port** — the v2-native re-implementation of DCP that lives in this repo.
- **V2 baseline** — the opencode2 / @opencode/plugin version pair the port is built and verified against (currently 2.0.7).
- **Core** — the compress tool, the deduplication strategy, and the purge-errors strategy.
- **Surface** — user-facing layer over Core: the `/dcp` panel, `/dcp-compress`, prompt overrides, notifications.
- **CLI plugin** — opencode v2's mechanism for extending the terminal UI; the v2 home of the `/dcp` panel.
- **opencode-dcp.jsonc** — the port's config file (renamed from v1's `dcp.jsonc`).
- **Boundary ID** — the `mNNNN` / `bN` tags that mark messages or compressed sections; input to the compress tool.
- **Guiding error** — a validation failure surfaced to the model as recoverable guidance text (teach the correct shape, re-send), instead of aborting the work.
- **Manual mode** — a mode in which compression is initiated explicitly by the user (`/dcp-compress`) rather than by DCP's automatic thresholds; the trigger starts a turn in which the model is expected to call the compress tool.
- **Context limit thresholds** — DCP-internal token thresholds, relative to the model's context window and overridable per model, that drive DCP's nudges (context-limit nudge above the max; turn and iteration nudges at/above the min). DCP-internal only: never written to the host's model metadata.
