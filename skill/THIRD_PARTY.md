# Bundled runtime

The runtime is vendored for reproducible offline use, not fetched from a CDN.
Three.js is pinned at 0.186.1. Only the browser modules and decoders used by
the viewer are included. Original source headers are preserved.

- Three.js: MIT, `assets/vendor/three/LICENSE`.
- Meshoptimizer decoder: MIT, Arseny Kapoulkine; the bundled decoder identifies
  its upstream build as meshoptimizer 1.1, included by Three.js.
- Draco glTF decoder: Apache-2.0, Google; included by Three.js.
- Basis Universal transcoder: Apache-2.0, Binomial; included by Three.js.
- ktx-parse: MIT, Don McCurdy; included by Three.js KTX2Loader.
- zstddec: MIT, Don McCurdy; its embedded Zstandard code also carries the
  upstream BSD notice, retained in `assets/vendor/licenses/zstddec-LICENSE`.

## Adapted check definitions

`scripts/motion-checks.mjs` reimplements, in JavaScript for glTF, the definitions of
`rotation_flips`, `foot_slip` and `limb_extension` from scenario-labs/skills
(`skills/dcc/blender/scenario-blender-animation/scripts/bx_anim.py`), MIT License,
Copyright (c) 2026 Scenario Inc. No Python code is bundled. Contact detection, in-place
(treadmill) classification and baseline comparison are MotionStage additions.

Additional upstream license texts are in `assets/vendor/licenses/`.
No game models, purchased motion packs, online fonts, telemetry or cloud API
clients are required by this package.
