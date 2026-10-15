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
