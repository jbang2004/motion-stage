"""Test importer capabilities and native action ownership without requiring Blender."""
import importlib.util
from pathlib import Path
import sys
import types
import unittest
import tempfile
import hashlib

sys.modules['bpy'] = types.SimpleNamespace()
source = Path(__file__).resolve().parents[1] / 'blender' / 'convert_fbx.py'
spec = importlib.util.spec_from_file_location('motion_blender_converter', source)
converter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(converter)


class FakeOperator:
    def __init__(self, owner, name):
        self.owner = owner
        self.name = name

    def get_rna_type(self):
        if self.name not in self.owner.registered:
            raise KeyError(self.name)
        return object()

    def __call__(self, **kwargs):
        self.owner.calls.append((self.name, kwargs))
        return self.owner.result


class FakeModule:
    def __init__(self, owner, module):
        self.owner = owner
        self.module = module

    def __getattr__(self, name):
        # Matches Blender: even missing operators have an attribute proxy.
        return FakeOperator(self.owner, self.module + '.' + name)


class FakeOps:
    def __init__(self, registered, result=None):
        self.registered = registered
        self.calls = []
        self.result = result if result is not None else {'FINISHED'}

    def __getattr__(self, module):
        return FakeModule(self, module)


class ImportCapabilities(unittest.TestCase):
    def test_legacy_importer_is_reached_despite_virtual_native_proxy(self):
        ops = FakeOps({'import_scene.fbx'})
        self.assertTrue(hasattr(ops.wm, 'fbx_import'))
        self.assertEqual(converter.import_fbx(ops, Path('source.fbx')), 'import_scene.fbx')
        self.assertEqual(ops.calls, [('import_scene.fbx', {'filepath': 'source.fbx', 'use_anim': True})])

    def test_modern_registered_importer_is_preferred(self):
        ops = FakeOps({'import_scene.fbx', 'wm.fbx_import'})
        self.assertEqual(converter.import_fbx(ops, Path('source.fbx')), 'wm.fbx_import')
        self.assertEqual(ops.calls[0][0], 'wm.fbx_import')

    def test_missing_importer_is_an_actionable_failure(self):
        ops = FakeOps(set())
        with self.assertRaisesRegex(ValueError, '未启用 FBX 导入器'):
            converter.import_fbx(ops, Path('source.fbx'))
        self.assertEqual(ops.calls, [])

    def test_cancelled_import_does_not_fall_back_into_a_second_partial_import(self):
        ops = FakeOps({'import_scene.fbx', 'wm.fbx_import'}, {'CANCELLED'})
        with self.assertRaisesRegex(ValueError, '没有完成'):
            converter.import_fbx(ops, Path('source.fbx'))
        self.assertEqual(len(ops.calls), 1)


class PackedSnapshot(unittest.TestCase):
    def test_pack_binds_exact_bytes_and_forces_lazy_decode_before_has_data(self):
        class Pixels:
            def __init__(self, image):
                self.image = image
            def __len__(self):
                return 4
            def __getitem__(self, index):
                self.image.has_data = True
                return 1.0
        class Image:
            def __init__(self):
                self.has_data = False
                self.packed_file = None
                self.pixels = Pixels(self)
            def pack(self, data, data_len):
                assert len(data) == data_len
                self.packed_file = types.SimpleNamespace(data=data)
            def reload(self):
                self.has_data = False
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'snapshot.png'
            data = b'isolated encoded image snapshot'
            file.write_bytes(data)
            image = Image()
            report = converter.pack_external_image(image, file)
            self.assertEqual(report['sha256'], hashlib.sha256(data).hexdigest())
            self.assertEqual(image.packed_file.data, data)
            self.assertTrue(image.has_data)


class ActionOwnership(unittest.TestCase):
    class Slot:
        def __init__(self, name, kind='OBJECT'):
            self.name_display = name
            self.target_id_type = kind
    class Action:
        def __init__(self, name, slot=None):
            self.name, self.frame_range = name, [1, 25]
            if slot is not None:
                self.slots = [slot]
    class Owner:
        def __init__(self, name, action=None, slot=None):
            self.name, self.type = name, 'ARMATURE'
            self.bl_rna = types.SimpleNamespace(identifier='Object')
            self.animation_data = types.SimpleNamespace(action=action, action_slot=slot, nla_tracks=[])

    def test_inactive_native_takes_keep_their_exact_slot_owner(self):
        slot = self.Slot('Rig')
        active, inactive = self.Action('Rig|Run', slot), self.Action('Rig|Walk', slot)
        owner = self.Owner('Rig', active, slot)
        bindings = converter.imported_action_bindings(types.SimpleNamespace(objects=[owner]), [active, inactive])
        self.assertEqual([b['take'] for b in bindings], ['Run', 'Walk'])
        self.assertTrue(all(b['owner'] is owner for b in bindings))

    def test_legacy_importer_prefixes_recover_inactive_actions_without_slots(self):
        active, inactive = self.Action('Rig|Run'), self.Action('Rig|Walk')
        owner = self.Owner('Rig', active)
        bindings = converter.imported_action_bindings(types.SimpleNamespace(objects=[owner]), [active, inactive])
        self.assertEqual(len(bindings), 2)
        self.assertEqual(bindings[1]['original'], 'Rig|Walk')

    def test_shared_native_binding_retains_both_owners(self):
        action = self.Action('Rig|Run')
        first, second = self.Owner('Rig', action), self.Owner('Rig2', action)
        bindings = converter.imported_action_bindings(types.SimpleNamespace(objects=[first, second]), [action])
        self.assertEqual({b['owner'] for b in bindings}, {first, second})
        self.assertEqual({b['take'] for b in bindings}, {'Run'})

    def test_unknown_owner_fails_instead_of_dropping_or_guessing_a_take(self):
        owner = self.Owner('Rig')
        with self.assertRaisesRegex(ValueError, '无法唯一确定目标'):
            converter.imported_action_bindings(types.SimpleNamespace(objects=[owner]), [self.Action('Unknown|Walk', self.Slot('Unknown'))])


if __name__ == '__main__':
    unittest.main()
