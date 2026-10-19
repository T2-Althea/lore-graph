# Lore Graph — API notes (Milestone 0)

Everything here was confirmed by reading the SillyTavern source (release branch,
Oct 2026). Paths are relative to the SillyTavern root.

## Extension location and loading
- `public/scripts/extensions/third-party/<name>/` is the "global" third-party folder
  (`src/constants.js` → `globalExtensions`). Per-user installs live in
  `data/<user>/extensions/`. Both are served at `/scripts/extensions/third-party/<name>/`;
  the user folder wins on a name clash (`src/users.js` `createExtensionsRouteHandler`).
- Discovery requires a `manifest.json` (`src/endpoints/extensions.js` `hasManifest`).
- SillyTavern's own `.gitignore` ignores `public/scripts/extensions/third-party/`,
  so this folder can be its own git repo.
- Manifest fields used: `display_name`, `loading_order`, `js`, `css`,
  `hooks.activate` (exported function called after the script loads,
  `public/scripts/extensions.js` `callExtensionHook`), and later
  `generate_interceptor` (name of a `globalThis` function).
- Settings panel: `renderExtensionTemplateAsync('third-party/lore-graph', 'settings')`
  renders `settings.html`; third-party panels are appended to `#extensions_settings2`
  (container in `public/index.html`). Built-in drawer markup: `.inline-drawer`.
- Settings persistence: `extension_settings.lore_graph` + `saveSettingsDebounced()`.
  Configuration only — never the graph.
- `SillyTavern.getContext()` (`public/scripts/st-context.js`) exposes most of what we
  need: `chat`, `eventSource`, `eventTypes`, `setExtensionPrompt`, `getRequestHeaders`,
  `getTokenCountAsync`, `ConnectionManagerRequestService`, `Popup`/`callGenericPopup`,
  `extensionSettings`, `saveSettingsDebounced`, `chatMetadata`.

## Running before each generation
- `generate_interceptor` in the manifest names a `globalThis` function called as
  `fn(chat, contextSize, abort, type)` before each generation, in `loading_order`
  (`public/scripts/extensions.js` `runGenerationInterceptors`). Skip `type === 'quiet'`
  like vectors does. `chat` is `coreChat`, a shallow-copied list of the messages about
  to be sent (`public/script.js`). The just-sent user message should already be in
  it — verify in M3 for regenerate/swipe/continue types.
- Vectors clears its prompt at the start of each interceptor call, then sets it again
  if it found anything. We'll do the same so stale lore never lingers.

## Prompt injection
- `setExtensionPrompt(key, value, position, depth, scan, role, filter)` in
  `public/script.js`. Positions (`extension_prompt_types`): `NONE -1`, `IN_PROMPT 0`,
  `IN_CHAT 1` (uses depth + role), `BEFORE_PROMPT 2`. Roles
  (`extension_prompt_roles`): `SYSTEM 0`, `USER 1`, `ASSISTANT 2`.
  `scan` = let World Info scan the injected text. Vectors exposes position, depth,
  role and template; we'll offer the same.
- Prompt key ordering is alphabetical by key; vectors uses `3_vectors` and
  `4_vectors_data_bank`. We'll use something like `5_lore_graph`.

## Data Bank
- `public/scripts/chats.js`:
  - `getDataBankAttachments(includeDisabled = false)` → global + chat + character
    attachments merged, disabled ones excluded.
  - `getDataBankAttachmentsForSource(source, includeDisabled = true)` with
    `ATTACHMENT_SOURCE.GLOBAL | CHAT | CHARACTER` for per-scope lists.
  - `getFileAttachment(url)` → file text (uses `cache: 'force-cache'`).
  - Attachment objects have `url`, `name`, `size`, `created`.
- Event `FILE_ATTACHMENT_DELETED` fires with the file URL when one is removed.

## File storage (graph + chunk index)
- `POST /api/files/upload` `{ name, data }` where `data` is base64. Writes to
  `data/<user>/user/files/<name>` and returns `{ path }` (`src/endpoints/files.js`).
  Filename must match `^[a-zA-Z0-9_\-.]+$`, not start with `.`.
- Read back with `GET /user/files/<name>` — use `cache: 'no-store'` (not
  `getFileAttachment`, which force-caches).
- `POST /api/files/delete` `{ path }` deletes; `POST /api/files/verify` `{ urls }`
  checks existence.
- These files do not show up in the Data Bank list (the list comes from settings, not
  the folder). Planned names: `lore-graph_chunks.json`, `lore-graph_graph.json`.

