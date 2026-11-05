"""Generate an independent rigged cube, one-second motion and two distinct PNGs.

Only surface.png is used by the material. unused.png is a deliberate cache and
dependency negative control. No project, account or user model is read.
"""
import hashlib
import json
from pathlib import Path
import sys
import bpy

output = Path(sys.argv[sys.argv.index('--') + 1]).resolve()
output.mkdir(parents=True, exist_ok=False)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 30
scene.render.fps_base = 1
scene.frame_start, scene.frame_end = 1, 31
bpy.ops.object.armature_add()
rig = bpy.context.object
rig.name = 'PortableSyntheticRig'
bone = rig.pose.bones[0]
bone.name = 'PortableBone'
bone.rotation_mode = 'XYZ'
for frame, angle in [(1, 0), (16, .4), (31, 0)]:
    bone.rotation_euler[1] = angle
    bone.keyframe_insert(data_path='rotation_euler', frame=frame)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, .5))
mesh = bpy.context.object
mesh.name = 'PortableSyntheticMesh'
mesh.vertex_groups.new(name=bone.name).add(list(range(len(mesh.data.vertices))), 1, 'REPLACE')
mesh.parent = rig
modifier = mesh.modifiers.new(name='PortableArmature', type='ARMATURE')
modifier.object = rig


def png(name, first, second):
    image = bpy.data.images.new(name, width=4, height=4)
    image.pixels = [component for index in range(16) for component in (first if index % 2 else second)]
    image.filepath_raw = str(output / name)
    image.file_format = 'PNG'
    image.save()
    return image


surface = png('surface.png', (.8, .3, .2, 1), (.1, .6, .9, 1))
unused = png('unused.png', (.2, .9, .1, 1), (.7, .1, .8, 1))
material = bpy.data.materials.new('PortableSyntheticMaterial')
material.use_nodes = True
texture = material.node_tree.nodes.new('ShaderNodeTexImage')
texture.image = surface
material.node_tree.links.new(texture.outputs['Color'], material.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
mesh.data.materials.append(material)
scene.frame_set(1)
bpy.ops.object.select_all(action='SELECT')
source = output / 'source & 100% !^ 角色.fbx'
bpy.ops.export_scene.fbx(filepath=str(source), use_selection=True, object_types={'MESH', 'ARMATURE'},
                         add_leaf_bones=False, bake_anim=True, bake_anim_use_nla_strips=False,
                         bake_anim_use_all_actions=False, bake_anim_simplify_factor=0,
                         path_mode='RELATIVE', embed_textures=False)
bpy.ops.object.select_all(action='DESELECT')
rig.select_set(True)
skeleton = output / 'standalone-skeleton.fbx'
bpy.ops.export_scene.fbx(filepath=str(skeleton), use_selection=True, object_types={'ARMATURE'},
                         add_leaf_bones=False, bake_anim=True, bake_anim_use_nla_strips=False,
                         bake_anim_use_all_actions=False, bake_anim_simplify_factor=0)
report = {'generator': bpy.app.version_string, 'source': source.name, 'skeletonSource': skeleton.name, 'frames': [1, 31],
          'fps': 30, 'durationSeconds': 1, 'skinnedVertices': len(mesh.data.vertices),
          'files': {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                    for path in [source, skeleton, output / 'surface.png', output / 'unused.png']}}
(output / 'fixture.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report))
