"""Exercise real source/frozen preparation in isolated tiny repositories."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('prepare_release', ROOT / 'tools/ci/prepare-release.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReleasePreparation(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='release preparation & 中文 ')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.output = self.root / 'evidence'
        for path in ['tools/ci', 'skill/scripts/test']:
            (self.root / path).mkdir(parents=True)
        for path in ['tools/package-skill.py', 'tools/ci/verify-release.py']:
            shutil.copy2(ROOT / path, self.root / path)
        (self.root / 'skill/package.json').write_text('{"version":"0.0.0-fixture"}', encoding='utf-8')
        (self.root / 'skill/SKILL.md').write_text('Synthetic release fixture\n', encoding='utf-8')
        (self.root / 'skill/fixture.json').write_text('{"releaseFixture":true}\n', encoding='utf-8')
        (self.root / 'skill/Open MotionStage.command').write_bytes(b'#!/bin/sh\nexit 0\n')
        (self.root / 'skill/scripts/motion-feedback.mjs').write_text('console.log("0.0.0-fixture");\n', encoding='utf-8')
        (self.root / 'skill/scripts/test/fixture.test.mjs').write_text(
            'import test from "node:test"; import assert from "node:assert/strict"; import {readFile} from "node:fs/promises";\n'
            'test("extracted release retains its payload",async()=>{const value=JSON.parse(await readFile(new URL("../../fixture.json",import.meta.url)));assert.equal(value.releaseFixture,true);});\n', encoding='utf-8')

    def prepare(self, mode, tests=False):
        module.prepare(mode, tests, self.output, root=self.root)
        return json.loads((self.output / 'result.json').read_text(encoding='utf-8'))

    def freeze_source(self):
        result = self.prepare('source')
        frozen = self.root / 'release-input'
        frozen.mkdir()
        shutil.copy2(self.root / 'release.json', frozen / 'release.json')
        shutil.copy2(self.root / result['release']['archive'], frozen / 'motion-stage.zip')
        return result

    def test_source_builds_and_verifies_an_executable_launcher(self):
        result = self.prepare('source')
        self.assertEqual(result['manifestFilesChecked'], 6)
        self.assertTrue((self.root / result['release']['archive']).is_file())
        self.assertNotIn('exitCode', result)
        extracted = Path(result['extractedRoot'])
        self.addCleanup(shutil.rmtree, extracted.parent)
        self.assertEqual((extracted / 'Open MotionStage.command').read_bytes(), b'#!/bin/sh\nexit 0\n')

    def test_frozen_runs_the_exact_packaged_tests_even_when_source_is_broken(self):
        built = self.freeze_source()
        self.addCleanup(shutil.rmtree, Path(built['extractedRoot']).parent)
        (self.root / 'tools/package-skill.py').write_text('raise RuntimeError("must never rebuild frozen input")\n')
        (self.root / 'skill/fixture.json').write_text('{"releaseFixture":false}\n')
        (self.root / 'skill/scripts/test/fixture.test.mjs').write_text('throw Error("must never run checkout tests");\n')
        result = self.prepare('frozen', tests=True)
        self.addCleanup(shutil.rmtree, Path(result['extractedRoot']).parent)
        self.assertEqual(result['release']['archiveSha256'], built['release']['archiveSha256'])
        self.assertEqual((result['tests'], result['pass'], result['fail'], result['exitCode']), (1, 1, 0, 0))

    def test_missing_frozen_input_fails_without_building_source(self):
        with self.assertRaises(FileNotFoundError):
            self.prepare('frozen')
        self.assertFalse((self.root / 'release.json').exists())
        self.assertFalse((self.root / 'dist').exists())

    def test_corrupt_frozen_archive_is_rejected_without_rebuilding(self):
        built = self.freeze_source()
        self.addCleanup(shutil.rmtree, Path(built['extractedRoot']).parent)
        archive = self.root / 'release-input/motion-stage.zip'
        archive.write_bytes(b'corrupt frozen release')
        (self.root / 'tools/package-skill.py').write_text('raise RuntimeError("must not recover by rebuilding")\n')
        with self.assertRaises(subprocess.CalledProcessError):
            self.prepare('frozen')


if __name__ == '__main__':
    unittest.main()
