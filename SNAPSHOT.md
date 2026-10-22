# Source snapshot

This repository mirrors the **source** of the JARVIS Live app (Channel) as it runs at
live.battemohammad.com. It is a snapshot for reading and review, not the deployment path and
not the working tree.

- Source tree: `/data/apps/jarvis-live`, branch `master`
- Commit captured: `e7629f2` (21 October 2026) — "A line chart carries its figures now, not just a shape"
- Files: 61, all source, documentation and tests

## Deliberately excluded

Conversation context, session and approval state, execution records, logs, promotion snapshots,
generated widget documents, design scratch images and every credential. None of it is needed to
review the code, and all of it is the operator's data rather than the app's.

## Refreshing

`snapshot.sh` re-exports the tracked source from the live tree and commits it here. It reads the
live tree and writes only into this repository.
