# tomorrowflow/SeeCode

This fork serves the OpenClaw factory's per-project architecture maps. Factory nodes install `skills/seecode` pinned to a fork commit, and the architecture viewer image is built from the same commit.

Fork changes are additive. Never edit anything under `skills/seecode/`, so upstream syncs stay conflict-free. To sync, run `git fetch upstream && git merge upstream/main`.

| Path | Change |
|---|---|
| `.github/workflows/release.yml` | The release job runs only in `Aryanutkarsh/seecode`, so pushes to the fork never bump versions or tag |
| `FORK.md` | This file |
