# Local test setup

Everything here is for testing the extension; SillyTavern ignores this folder.

## Setup (once)

```
dev/setup.sh
```

Clones SillyTavern (release branch) into `dev/.work/sillytavern`, writes a `config.yaml` for local
testing (port 8123, no browser launch, no auto-updates) and installs Playwright into `dev/node_modules`.
Chromium comes from `PLAYWRIGHT_BROWSERS_PATH` (or set `CHROMIUM_PATH`).

## Run everything

```
dev/run-all.sh            # unit tests + every e2e script
dev/run-all.sh private    # unit tests + only e2e scripts whose name contains "private"
```

For each e2e script, `run-all.sh` resets the SillyTavern user folder, copies the extension in the
way a GitHub install does (without `dev/` and `.git`), starts the fake AI (port 8124) and
SillyTavern (port 8123) in the foreground, and stops them afterwards. Screenshots go to
`dev/screenshots/`, server logs to `dev/.work/logs/`.

## Pieces

- `fake-backend.js` / `fake-answers.js`: an OpenAI-style server with scripted answers for the
  extension's background requests (graph extraction, duplicates, everyday words, memories, test
  suggestions) and word-overlap embeddings standing in for LM Studio. It is not a real model:
  it checks the code paths, not answer quality. `GET /__requests` lists what it received.
- `fixtures/`: two small invented settings (one with Doc IDs, one without), used by the committed tests.
- `unit/`: Node tests for the modules that don't need SillyTavern (parser, graph, retrieval, test checks).
- `e2e/`: Playwright scripts. `lib.mjs` holds the shared steps (open SillyTavern, add a "Fake AI"
  connection profile, import lore, extract, screenshots).
- `dev/.work/lore/` (not committed): put real lore files here to run `e2e/private-lore.mjs` and the
  private unit checks. The repository is public, so personal lore stays out of git.

## Notes on running SillyTavern here

- With no internet, SillyTavern's AI Horde status calls fail and stop the settings from loading;
  the e2e scripts answer `/api/horde/*` with empty JSON.
- A fresh user folder starts with the first-run welcome popup, which holds up settings loading;
  `run-all.sh` writes a `settings.json` with `firstRun: false` to skip it.
