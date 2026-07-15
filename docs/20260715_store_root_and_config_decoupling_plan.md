# Store Root and Config Decoupling Plan

> Date: 2026-07-15
> Scope: let a pipeline live outside the site store tree, so cross-site
> automations can move to their own repo and consume the store as an npm
> dependency.
> Status: planned before code changes. Findings below were verified against the
> code on 2026-07-15; two of them contradict what the split was assumed to need.

## 1. Goal

`webmcp-workflow-store` is being narrowed to site knowledge + verified site
capabilities, and published as `@gyga-browser/webmcp-site-store`. Cross-site
pipelines and runbooks move to a separate `webmcp-automation-store` repo that
declares the site store as a dependency:

```json
"dependencies": { "@gyga-browser/webmcp-site-store": "^0.5.0" }
```

Everything the automation layer needs already crosses that boundary — the
published tarball carries `sites/` (264 files), `catalog.json`,
`verification/freshness.json`, and `lib/preflight.mjs`. No knowledge resolver,
lockfile format, or content-hash scheme needs inventing: npm's `dependencies`
range plus `package-lock.json` integrity already pin exactly what a hand-rolled
`dependencies.lock.json` would.

What blocks the move is three couplings in `src/pipeline/pipeline-runner.js`
that assume a pipeline manifest lives *inside* the store tree. This plan removes
them. It changes no pipeline semantics and adds no new concepts.

## 2. What the audit found

### Finding A — `findStoreRoot` guesses, then fails silently (real bug)

`src/pipeline/pipeline-runner.js:107`:

```js
function findStoreRoot(manifestPath) {
  let dir = path.dirname(path.resolve(manifestPath));
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'sites'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(path.resolve(manifestPath));   // ← silent fallback
}
```

The store root is inferred by walking up to eight levels looking for a directory
literally named `sites`. There is no `--store-root` flag and no
`WEBMCP_STORE_ROOT` env var (grepped `src/cli.js`, `src/commands/`,
`src/config-loader.js`, `src/env-loader.js` — no hits).

Move a manifest to `webmcp-automation-store/automations/gemini-to-suno/` and no
ancestor has a `sites/` directory, so the loop exhausts and line 115 returns the
manifest's own directory. Then `pipeline-runner.js:349`:

```js
const workflowAbs = path.resolve(storeRoot, stage.workflow);
```

resolves `sites/suno/workflows/create-song.json` against the automation folder.
The run dies with **"workflow not found"** pointing at a path inside the
automation repo, rather than **"site store not found"**. The failure names the
wrong repo, which is the worst property a failure can have.

This must be fixed before any file moves. Afterwards, every automation would
fail this way.

### Finding B — profile aliases already work end-to-end (no change needed)

The split was assumed to need a new logical-alias mechanism so automations stop
hardcoding profile UUIDs. It already exists. The chain is:

| Step | Location |
| --- | --- |
| stage profile passed to child resolution | `pipeline-runner.js:358` — `...(stage.profile ? { profile: stage.profile } : {})` |
| forwarded into profile resolution | `workflow-registry.js:111-113` — `resolveProfile(config, gateway, workflowEntry, { profile: options.profile, ... })` |
| alias mapped to a real id | `profile-resolver.js` — `const profileId = profiles[selected.value] \|\| selected.value` |

`config.gateways.<name>.profiles` is an alias→id map (`config-loader.js:56`,
validated as an object at `config-loader.js:101`). So a stage that says
`"profile": "gemini"` already resolves through the config to a real profileId,
and one that says `"profile": "<uuid>"` passes the uuid through unchanged.

**No runner change is required for aliases.** What is required is Finding C —
without it the alias map has nowhere to live, which is precisely why today's
manifests hardcode UUIDs instead.

### Finding C — config is anchored to the store root (the real blocker)

`pipeline-runner.js:307`:

```js
const config = loadConfig({ configPath: cliOptions.config, cwd: storeRoot, env });
```

and `config-loader.js:177`:

```js
const configPath = explicitPath
  ? toAbsolutePath(explicitPath, cwd)
  : path.resolve(cwd, 'dispatcher.config.json');
```

