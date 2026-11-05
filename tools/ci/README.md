The single maintained workflow is `.github/workflows/portable-release.yml`.
Pushes and pull requests run the nine OS/Node packaged suites. Manual runs select
`all`, `native`, `blender`, `browser` or `build`; `all` runs all 18 jobs. Windows
native shims, path containment and process-tree checks run with the native suite;
the optional `stress` input adds twenty contention repetitions per Node version.

`artifact_mode=source` builds this checkout. `artifact_mode=frozen` verifies the
exact `release-input/release.json` and `release-input/motion-stage.zip`
without rebuilding or falling back to source. The three source-build jobs always
rebuild source independently. A shared preparation action handles Node/Python and
release verification; each job owns its actual checks and evidence upload.

The browser job uses the previously verified Windows full-Chromium / requested
one-worker software-rendering configuration on two-core runners; Linux uses the
headless shell. Both retain strict network/SHA/WebGL/readiness assertions. See
`browser-smoke.md` for scope and resource limits. Historical one-off probes live
under `tools/diagnostics/` and are not part of routine acceptance.

The native Blender/process fixtures use synthetic assets and an already unpacked release. The browser workflow also checks pinned public real assets. They do
not install Blender globally, authenticate Codex or read a game project.

Use Node 24 and Python 3.12+ on Windows x64 / Linux x64. The official index was
checked on 2026-11-04 ([4.2 index](https://download.blender.org/release/Blender4.2/),
[5.2 index](https://download.blender.org/release/Blender5.2/)): `4.2.0` is available for minimum-version verification and
`5.2.3` is the current 5.2 maintenance release. Both have portable Windows ZIPs,
Linux tar.xz archives and official `.sha256` lists. Downloads are pinned; the
script verifies the exact filename against the live index and verifies SHA-256
before extraction. A missing or changed artifact fails the job.

On Ubuntu runners, ensure Blender's runtime libraries are installed:

```sh
sudo apt-get update
sudo apt-get install -y libgl1 libegl1 libxrender1 libxxf86vm1 libxi6 libxfixes3 libxkbcommon0 libsm6
```

In a GitHub Actions Python step (both operating systems), run:

```sh
python tools/ci/download-blender.py --version 4.2.0 --destination "${RUNNER_TEMP}/blender-portable" --github-env
```

The command appends the resolved binary to `BLENDER_EXECUTABLE` through
`GITHUB_ENV`. In a following step, pass the extracted Skill root and an evidence
directory. Arguments are process argument arrays internally; paths containing
spaces, `&`, `%`, `!`, `^` and Chinese characters are exercised.

```sh
node tools/ci/blender-integration.mjs --skill-root "$EXTRACTED_SKILL_ROOT" --series 4.2 --node-major 24 --output "$EVIDENCE_DIR"
```

Use the workflow shell's variable syntax on Windows, or call both commands from
Python/Node with argument arrays. For a second job change the version to `5.2.3`
and series to `5.2`. `--blender PATH` can replace `BLENDER_EXECUTABLE` when testing
an existing local installation. `--metadata-only --platform windows --arch x64`
checks the official index and checksum without downloading an archive.

The integration verifies every release manifest entry before dynamically
importing its real `convertFbx` API. Blender generates one cube with a one-bone
skin, a one-second animation, a referenced PNG and a different unused PNG. The
same fixture is imported through the API, real `add` CLI, real catalog scan and
`open-model` CLI. Each path must preserve skin/animation, embed the GLB texture,
preserve the source FBX SHA, retain an owned FBX snapshot where applicable and
report exactly the consumed PNG. A fresh Blender process opens each saved
`.blend` and verifies actual packed PNG bytes against the source SHA. An unused
PNG change must leave the authored head and conversion cache unchanged.

Upload the complete evidence directory even on failure. It contains
`blender-integration.json`, stdout/stderr logs, fresh-open image reports and the
small synthetic workspaces, including conversion artifacts. Upload the download
metadata JSON separately; keep large downloaded binaries outside the evidence
directory. A nonzero exit code or `verdict: FAIL` is a failed integration check.

The manual browser matrix additionally fetches pinned public real assets and checks
persons, quadrupeds, a robot, independent rigs, Draco+KTX2 materials and EXT/KHR
Meshopt animation. Sources, licenses and reproduction commands are maintained in
[real-assets/README.md](real-assets/README.md). Sample assets remain outside the
installed Skill and outside ordinary offline unit tests.
