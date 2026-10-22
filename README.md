# Project

A tiny live-reloading Lean 4 file viewer. Watches a `.lean` file on disk,
highlights it server-side with [Shiki](https://shiki.style) (using the real
Lean 4 TextMate grammar), and streams the rendered HTML to the browser over
Server-Sent Events — so the page updates automatically whenever the file
changes, with no manual refresh. Hover info is powered by Lean's own
language server (`lake serve`, i.e. `lean --server`) via a minimal LSP
client (`lspClient.js`).

## Running the app

```sh
npm install
npm start
```

This serves the viewer at `http://localhost:8080`, watching
`lean/Test.lean` by default (override with `LEAN_FILE=/path/to/file.lean`).

## Setting up Lean + Mathlib

The `lean/` directory is a [Lake](https://github.com/leanprover/lake)
project with [Mathlib](https://github.com/leanprover-community/mathlib4) as
a dependency, so files edited there can `import Mathlib`.

### 1. Install elan (the Lean toolchain manager)

```sh
curl --proto '=https' --tlsv1.2 -sSf \
  https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh \
  -o elan-init.sh
bash elan-init.sh -y --default-toolchain none
source ~/.elan/env   # add this to your shell profile too
```

This does **not** download a Lean toolchain yet — it's deferred until the
first `lake` command, which reads `lean/lean-toolchain` and fetches exactly
the one version Mathlib needs.

### 2. Fetch dependencies and the prebuilt Mathlib cache

```sh
cd lean
lake update
```

**Do not run plain `lake build` / avoid rebuilding from source.** The key
to keeping disk and CPU usage low is that `lake update` automatically runs
[`cache get`](https://github.com/leanprover-community/mathlib4/blob/master/README.md)
behind the scenes and **downloads precompiled `.olean` files** for Mathlib
and all its dependencies from `cache.mathlib.org` instead of compiling
~1,500 Mathlib files from source. This is the single biggest disk/time
saver — a from-source build would require gigabytes of extra intermediate
build artifacts and tens of minutes of CPU time; downloading the cache is
~400 MB compressed and takes a few minutes.

Only after dependencies are fetched/cached does `lake build Mathlib`
become a no-op that just validates the cache (confirm with `lake build
Mathlib`, which should finish in well under a minute and report
`Build completed successfully` without compiling anything).

### 3. Point the app's LSP client at the Lake project

`lspClient.js` spawns `lake serve` (not bare `lean --server`) with `cwd`
set to the directory containing the watched file. `lake serve` is what
sets up `LEAN_PATH` for Mathlib before execing `lean --server` — using bare
`lean --server` would **not** see Mathlib and `import Mathlib` would fail
to resolve.

### Keeping disk usage down

- **Don't run `lake exe cache get` *and* a full `lake build` from
  source** — the cache download already gives you built `.olean` files;
  building from source on top of that is redundant and much more
  expensive.
- **Pin the Mathlib dependency to a specific commit** once you've found a
  version that works, instead of tracking `master`/`main`, so `lake
  update` doesn't silently refetch a new revision (and its cache) later.
  The exact revisions currently pinned are recorded in
  `lean/lake-manifest.json` (see versions below) — `lake update` only
  re-resolves them if you explicitly ask it to.
- `lean/.lake/` (the dependency checkouts + build cache, several GB) is
  **gitignored** — never commit it. Only `lean/lakefile.toml`,
  `lean/lean-toolchain`, and `lean/lake-manifest.json` are checked in;
  anyone can reproduce the same environment from those three files plus
  `lake update`.
- Avoid `--depth`-unaware shallow-clone tricks with `lake` directly — Lake
  manages its own git checkouts under `.lake/packages/` and doesn't expose
  a shallow-clone flag. The cache download path above is what actually
  avoids the multi-GB cost, not clone depth.

## Versions and disk footprint used in this setup

Measured on the sandbox this was set up in (2026-10-22):

| Component | Version |
|---|---|
| elan | 4.2.4 |
| Lean toolchain | `leanprover/lean4:v4.36.0-rc1` |
| Lake | 5.0.0-src+c9afcdd |
| Mathlib | commit `4530ed722ec48c2187d74c3edb41345b86b93aea` (tracked `master` at setup time) |
| Mathlib cache | 9,064 files downloaded from `cache.mathlib.org` |

Transitive dependencies pinned (see `lean/lake-manifest.json` for exact
revisions): `batteries`, `aesop`, `Qq`, `proofwidgets`, `importGraph`,
`LeanSearchClient`, `plausible`, `Cli`.

Disk usage:

| Stage | `/` usage |
|---|---|
| Before install | ~24 MB |
| After `lake update` (deps cloned + Mathlib cache downloaded) | ~11 GB |
| After `lake build Mathlib` (cache-validated, no source build) | ~11 GB (unchanged) |

`lean/.lake/packages/` alone accounts for ~7.3 GB of that (dependency
source checkouts + their prebuilt `.olean` caches). This was run on a 25 GB
sandbox disk, leaving ~15 GB free headroom.

Note: because `lean --server` has to load all of Mathlib's `.olean` files
on first open, the *first* hover/elaboration of a file with `import
Mathlib` is slow in this sandbox (several minutes) even though cache
download and build were fast — this is one-time per server process, not a
disk space issue.