The config file is resolved as `<storeRoot>/dispatcher.config.json`, with no
upward search and no home-directory fallback. Three consequences:

1. `webmcp-workflow-store/dispatcher.config.json` does not exist today, so
   `config.gateways.local.profiles` is `{}`, every alias lookup misses, and
   `profiles[x] || x` falls through to the literal. **This is the mechanical
   reason `_cross-site/pipelines/deep-research-3way/pipeline.json` carries three
   raw profileIds** — not a missing feature.
2. Creating that file to fix it would put machine-specific profile UUIDs inside
   a repo that is published to npm and shared across machines — the exact class
   of leak closed by `webmcp-store lint` / `lib/personal-data-scan.mjs`.
3. After the split, `storeRoot` becomes
   `node_modules/@gyga-browser/webmcp-site-store/`, so the config would have to
   live inside `node_modules` — wiped on every `npm install`.

A profile alias map is per-machine state. The store is about to become a
read-only dependency. Config resolution must stop being anchored to it.

## 3. User Journeys

As an automation author, I want to keep a pipeline in a repo that has no `sites/`
directory, so that cross-site automations can version independently of site
knowledge.

As an operator, I want a pipeline that cannot find its site store to say so by
name, so that I debug the dependency instead of hunting a missing workflow file.

As an operator, I want my Chrome profile mapping to live on my machine, so that
pulling the automation repo onto a second machine does not carry the first
machine's profile UUIDs.

As an automation author, I want to write `"profile": "gemini"` and have the
operator decide which real profile that is, so that a manifest is shareable
without being rebound.

## 4. Changes

### 4.1 Explicit store root (`pipeline-runner.js`)

Replace inference-with-fallback by an explicit resolution order, first match
wins:

1. `--store-root <path>` CLI flag
2. `WEBMCP_STORE_ROOT` env var
3. `require.resolve('@gyga-browser/webmcp-site-store/package.json')` → its dirname
4. upward walk for a `sites/` directory (today's behaviour, kept so in-tree
   pipelines and every existing test keep working unchanged)

If all four miss, **throw** a `CliError` with code `STORE_ROOT_NOT_FOUND` naming
the manifest, the attempted strategies, and the fix. Never fall back to the
manifest's own directory.

Keep the upward walk at step 4 — it is what makes this change backward
compatible. The store repo's own `_cross-site/` pipelines resolve today and must
keep resolving with no flag.

Validate the resolved root: it must contain a `sites/` directory. A
`--store-root` pointing somewhere wrong should fail at resolve time with a clear
message, not at the first stage with a missing-workflow error.

### 4.2 Config resolution order (`config-loader.js`, `pipeline-runner.js`)

`loadConfig` gains a search order instead of a single `cwd`-relative path, first
match wins:

1. `--config <path>` (unchanged)
2. `WEBMCP_CONFIG` env var
3. `<cwd>/dispatcher.config.json` — where cwd is the **process** cwd, i.e. the
   automation repo when run from there
4. `~/.webmcp/dispatcher.config.json` — the machine-local home for alias maps
5. defaults (unchanged: empty profiles, no error)

At the call site, `pipeline-runner.js:307` stops passing `cwd: storeRoot`. A
read-only npm dependency is the wrong place to look for per-machine config.

Step 5 must stay non-fatal. A pipeline whose stages carry literal profileIds and
no config keeps working exactly as it does now.

### 4.3 Aliases in pipelines (no code — config + manifest only)

Once 4.2 lands, `~/.webmcp/dispatcher.config.json` becomes the home for:

```json
{ "gateways": { "local": { "profiles": { "gemini": "<uuid>", "chatgpt": "<uuid>" } } } }
```

and `_cross-site/pipelines/deep-research-3way/pipeline.json` changes from three
literal UUIDs to `"profile": "gemini"` / `"profile": "chatgpt"` /
`"profile": "perplexity"`. That clears the three `chrome-profile-id` warnings
currently reported by `webmcp-store lint`, and is the last thing standing
between `_cross-site/` and a clean move.

This is a store-repo change, tracked here only because it is the payoff and it
sequences after 4.2.

## 5. Non-goals

