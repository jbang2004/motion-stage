"""Convert user-owned FBX in an isolated Blender process; never retarget silently."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import struct
import traceback

import bpy


def absolute_path(path):
    """Normalize .. lexically without resolving a short directory junction."""
    return Path(os.path.abspath(path))


def registered_operator(ops, module, name):
    """bpy.ops exposes proxies for missing operators; hasattr is not a probe."""
    try:
        operator = getattr(getattr(ops, module), name)
        operator.get_rna_type()
        return operator
    except (AttributeError, KeyError, RuntimeError):
        return None


def import_fbx(ops, source):
    importer = 'wm.fbx_import'
    operator = registered_operator(ops, 'wm', 'fbx_import')
    if operator is None:
        importer = 'import_scene.fbx'
        operator = registered_operator(ops, 'import_scene', 'fbx')
    if operator is None:
        raise ValueError('此 Blender 未启用 FBX 导入器。请启用随 Blender 提供的 FBX 扩展，或导出自包含 GLB。')
    result = operator(filepath=str(source), use_anim=True)
    if 'FINISHED' not in result:
        raise ValueError('Blender 的 FBX 导入没有完成。请检查文件格式与导入器日志。')
    return importer


def pack_external_image(image, image_path):
    """Bind packed bytes and their reported hash to one stable file snapshot."""
    before = image_path.stat()
    data = image_path.read_bytes()
    after = image_path.stat()
    identity = lambda s: (s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_ino)
    if identity(before) != identity(after) or len(data) != before.st_size:
        raise ValueError('读取期间贴图发生变化，请重新导入。')
    digest = hashlib.sha256(data).hexdigest()
    # pack() without explicit data can use an already loaded old Image buffer.
    image.pack(data=data, data_len=len(data))
    image.reload()
    if not image.packed_file or hashlib.sha256(bytes(image.packed_file.data)).hexdigest() != digest:
        raise ValueError('无法将贴图快照完整打包到模型。')
    # reload() invalidates Blender's decoded buffer; decoding is lazy. Access a
    # pixel before checking has_data, rather than rejecting a valid packed file.
    if not len(image.pixels):
        raise ValueError('无法解码已打包的贴图快照。')
    _ = image.pixels[0]
    if not image.has_data:
        raise ValueError('无法解码已打包的贴图快照。')
    return {'path': str(image_path), 'sha256': digest}



def imported_action_bindings(scene, actions):
    """Use native bindings/slot owner IDs; never guess an owner from bone names."""
    owners = list(scene.objects)
    owners += [obj.data.shape_keys for obj in scene.objects
               if obj.type == 'MESH' and obj.data.shape_keys]
    owners = list(dict.fromkeys(owners))
    known = {}
    for owner in owners:
        data = owner.animation_data
        if not data:
            continue
        if data.action:
            known.setdefault((data.action, getattr(data, 'action_slot', None)), set()).add(owner)
        for track in data.nla_tracks:
            for strip in track.strips:
                if strip.action:
                    known.setdefault((strip.action, getattr(strip, 'action_slot', None)), set()).add(owner)
    bindings = []
    for action in actions:
        slots = list(getattr(action, 'slots', [])) or [None]
        for slot in slots:
            targets = known.get((action, slot))
            if not targets:
                if slot is not None:
                    matches = [o for o in owners if o.name == slot.name_display
                               and o.bl_rna.identifier.upper() == slot.target_id_type]
                else:
                    matches = [o for o in owners if action.name.startswith(o.name + '|')]
                if len(matches) != 1:
                    raise ValueError('FBX 动作无法唯一确定目标：' + action.name + '。请按角色单独导出，原文件已保留。')
                targets = matches
            prefixes = [o.name + '|' for o in owners if action.name.startswith(o.name + '|')]
            prefix = max(prefixes, key=len) if prefixes else ''
            take = action.name[len(prefix):] if prefix else action.name
            for owner in sorted(targets, key=lambda o: o.name):
                bindings.append({'owner': owner, 'action': action, 'slot': slot,
                                 'take': take, 'original': action.name,
                                 'range': [float(v) for v in action.frame_range]})
    return bindings


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--owned-input')
    parser.add_argument('--output', required=True)
    parser.add_argument('--owned-output')
    parser.add_argument('--path-map', default='[]')
    parser.add_argument('--fps', type=int, default=0)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
    source = absolute_path(args.input)
    owned_source = absolute_path(args.owned_input) if args.owned_input else source
    # Keep the short Windows junction spelling for native Blender file APIs.
    # resolve() would expand it back to the unsupported long output path.
    out = absolute_path(args.output)
    owned_out = absolute_path(args.owned_output) if args.owned_output else out
    mappings = json.loads(args.path_map)

    def native_path(path):
        path = absolute_path(path)
        for mapping in mappings:
            try:
                suffix = path.relative_to(Path(mapping['owned']))
            except ValueError:
                continue
            return Path(mapping['native']) / suffix
        if source != owned_source:
            for mapping in mappings:
                try:
                    path.relative_to(Path(mapping['native']))
                    return path
                except ValueError:
                    continue
            # An escaped ../ path outside every junction cannot be safely
            # rebased to the original FBX tree. Fail rather than consume an
            # unrelated file adjacent to the temporary alias container.
            raise ValueError('长路径贴图引用超出已映射的来源目录，无法确认原始路径；请使用较短项目路径或嵌入贴图后重试。')
        return path

    def owned_path(path):
        path = absolute_path(path)
        for mapping in mappings:
            try:
                suffix = path.relative_to(Path(mapping['native']))
            except ValueError:
                continue
            return Path(mapping['owned']) / suffix
        return path
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if bpy.app.version < (4, 2, 0):
        raise ValueError('FBX 导入需要 Blender 4.2 或更高版本。')
    importer = import_fbx(bpy.ops, source)
    scene = bpy.context.scene
    imported_fps = scene.render.fps / scene.render.fps_base
    if args.fps:
        scene.render.fps = args.fps
        scene.render.fps_base = 1
    effective_fps = scene.render.fps / scene.render.fps_base
    rigs = [obj for obj in scene.objects if obj.type == 'ARMATURE']
    helpers = {bone.custom_shape for rig in rigs for bone in rig.pose.bones if bone.custom_shape}
    meshes = [obj for obj in scene.objects if obj.type == 'MESH' and obj not in helpers]
    export_objects = set(meshes + rigs)
    for obj in meshes + rigs:
        parent = obj.parent
        while parent:
            export_objects.add(parent)
            parent = parent.parent
    if not meshes and not rigs:
        raise ValueError('这个 FBX 没有可预览的网格或骨架。原文件保持，请检查导出选择。')
    for rig in rigs:
        for bone in rig.data.bones:
            bone['motionStudioJoint'] = True
    missing_images = []
    external_images = []
    for image in bpy.data.images:
        if image.type == 'IMAGE' and not image.packed_file:
            if not image.filepath:
                if image.has_data:
                    image.pack()
                else:
                    missing_images.append(image.name)
                continue
            image_path = native_path(bpy.path.abspath(image.filepath))
            image.filepath_raw = str(image_path)
            if image_path.is_file():
                try:
                    consumed = pack_external_image(image, image_path)
                    # Keep packed pixels intact while removing the temporary
                    # access spelling from the saved native file's metadata.
                    image.filepath_raw = str(owned_path(image_path))
                    consumed['path'] = image.filepath_raw
                    external_images.append(consumed)
                except (RuntimeError, ValueError, OSError):
                    missing_images.append(image.name)
            else:
                missing_images.append(image.name)
    if missing_images:
        raise ValueError('FBX 缺少贴图：' + '、'.join(missing_images[:6]) + '。请重新下载带贴图的 With Skin FBX，或在源文件中嵌入贴图。')
    bindings = imported_action_bindings(scene, list(bpy.data.actions))
    actions = list(dict.fromkeys(b['action'] for b in bindings))
    groups = {}
    for binding in bindings:
        groups.setdefault(binding['take'], []).append(binding)
    start = min((b['range'][0] for b in bindings), default=0.0)
    end = max((b['range'][1] for b in bindings), default=0.0)
    scene.frame_start = math.floor(start)
    scene.frame_end = max(scene.frame_start, math.ceil(end))
    scene.frame_set(scene.frame_start)
    for action in actions:
        action.use_fake_user = True
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=str(out / 'editable.blend'), relative_remap=False)
    source_actions = []
    for owner in dict.fromkeys(b['owner'] for b in bindings):
        data = owner.animation_data_create()
        data.action = None
        for old in list(data.nla_tracks):
            data.nla_tracks.remove(old)
    for index, (take, members) in enumerate(groups.items()):
        clip_name = ('Walking' if 'walk' in source.stem.lower() else 'Motion') if len(groups) == 1 else take
        clip_start = min(b['range'][0] for b in members)
        for binding in members:
            owner, action, slot = binding['owner'], binding['action'], binding['slot']
            data = owner.animation_data_create()
            track = data.nla_tracks.new()
            track.name = clip_name
            strip = track.strips.new(clip_name, 0, action)
            if slot is not None:
                strip.action_slot = slot
            offset = binding['range'][0] - clip_start
            strip.frame_start = offset
            strip.frame_end = offset + max(binding['range'][1] - binding['range'][0], 1.0)
            source_actions.append({
                'clip': clip_name, 'originalActionName': binding['original'],
                'target': owner.name, 'sourceFrameRange': binding['range'],
                'sourceFPS': effective_fps,
                'timeMapping': {'kind': 'linear', 'viewerStartSeconds': 0,
                                'sourceStartFrame': clip_start,
                                'sourceFramesPerSecond': effective_fps},
            })
    scene.frame_start = 0
    scene.frame_end = max(0, math.ceil(end - start))
    scene.frame_set(0)
    for obj in scene.objects:
        obj.select_set(obj in export_objects)
    bpy.context.view_layer.objects.active = rigs[0] if rigs else meshes[0]
    options = {
        'filepath': str(out / 'converted.glb'),
        'export_format': 'GLB',
        'export_extras': True,
        'use_selection': True,
        'export_animations': bool(actions),
        'export_animation_mode': 'NLA_TRACKS',
        'export_force_sampling': True,
        'export_optimize_animation_size': False,
    }
    bpy.ops.export_scene.gltf(**options)
    with (out / 'converted.glb').open('rb') as preview:
        header = preview.read(20)
        document = json.loads(preview.read(struct.unpack_from('<I', header, 12)[0]))
    exported = {a.get('name') for a in document.get('animations', [])}
    missing = {a['clip'] for a in source_actions} - exported
    if missing:
        raise ValueError('FBX 动作未完整导出：' + '、'.join(sorted(missing)) + '。未替换当前版本。')
    report = {
        'version': 1,
        'source': {
            'kind': 'fbx',
            'path': str(owned_source),
            'sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
            'fps': effective_fps,
            'importedFPS': imported_fps,
            'fpsOverridden': bool(args.fps),
            'frameRange': [start, end],
            'upstreamFrameRateVerified': False,
            'fpsNote': '默认采用 Blender 从 FBX 读取的帧率。手动覆盖仅用于确认下载设置后的修正。',
            'actions': source_actions,
            'editablePath': str(owned_out / 'editable.blend'),
            'axes': {'viewer': 'Y-up meters', 'blender': 'Z-up scene units'},
        },
        'blenderVersion': bpy.app.version_string,
        'importer': importer,
        'externalImages': external_images,
        'meshes': len(meshes),
        'bones': sum(len(r.data.bones) for r in rigs),
        'limitations': ['本次只转换当前 FBX 的角色和动作，不做跨骨架重定向。', 'Blender 约束、游戏实时衣料和引擎效果不能由普通 GLB 预览证明正确。'],
    }
    (out / 'source-map.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        output = Path(sys.argv[sys.argv.index('--output') + 1]) if '--output' in sys.argv else None
        if output and output.is_dir():
            (output / 'error.json').write_text(json.dumps({'error': str(exc), 'type': type(exc).__name__}, ensure_ascii=False), encoding='utf-8')
        traceback.print_exc()
        raise