## Connection Manager (extraction LLM calls)
- `ConnectionManagerRequestService` (`public/scripts/extensions/shared.js`):
  - `sendRequest(profileId, prompt, maxTokens, { stream, signal, extractData,
    includePreset, includeInstruct }, overridePayload)`. `prompt` is a string or a
    chat-messages array. Returns extracted data (`.content`) when not streaming.
  - `getSupportedProfiles()`, `getProfile(id)`, `handleDropdown(...)` to build a
    profile picker. Supports Chat Completion and Text Completion profiles.
  - Throws if the Connection Manager extension is disabled.

## Embeddings (for M3b)
- Vector endpoints (`src/endpoints/vectors.js`): `/api/vector/insert`, `/query`,
  `/query-multi`, `/list`, `/delete`, `/purge`. Body includes `source`,
  `collectionId`, and source-specific settings.
- **LM Studio works through the `vllm` source.** It POSTs `{ input, model }` to
  `<apiUrl>/v1/embeddings` (`src/vectors/vllm-vectors.js`). Request body needs
  `apiUrl` and `model`. Vectors uses the user's vLLM server URL from Text Completion
  settings or its own alt endpoint URL; we'll keep our own URL + model settings.
- The vllm path ignores the `isQuery` flag, so the Qwen3 query instruction must be
  prepended manually to `searchText` (never to inserted documents).
- Indexes are stored at `data/<user>/vectors/<source>/<collectionId>/<model>/`,
  so changing the model automatically uses a fresh index. We'll still record the
  model in our own files to warn the user and offer re-embedding.
- Items are `{ hash: number, text, index }`. Query returns `{ hashes, metadata }`
  ordered by similarity, already filtered by `threshold` — **no raw scores are
  returned**. The inspector can show rank, not similarity values, unless we decide
  otherwise later.
- Planned collections: `lore_graph_chunks` and `lore_graph_entities`.

## Lore file observations (for M1)
- Both sample files are UTF-8 with CRLF line endings — normalize to `\n`.
- Line 1 = title, line 2 = `Doc ID: COS-00X`; first section has no leading `---`.
- Guardrail blocks (`✕ Not This`) can appear before a section's first `#`
  subsection (e.g. Guild §2), so they belong to the intro chunk.

## Chunk index (M1)
- Stored in `data/<user>/user/files/lore-graph_chunks.json`:
  `{ version, docs: { [fileUrl]: { url, name, scope, status, docId, title, textHash,
  parserVersion, chunks[], warnings[], error, duplicateOf } } }`.
- Keyed by file URL. Data Bank files get a new URL when edited; we also compare a
  text hash and `PARSER_VERSION`, so changed files (or a parser update) re-parse.
- Entries for character/chat-scoped files stay in the index when you switch chats
  (shown greyed as "not active"), so later extraction work isn't thrown away.
  `FILE_ATTACHMENT_DELETED` removes an entry; a Forget button removes stale ones.
- Manual imports are saved as `lore-graph_import_<name>_<time>.txt` with scope
  `imported`; they don't touch the Data Bank.
- Duplicate Doc IDs: the first active source wins (global → character → chat →
  imported); the other is shown with an error and its chunks aren't used.