- **No knowledge resolver, no `ContextBundle`.** The tarball already ships
  `sites/` + `catalog.json` + `freshness.json`; npm is the transport.
- **No `dependencies.lock.json`, no sha256 revision scheme.** `package-lock.json`
  already pins versions and integrity.
- **No `capabilities/` folder migration.** The capability contract belongs in
  generated `catalog.json`, where consumers already look; disk layout is the
  store's private business. `workflow-lab-service.js` reads
  `catalog.sites[].workflows[]` and would break for a naming change that buys
  nothing at the contract level.
- **No marketplace, collections, or certification matrix.** One publisher.
  Certifying an automation "against siteStoreRelease 0.5.0" is also premature
  while that release measures `freshnessPct: 0` (0 green / 147 unverified across
  153 assets) — the certificate would be accurate and meaningless.
- **No change to pipeline semantics**: stages, `with` hydration, verify gates,
  risk policy, checkpoints, and resume are untouched.

## 6. Test plan

New tests in `tests/`, alongside the existing pipeline suites:

**Store root resolution**
- `--store-root` wins over env, env wins over `require.resolve`, that wins over
  the upward walk
- a manifest inside the store tree with no flag resolves by upward walk
  (regression: today's behaviour)
- a manifest with no `sites/` above it and no flag/env/dependency throws
  `STORE_ROOT_NOT_FOUND` — **the case that currently fails silently**
- a `--store-root` without a `sites/` directory throws at resolve time, not at
  stage time

**Config resolution**
- `--config` > `WEBMCP_CONFIG` > `<cwd>/dispatcher.config.json` >
  `~/.webmcp/dispatcher.config.json`
- no config anywhere → defaults, no throw (regression)
- config is NOT read from `storeRoot` when cwd differs — the coupling this plan
  removes

**Alias resolution end-to-end** (locks in Finding B so a refactor cannot silently
break it)
- stage `"profile": "gemini"` + config alias map → child receives the mapped uuid
- stage `"profile": "<uuid>"` with an empty profiles map → uuid passes through
- stage with no profile → CLI/env/default resolution, unchanged

Fixtures must use synthetic UUIDs. `webmcp-store lint` scans test files, and the
store's `tests/personal-data-scan.test.mjs` documents why: a positive fixture
written as a literal re-creates the leak the rule exists to stop.

## 7. Sequencing

| # | Change | Repo | Unblocks |
| --- | --- | --- | --- |
| 1 | Explicit store root + throw (4.1) | `webmcp-workflow-cli` | manifests living outside the store |
| 2 | Config search order (4.2) | `webmcp-workflow-cli` | alias map having a machine-local home |
| 3 | `~/.webmcp/dispatcher.config.json` + aliases in `deep-research-3way` (4.3) | store | clears 3 lint warnings; last raw profileId gone |
| 4 | Publish capability contract (`inputs`/`outputs`/`knowledge`) into `catalog.json` | store | automations reference `suno.create-song@1.1.0` instead of a file path |
| 5 | `git mv _cross-site/` → `webmcp-automation-store` + `dependencies` | new repo | the actual split |
| 6 | Rename package → `@gyga-browser/webmcp-site-store` | store | bounded context |

Steps 1–2 are the whole runner cost, and they are small. Step 5 is `git mv` plus
one dependency line **only if** 1–3 land first; without them it is a silent
breakage.

Ship this doc in `package.json` `files` alongside the other pipeline docs, since
it defines the `--store-root` / `WEBMCP_STORE_ROOT` contract that consumers need.

## 8. Risks

**Backward compatibility is the main one.** Both changes are additive: store-root
step 4 preserves the current walk, and config step 5 preserves the current
no-config default. The only behaviour that genuinely changes is the silent
fallback becoming a throw — which can only fire where a run was already going to
fail, just with a worse message.

**`require.resolve` from the runner's own context** may not see the automation
repo's `node_modules` depending on install layout. This is why steps 1–2 of the
resolution order exist: `--store-root` / `WEBMCP_STORE_ROOT` are the reliable
path, and `require.resolve` is a convenience. Test it against a real
`npm install` of the store tarball rather than a workspace symlink, which would
hide the problem.
