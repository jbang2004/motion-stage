# Remote browser smoke

This development harness runs only on authorized Linux/Windows CI runners. It
rejects macOS browser execution; local browser work still uses CUA. It imports the
server and fixture generators from an **extracted release**, verifies that release's
manifest, and never adds a dependency to the Skill.

Install official Playwright into a separate temporary prefix. Install its matching
Chromium build, as required by the [Playwright browser documentation](https://playwright.dev/docs/browsers).
For a GitHub Actions step using Bash on either runner:

```bash
PW_ROOT="$RUNNER_TEMP/motion-browser-playwright"
npm install --prefix "$PW_ROOT" --no-audit --no-fund playwright@1.64.1

# Linux: Chromium plus its runner OS dependencies.
node "$PW_ROOT/node_modules/playwright/cli.js" install --with-deps chromium

# Windows: use `install chromium` instead; no Linux OS packages are required.
node tools/ci/browser-smoke.mjs \
  --package "$EXTRACTED_SKILL" \
  --playwright-root "$PW_ROOT" \
  --output "$RUNNER_TEMP/browser-smoke-artifacts" \
  --software-webgl
```

`EXTRACTED_SKILL` is the absolute path to the extracted `motion-stage`
folder. `CI=true` or `GITHUB_ACTIONS=true` is required. Record or pin the resolved
Playwright version in the workflow; the result JSON also records the actual
Playwright and Chromium versions. PowerShell can run the same `node` and `npm`
commands with `$env:RUNNER_TEMP` paths. No `npx` command resolution or executable
shell wrapper is needed by the harness.

`--software-webgl` explicitly requests Chromium ANGLE/SwiftShader. This is a real
WebGL2 context in a real Chromium process on the host OS, using software rendering;
it is not evidence of a hardware GPU. Omit the option to test the runner's default
graphics configuration. The harness records the renderer/vendor/context version
and reads actual canvas pixels. Failure to create WebGL2 fails the smoke test.

The fixture is a private temporary directory whose name contains Chinese, spaces,
`&`, and `%`. Sword/Bow/static GLBs are clearly marked derivatives of the packaged
original teaching mannequin; the fourth GLB is deliberately corrupt. All mutations
are made through the real UI: directory search and open, A/B request and preserve
draft restoration, static controls, and a 70% LeftShoulder local candidate with
split comparison. Read-only state checks verify model identities, job audit,
source hashes, elapsed-time/camera alignment, and WebGL pixels. There are no API
responses, WebGL implementations, or application functions mocked by the browser
harness. Playwright `evaluate` reads state; it does not perform UI mutations.

This variant performs a zero-interception ablation. It installs no Playwright
routes and never enables the CDP Fetch domain. Playwright 1.64.1 otherwise enables
a wildcard Chromium Fetch pattern even for exact `page.route` strings
([Chromium network implementation](https://github.com/microsoft/playwright/blob/v1.64.1/packages/playwright-core/src/server/chromium/crNetworkManager.ts#L151)).
External and Agent requests are observed and strictly fail the check without
interception. These synthetic fixtures contain no user data; Codex and Blender
executables are explicitly set to missing fixture paths. The server uses isolated project
settings, and synthetic local jobs only. It closes Chromium/server and removes
the fixture on success or failure. `--keep-fixture` retains the synthetic fixture
for runner debugging.

Always upload the output folder, including on failure:

- `browser-smoke-result.json` records every check, package hashes, graphics,
  fixture identities, console/errors, and the final PASS/FAIL.
- `browser-smoke-progress.json` is atomically replaced when each check and key
  browser operation starts or finishes; the same phases are printed immediately
  to the job log. It identifies a running search, state read, pixel read,
  screenshot, trace save or cleanup without waiting for the final result.
  Browser evaluations have a 30 second outer bound; diagnostics have 8 seconds,
  trace saving 20 seconds and browser closing 10 seconds. Each check has a five
  minute outer bound and the whole harness has a twelve minute watchdog that
  saves `browser-smoke-watchdog.json` before forcing a failing exit. These outer
  bounds cannot turn a functional timeout into a pass or replace its error.
- `browser-console.json` records page errors, console messages, HTTP failures,
  failed requests, blocked requests, individual resource requests, and the actual
  UI catalog-open selection epochs. A GET session/studio request is attributed
  only when its `assetId` matches the selected model when it starts. A GLB request
  is attributed only when its asset-bearing referrer matches that model. Only
  exact Chromium `net::ERR_ABORTED`/`net::ERR_CANCELED` errors from an already
  superseded selection epoch are labelled expected. A later selection cannot
  retroactively excuse an earlier failure. Current-selection GLB failures remain
  failures, including during teardown. Explicit browser cleanup may cancel a
  matching current session/studio poll. Unknown ownership, other transport
  errors, blocked requests, HTTP errors, and console/page errors fail the check.
- Raw Chromium CDP GLB request, byte-receipt, completion and failure events are
  retained with selection identity. The diagnostic session enables only Network
  observation, with no Fetch interception patterns. `externalRequests` and
  `agentRequests` are recorded and must both remain empty. Current-selection GLB
  failures, console errors, and HTTP errors remain strict failures.
- Readiness uses the same full identity/state predicate with independent 100 ms
  timer polling, rather than animation frames. Initial navigation uses `commit`
  and one shared 90 second deadline starting before navigation, including the
  strict parsed-document/initialized/identity/loaded-geometry wait. Subsequent
  model selections retain 45 seconds. These are CI budgets, not product speed
  promises; a never-ready page still fails. The 90 second initial allowance is
  based on the observed Windows cold-start trace taking about 73 seconds before
  its successful local module/model/studio chain completed. Each wait records
  identity, budget, duration and result. DOM search and candidate waits use the
  same timer polling to avoid tying assertions to slow software-rendered frames.
- HTTP responses with status >=400 retain `response.text()` (up to 64 KiB), or
  the exact bounded body-read error. Readiness failures also save
  `failure-diagnostics.json`: a read-only UI/exposed-state summary and a read-only
  snapshot of workspace metadata, lock owner and individual ticket files. Reads
  use `Promise.allSettled` and bounded timeouts; diagnostic failures do not replace
  the original failure. These records do not infer why a lock or request failed.
- PNG screenshots cover the loaded WebGL preview, directory, search, both drafts,
  static controls, and local comparison. A failure also saves `failure.png` and
  `failure.html` when possible.
- `trace.zip` retains DOM snapshots, resources and source context. Windows uses
  a 1280 × 720 desktop viewport and disables the trace screencast to reduce
  continuous software GPU capture overhead; explicit PNG screenshots, pixel
  checks, SHA and all functional/network assertions remain enabled. Linux keeps
  1440 × 1000 and trace screenshots. Both configurations and operation durations
  are recorded in the report. Cleanup timeouts fail the run; residual transport
  handles cannot hold the CLI open after its final evidence has been saved.

Development Mac checks cover syntax, the local browser launch guard, and the pure
request-ownership classifier (`node --test tools/ci/browser-smoke.network.test.mjs`).
Browser execution belongs on the authorized CI runners. Treat a runner failure as
evidence to inspect, not as a reason to weaken the assertions.

For Windows resource diagnosis, `--browser-channel chromium` uses Playwright's
[full Chromium new headless mode](https://playwright.dev/docs/browsers#chromium-new-headless-mode)
instead of its separate headless shell. The browser job in the single
`portable-release.yml` workflow requests one worker on Windows, leaving CPU
capacity for the local server and browser UI on a two-core runner. An explicit
worker selection writes exclusive, temporary `SwiftShader.ini` files
to the runner working directory and downloaded browser directory, following the
[upstream runtime configuration](https://swiftshader.googlesource.com/SwiftShader/+/refs/heads/master/docs/RuntimeConfiguration.md).
It records the requested configuration without claiming the browser consumed it;
cleanup removes only byte-identical files created by this test. The release ZIP,
UI assertions, transport observation and all timeout budgets stay unchanged.

`resources` in the final JSON retains monotonic Node timer lag, actual Node CPU
and system CPU/memory samples, plus passive browser process CPU samples. Browser
sampling has one raw CDP command in flight, a bounded observation deadline and
no CPU threshold assertions. These samples support diagnosis; their errors are
recorded separately and cannot turn a functional failure into a pass.