- Token counts come from `getTokenCountAsync` (the current API's tokenizer), so
  exact counts — and whether a long section splits — can vary by model.

## Graph extraction (M2)
- One call per chunk via `ConnectionManagerRequestService.sendRequest` with
  `extractData: false`, so we read the raw response: content via
  `context.extractMessageFromData(raw, apiType)` and `finish_reason` to detect replies
  cut off by the token limit (thinking models can spend the whole limit reasoning and
  return empty content). Strict JSON is requested with `overridePayload.json_schema`
  (the backend maps it to `response_format` for NanoGPT and most OpenAI-style sources).
- Answers are always validated locally (`schema.js`), retried once with the error
  explained, and failures are stored with the reason and the start of the reply.
- Rate/usage-limit errors (429 etc.) wait 20s, then 60s, then pause the run.
- `lore-graph_graph.json`: `{ chunkResults: { [chunkId]: { hash, status, entities,
  relations, notes, error, ... } }, decisions: { merges, rejected, pending }, graph }`.
  The graph is rebuilt from `chunkResults` (no LLM) by `graph.js buildGraph`:
  names/aliases are matched with `normalizeKey` (case, leading article, punctuation,
  last-word plural) and unioned; placeholder = never `defined_here`.
- Measured: GLM 5.3 thinking via NanoGPT took ~3 minutes for one chunk (15 entities,
  20 relations, good quality). Calls are sequential because each sees the entity list.
- Each call only carries known entities whose name/alias appears in the chunk (or that
  were found elsewhere in the same section): `graph.js selectRelevantEntities`. Keeps
  input ~1.3k tokens/chunk no matter how large the library gets.
- Parallel extraction: `extraction_concurrency` workers (default 3) share one queue; saves
  are chained so an older snapshot can never land after a newer one. Each request has a
  time limit (`extraction_timeout_seconds`, default 180) via its own AbortController.
- The graph file is re-read (`loadGraphStore({ fresh: true })`) before any change, so a
  second tab with an older copy can't overwrite newer results; an unreadable file stops
  the operation instead of starting from an empty graph.

## Retrieval and injection (M3)
- `manifest.json` → `generate_interceptor: "loreGraph_generateInterceptor"`; it calls
  `injection.js interceptGeneration`, which clears the prompt key `5_lore_graph`, runs
  retrieval, and sets it again with `setExtensionPrompt` (position/depth/role/scan from
  settings). Skips `type === 'quiet'` like Vectors. Never throws (a toast instead).
- `retrieval.js` (pure, Node-testable): match names/aliases with `matchForm` (whole
  words, every word singular, aliases < 4 letters ignored unless marked safe) → seeds
  weighted by recency (0.8 per older message) → expand `hops` steps (×0.5 per step ×
  edge-type weight × hub factor 1/log2(chunk count)) → chunk score = Σ entity score ×
  (1 if defined there, 0.4 if only mentioned) × hub → ×1.25 if directly matched →
  shared-distinctive-word boost (IDF-weighted, reorders only) → fill budget, TL;DR-only
  when tight, guardrail always kept, section TL;DR written once.
- Everyday words: per-entity mode Always / Needs context / Never in
  `lore-graph_matching.json` (separate from the graph file so it can't race with
  extraction). "Needs context" names count only if an "Always" name also matched.
  Optional one-call "Check for everyday words" suggests them; the user reviews.
- The test box and "Last injection" show the full report (seeds, ignored, paths,
  chunk scores and statuses, injected text). The last report is kept in memory only;
  per-message history is Milestone 4.

## Meaning search (M3b)
- Provider: SillyTavern's `vllm` vector source → LM Studio `/v1/embeddings`
  (`apiUrl` + `model` in the request body). Calls run on the ST server, not the browser.
  Tested with `text-embedding-qwen3-embedding-4b@q8_0`: 2560-dim, normalized, no pooling
  problem; 118 chunks + 381 entities embed in ~22 s.
- Collections `lore_graph_chunks` and `lore_graph_entities`; vectors live in
  `data/<user>/vectors/vllm/<collection>/<model>/`, so a different model gets its own
  index automatically. `lore-graph_embeddings.json` maps vector hash → chunk/entity id
  and records the model. Note: Vectors' "Purge all" would delete these too (rebuild fixes).
- Query = scanned messages (newest 2000 chars) prefixed with the Qwen instruction; stored
  documents never get it. `/api/vector/query` returns matches in order but no scores,
  so a second query at threshold + 0.07 marks "strong" chunk hits; weak ones count half.
- Seeds: chunk hit = direct chunk score 0.6 × rank factor (1, .85, .7, …), its defined
  entities seeded at half that; entity hit = 0.6 × rank × 0.5. Meaning seeds never count
  as the "lore-specific term" that lets everyday words match.
- Measured similarities: real lore matches 0.49–0.66, casual chat ≤ 0.40 → threshold 0.45.
  Default top-k is 4 (CLAUDE.md said 3): with 3, "stone reads like someone" missed
  §3 Ambient Reading (it ranks 4th).
- Undead → Guild §5 is still not found: by meaning Guild §5 ranks 112 of 118; the link
  needs reasoning across documents.
- Definition pull (retrieval step 5b): the top 2 chunks give 35% of their score
  (× hub factor) to the sections that define specific terms they mention; terms in
  more than 4 chunks are skipped. After the user added "file a field exception report"
  to Dungeon §16's guardrail, this pulls in Guild §5 and the undead test passes
  (meaning search on). Writing lore that names the other document's term is what makes
  cross-document links possible.

## Inspector and test list (M4)
- Each AI reply gets `message.extra.lore_graph` (and the same on its current swipe):
  a compact report (≈4–6 KB: seeds, meaning hits, everything sent + 5 near-misses,
  10 paths, short message excerpts, chunk hashes). Attached on `MESSAGE_RECEIVED` from
  the report the interceptor just produced (ignored if older than 15 min, or for
  quiet/impersonate). The lore text is rebuilt from current chunks when opened; edited or
  missing chunks are flagged. A "book" button is prepended to `#message_template
  .extraMesButtons` at runtime (no core file changes) and to messages already on screen.
- Test list: `lore-graph_tests.json` ({ text, expected chunk ids | nothing, note, last }).
  Started from the CLAUDE.md cases. Run all = runRetrieval per test (no LLM calls).
- Meaning-search safety rules found while building M4: entity-only meaning hits need
  other evidence (a chunk meaning hit or any lore name), and with no lore names at all,
  weak chunk hits alone are ignored. 14 short casual lines tested: all inject nothing.

## Graph map (M5)
- Library: Cytoscape.js 3.30.2, `lib/cytoscape.min.js` (MIT), downloaded from the official
  npm package via unpkg; sha256 83e8c54a…dac81 verified identical on jsDelivr. Loaded
  on first use with a plain <script> tag (defines window.cytoscape).
- Views: around one entity (1–2 steps, concentric), whole graph (cose; ~1.3 s for 361
  nodes), and "this reply's lore" from any report's "Show on map": seeds in the centre,
  meaning seeds next, then only the entities that earned each sent chunk its place,
  with their paths in green and dotted "section mentions term" links for definition pulls.
- Styling: color by type, size by chunk count, placeholders hollow/dashed orange,
  contrasts_with/exception_to dashed red, related_to faint. Hubs (> 8 chunks) are hidden by
  default. Zoom is capped at 1.2 after fitting so labels stay readable.

## Chat memory, step 6a
- Stored per chat in `chat_metadata.lore_graph_memory` ({ processedUpTo, mode, nextId,
  memories[] }), so memories follow branches/checkpoints and die with the chat.
  Saved with `context.saveMetadataDebounced()`.
- `extractMemories`: one LLM call per batch of unread messages (auto every N on
  MESSAGE_RECEIVED when enabled, or the "Remember recent events" button). Prompt gets
  people in the chat, story characters seen so far, the last 20 memories (with ids, for
  "supersedes" and "learned"), 3 earlier messages for context, and the new messages
  tagged [#index]. Memory = { kind event|fact|relationship|entity, text, characters,
  witnesses, learned[{name, from, atMessage, hash}], everyone, loreTerms, sources
  [{index, hash}], supersedes, superseded, edited }.
- `validateMemories` (on MESSAGE_DELETED/EDITED/SWIPED, CHAT_CHANGED): drops memories
  whose source messages changed or vanished, drops "learned" entries whose message
  changed, moves processedUpTo back so changed messages are re-read. User-edited memories
  are kept. Results are discarded if the chat changes during the AI call.
- Tested on a fake 8-message scene through GLM 5.3 (~28 s): 6 accurate memories; a
  character asleep during a deal was correctly not a witness and recorded as told later.
- Not injected yet (6b): `mode` single|narrator is stored per chat for that.

## Chat memory, step 6b (sending memories)
- `memory-retrieval.js selectMemories` (pure): drops replaced memories; single mode keeps
  only memories the active character (`context.name2`, which is the speaking member in
  group chats) witnessed, learned, or that everyone knows; narrator mode keeps all and
  labels each "(known to: …)". Score = recency (+0.5 for the 3 newest) + kind bonus
  (facts/relationships/people last longer) + 1 per character/lore term mentioned in the
  scanned messages + 0.6 per lore term matching this reply's lore seeds. Filled to
  `memory_budget` (600) by score, then listed in story order.
- Injected as a separate prompt key `6_lore_graph_memory` with the lore block's
  position/depth/role. The header names the character directly (not the {{char}} macro) and
  avoids em dashes. Works even when no lore is loaded.
- Reports and per-reply records gain a "Story memory" section: what was sent and why,
  and what was hidden because the character didn't witness it.

## Chat memory, step 6c (meaning search + story on the map)
- Memories are embedded into their own collection per chat, `lore_graph_mem_<hash of
  chatId>`, through the same vllm/LM Studio path as lore (hash = text hash, so edits
  re-embed). Synced lazily before each reply when meaning search is on; replaced memories
  are removed. Purged on CHAT_DELETED / GROUP_CHAT_DELETED.
- Query uses its own instruction ("retrieve earlier story events…"). Calibrated on a
  fake scene: relevant memories 0.41–0.61, casual lines ≤0.37, so threshold 0.40, top 4.
- A meaning hit adds max(0.5, 1 − 0.15·rank) to a memory's score (reason "meaning match
  #k"). Witness filtering still applies first, so it never leaks secrets. If LM Studio is
  down, the report says so and names/recency are used.
- `buildStoryGraph`: one pink diamond per character named in memories, dotted links to
  lore entities their memories mention (matched by name/alias) and to characters they
  share a memory with. Shown on the lore map with a "Story (this chat)" toggle; clicking
  a story person lists their memories. Lore graph files are never changed.

## Setting-independent checks (0.4.0)
- Tests are matched to documents by the part of the chunk id before " §" (the Doc ID, or the file
  name when there is no Doc ID line). "Run all tests" skips a test when any document it expects
  isn't loaded ("Needs COS-004, which isn't loaded") and doesn't count it as a failure. If the
  document is loaded but an expected section is gone (renamed), the test runs and fails, naming
  the missing section. "Inject nothing" tests always run. Logic in `test-check.js` (pure).
- A new test list starts with two casual lines only (no setting-specific starter tests).
- "Suggest tests": one AI call with up to 30 sections (id, title, TL;DR or first sentences;
  sections without tests first, spread over documents). The reply is checked locally (unknown
  section ids dropped, duplicates dropped), every suggestion is run once, and the user ticks
  which to keep. The suggestion shows whether it passes now.
- The meaning-search sanity check no longer uses fixed sentences: it searches for up to 6
  sections by their own TL;DR (spread over documents and through each document) and expects the
  section in the top 5, plus the casual lines, which should match nothing.
- AI instructions (extraction, duplicates, everyday words, memory) use invented examples instead
  of terms from one setting, and the default injection header no longer says "codices".
- `loadJsonFile` retries a read that returns half-written JSON (seen when the panel refreshed the
  graph summary while extraction was saving the graph file).
- Local test setup: see `dev/README.md`.

## Panel and extraction tweaks (0.4.1)
- "Lore sources" and "Chunks" headers fold their lists (counts shown in the header); Rescan/Import
  and the status line stay visible. Folded state is saved in `settings.folded`.
- The extraction window (both "Extract new & changed" and "Re-extract everything") has
  Select all / Unselect all.
- API-key errors (401/403, "Unauthorized", "Forbidden", "invalid … key/credentials") pause the run
  at once instead of retrying. NanoGPT locks a client out with 429 after repeated invalid
  credentials, so retrying with a bad key makes the lockout worse. Note: the browser only gets
  the HTTP status text ("Too Many Requests"); the provider's full message is only in the
  SillyTavern server console, so a lockout 429 still looks like an ordinary rate limit.

## Capital letter only (0.5.0)
- New per-name matching mode `capital` ("Capital letter only"). Matching still finds the name
  case-insensitively first; then `hasCapitalisedUse` looks at the original message: a capitalised
  use that isn't at the start of a sentence, line or quote makes it count like Always; otherwise it
  counts like Needs context (so "sea water" next to a clear lore term still counts).
  The name's leading article is ignored ("the Abyss" is looked for as "Abyss"); plurals and
  hyphenated multi-word names work; "Seaward" doesn't match "Sea".
- Names set to Capital letter only skip the "under 4 letters" rule (e.g. "Sea"): the capital
  makes them specific enough.
- Everyday-word check: the AI also returns `capitalised` (names that are a specific lore thing
  when capitalised). The review window has a mode dropdown per name (Needs context / Capital
  letter only / Leave as is). Capital letter only is pre-selected when the AI says so or when the
  lore itself writes the name capitalised mid-sentence (≥2 times, ≤15% lowercase; titles not
  counted: `countNameCasing`, `looksCapitalisedInLore`). Names already set to Needs context
  whose lore casing looks capitalised are offered too, with no AI call.
- Reports say "written with a capital letter" / "written without a capital letter" for these names.
- Meaning search never sees lowercase uses of capital-letter names (they're removed from the
  query, and don't vouch for weak meaning matches). "Capital letter, strict"
  (`capital_strict`) also treats a capital at a sentence/quote/line start as an ordinary
  word: it needs a lore term nearby to count, and is hidden from meaning search.
