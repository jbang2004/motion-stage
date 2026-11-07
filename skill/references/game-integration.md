# Game integration · from an accepted preview to the game

Read this when the user asks to put an accepted edit or an adopted action into the game (接入游戏, 放进游戏, 用这版替换游戏里的, 把收录的动作加到游戏).

Three facts stay separate: a candidate exists, the user accepted it (满意，保留这版) or adopted an action (加入常用动作), and the game uses it. The studio records the first two and never writes game files. It also never wakes the chat: the page tells the user to come back and ask. The third fact happens only when the user asks you. You change the game files, check the result in the game and record what you changed with `integrate`.

## Find what is waiting

```sh
CLI="$SKILL_DIR/scripts/motion-feedback.mjs"
node "$CLI" integrations --workspace "$WORKSPACE"     # MCP motion_integration_status
```

Two lists come back, each row with a `status` and a Chinese `hint` for the next step:

- `candidates`: one row per task whose candidate the user kept. It gives `checkpointId`, the candidate GLB path and SHA, `game.modelFile` (the project file the model was opened from), `game.format`, `game.file.state`, `game.composite` and `game.clipOwner`. It also gives `references`, the linked code and authoring sources from the task's frozen context, plus `projectContextFile`.
- `actions`: one row per adopted character action. It gives `actionId`, `name`, `clip`, `motion.sourceFile` (the project file the action came from), `game.modelFile` and `modelChanged`.

| `status` | Meaning |
|---|---|
| `pending` | Accepted or adopted, no integration recorded |
| `integrated` | An integration is recorded; redo it only if the user asks |
| `superseded` | A newer accepted edit built on this candidate, or a newer adoption with the same name, replaces it: integrate that one instead |
| `withdrawn` | The user's latest decision on that task is no longer acceptance. Do not integrate it; `integrate` refuses |

Integrate only what the user asked for. If several rows are pending and the request is ambiguous, ask which. A non-empty `otherBranches` means another accepted version of the same model sits on a different edit chain, so neither contains the other's changes. Ask which one goes in; never merge them by guessing. A non-zero `activeJobs` means the model still has an open task. Changing its game file now makes that task go stale, so ask first.

## Put an accepted edit in

The candidate is a self-contained GLB that keeps the source's clip names. What to do depends on the game file:

| `game` | Do |
|---|---|
| `file.state: original`, GLB, not composite | Copy the candidate GLB over `modelFile` |
| `file.state: candidate` | The game already has these bytes; check in the game, then record |
| `file.state: changed` | The game file changed after the studio imported it. Do not overwrite blindly: compare, ask, or replay the edit on the current file |
| `file.state: missing`, or no `modelFile` | Ask the user where the game loads this model |
| `format` is FBX or glTF | A GLB cannot replace it. Replay the edit in the authoring source and export through the project's pipeline |
| `composite: true` | The clip belongs to `clipOwner`. Change that source; never replace the base model with the composite review GLB |

If `references` lists a linked authoring source (`kind: source`, `confidence: linked`, e.g. a `.blend`), that source does not contain the GLB edit. Replacing only the exported file means the next export from the source loses the edit. Replay it in the source; `artifacts --job ID` lists the job's scripts and recipe. If you can't, tell the user the source is now behind the game file. Change game code (clip names, loader paths) only as far as the integration needs.

## Put an adopted action in

Adoption pins a recipe in `motion-library.json`; the character's own file is unchanged. There are two ways in:

1. **Export.** Write the character GLB with the action merged in, then replace `game.modelFile` with it:
   ```sh
   node "$CLI" export-action --workspace "$WORKSPACE" --action "$ACTION_ID" --out "/absolute/path/hero.glb" [--replace]
   ```
   MCP: `motion_export_action` with an absolute `outputPath`. The export refuses to overwrite an existing file without `--replace` / `replace: true`. The merged clip is named `clip`, and an embedded clip with the same name is replaced.
2. **Load from the source file.** If the game's loader already plays clips from separate files and `motion.sourceFile` is a project file, register the clip there. When `motion.mappingId` is set, the bones match by an explicit name mapping that the game would have to apply too, so prefer the export.

`modelChanged: true` means the character model moved after adoption. The export refuses; the user previews and adopts the action again on the current model.

## Check in the game

Run the game when you can. Watch the entry and transitions, root travel, equipment, cloth and effects. The studio cannot check runtime IK, cloth, state-machine blending or shaders. If you could not run the game, say so and leave out `--game-check`. A game that was not run does not count as checked.

## Record it

```sh
node "$CLI" integrate --workspace "$WORKSPACE" --checkpoint "$CHECKPOINT_ID" --file models/hero.glb [--file src/hero.js] --summary "用候选替换 models/hero.glb" [--game-check "游戏里跑步一圈，左臂摆幅收小"]
node "$CLI" integrate --workspace "$WORKSPACE" --action "$ACTION_ID" --file models/hero.glb --summary "导出合好跑步的角色 GLB 替换 models/hero.glb"
```

MCP: `motion_record_integration` (`checkpointId` or `actionId`, `files`, `summary`, optional `gameCheck`). Paths are relative to the linked project root, or absolute inside it. Each file is hashed now and marked `matches: candidate`, `export`, `original` or `null`. Recording refuses when:

- no game project is linked;
- a file is missing or outside the project;
- every listed file is still the imported original;
- the checkpoint was withdrawn.

It writes `integrations/<id>.json`; for a candidate it also appends to `job.integrations`, and the 修改 result card shows 已接入游戏. It changes no game file. It is not approval, and the user's checkpoint stays as they accepted it.

## After integrating

The model's game file now differs from what the studio imported, which the studio treats as a source change: an open task on the old version goes stale, and accepting a candidate built on it is refused. To keep editing from the integrated version, the user loads the new source (载入源文件新版本, or `open-model --asset-id ID --refresh-source`), which makes the integrated file the new original.

Report the files you changed, how they were produced (copied candidate, export, replayed in source), what you checked in the game, and anything left: a source that is now behind, an unrun game, other pending rows.
