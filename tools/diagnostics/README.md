# Historical diagnostics

The native-fetch / Three.FileLoader comparison isolated a real protocol issue
during the 2.4.2 audit. It is retained here for reproducing that investigation,
outside the normal release workflow and outside the Skill bundle. Its legacy
FileLoader control may fail by design; it is not a release acceptance test.

`browser-network-probe.mjs --help` describes the authorized Windows/Linux CI
requirements and arguments. `network-probe.yml` is an inactive historical recipe;
only copy it into `.github/workflows/` for an explicitly requested investigation.
The original runs and conclusions remain in `qa/native-platform-20261104/`.
