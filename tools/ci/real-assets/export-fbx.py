"""Interop fixtures derived from pinned real GLBs; source files stay unchanged."""
import sys
from pathlib import Path
import bpy
samples=Path(sys.argv[sys.argv.index('--')+1]);output=Path(sys.argv[sys.argv.index('--')+2]);output.mkdir(parents=True,exist_ok=True)
for name in ['human','fox','robot']:
 bpy.ops.wm.read_factory_settings(use_empty=True)
 bpy.ops.import_scene.gltf(filepath=str(samples/(name+'.glb')))
 bpy.ops.object.select_all(action='SELECT')
 bpy.ops.export_scene.fbx(filepath=str(output/(name+'.fbx')),use_selection=True,object_types={'MESH','ARMATURE'},add_leaf_bones=False,bake_anim=True,bake_anim_use_nla_strips=False,bake_anim_use_all_actions=True,bake_anim_simplify_factor=0,path_mode='COPY',embed_textures=True)
