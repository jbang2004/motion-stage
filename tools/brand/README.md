# MotionStage app icon

**Concept · 洋葱皮人偶 (onion-skin mannequin).** A faceless artist's mannequin leaps toward a stage. Two glass "onion-skin" ghosts of its earlier frames trail behind it, shifting from blue-violet to magenta as time moves forward. The stage is a slim disc with a warm orange rim, under a soft top light. The mannequin stands for character animation. The ghosts are how animators read motion frame by frame. The stage is the 台 in 动作台.

The icon has two masters.

**Vector (ships in the app).** `vector-icon.mjs` draws the icon from a skeleton.

- Every limb is a tapered capsule between two joints, with cylinder shading lit from the upper right.
- Joints are spheres with faint seams.
- The ghosts are the same rig at 64% and 49% scale, drawn as glass with group opacity.
- To re-pose the figure, edit `POSE`. To recolour it, edit the gradients.

```sh
node tools/brand/vector-icon.mjs   # writes skill/assets/viewer/app-icon.svg and favicon.svg
```

- `app-icon.svg` (about 30 KB): full detail with glows, used at 30 px and up in the header, the 版本与来源 dialog and the READMEs.
- `favicon.svg`: the same drawing without blur filters and with a bolder stage rim, for the browser tab.

**Rendered (marketing).** `motionstage-icon-source.png` is the Codex image render that the vector was redrawn from. `provenance.json` records its three-step generation chain and prompts. `export-icon.mjs` masks it to the squircle with transparent corners and writes `dist/brand/motionstage-icon-{1024,512,256}.png` for store pages, social previews and slides.

```sh
PLAYWRIGHT_DIR=/path/containing/node_modules/playwright-core node tools/brand/export-icon.mjs
```

Keep the two masters in step. If the render is replaced, re-measure `POSE` from it so the vector matches.
