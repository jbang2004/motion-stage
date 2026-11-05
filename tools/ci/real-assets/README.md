# Locked real-asset acceptance

These developer tests are outside the zero-dependency Skill. The sample lock pins
upstream commits, source bytes, licenses and prepared GLB hashes. No public models
or sample textures are bundled into the installed Skill.

- CesiumMan: original animated person, Cesium / CC-BY-4.0.
- Fox: original quadruped with three clips; credits and license text are fetched
  from the upstream Fox directory (PixelMannen, tomkranis, AsoboStudio, scurest).
- RobotExpressive: original robot with multiple skins and morph/rig animations,
  Tomás Laulhé / Don McCurdy, CC0-1.0.
- CarConcept: original Draco geometry and ETC1S/UASTC KTX2 materials; only embedded
  packaging changes, with original compressed payloads retained. See the fetched
  Khronos model license and credits.
- BrainStem: original EXT and KHR Meshopt variants, with no animation re-encoding;
  only self-contained packaging changes. See its upstream license.
- Two Foxes: explicitly derived composition of two independent copies of the
  real Fox rig, retaining original duplicate bone names and animation samples.
  Geometry/images are shared; node/skin/animation references are rebased. This is
  an independence regression case, not a separately sourced production model.

```sh
python tools/ci/real-assets/prepare.py --cache qa/public-asset-cache --output qa/public-assets
node tools/ci/real-assets/check.mjs --skill-root skill --samples qa/public-assets --output qa/public-assets-results
node tools/ci/real-assets/serve.mjs --skill-root skill --samples qa/public-assets --port 57267
```

Open the printed local URL and use **运行全部真实样本**. The page uses the
release's actual SHA-checking intake, shared GLTFLoader decoder factory, resource
preparation, normalization and indexed joint lookup. It checks all original
clips at three times, finite posed vertices, real GPU pixel/color coverage,
compressed textures, full default framing and distinct same-name joint selection.
The backend test also authors two real local-edit candidates, preserves all other
clips/rigs and rejects a bad intake without changing project bytes.

`prepare.py --offline` verifies cached sources without network. Changed or missing
bytes fail; there is no unpinned-source fallback. The maintained remote Chromium
workflow passes `--real-samples` to `browser-smoke.mjs` after preparing and checking
these files. Local macOS browser acceptance uses CUA. Sampled tests do not certify
artistic quality, continuous collision safety or arbitrary exporter extensions.

For native interoperability, `export-fbx.py` derives FBXs from the original person,
Fox and robot GLBs. `native-check.mjs --blender PATH` verifies the 1/3/14 Take
counts, skin weights, robot morph channels, unchanged inputs and saved native
Action availability in fresh Blender processes. These FBXs are clearly labeled
interop derivatives; they are not advertised as separately sourced FBX assets.
The manual native matrix runs this against Blender 4.2 and 5.2 as well.
