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

Additional upstream license texts are in `assets/vendor/licenses/`.
No game models, purchased motion packs, online fonts, telemetry or cloud API
clients are required by this package.
