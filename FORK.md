# tomorrowflow/SeeCode

This fork serves the OpenClaw factory's per-project architecture maps. Factory nodes install `skills/seecode` pinned to a fork commit, and the architecture viewer image is built from the same commit.

Fork changes are additive. Never edit anything under `skills/seecode/`, so upstream syncs stay conflict-free. To sync, run `git fetch upstream && git merge upstream/main`.

| Path | Change |
|---|---|
| `.github/workflows/release.yml` | The release job runs only in `Aryanutkarsh/seecode`, so pushes to the fork never bump versions or tag |
| `viewer/` | Architecture viewer: renders each board's `docs/architecture` specs from a read-only clone and serves them on port 17318 (`viewer/server.mjs` documents its environment, `viewer/compose.yaml` the host setup). `viewer/drift.mjs --board <id>` writes the nightly drift report the factory's gardener reads; a board's `driftIgnore` lists module paths, tech or service names that are deliberately left off the map. The header's picker opens the map at any past spec commit (`/board/<id>/at/<sha>/`), and `viewer/delta.mjs` and `/board/<id>/delta` show what changed in the specs between two commits |
| `Dockerfile`, `.dockerignore` | The viewer image: Node 24, git, `skills/seecode` and `viewer/` |
| `.github/workflows/fork-viewer.yml` | Viewer tests on PRs; on `main`, publishes `ghcr.io/tomorrowflow/seecode:<sha7>` |
| `FORK.md` | This file |
