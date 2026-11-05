"""Portable extraction and corruption checks; no network or Blender required."""
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('download_blender', Path(__file__).with_name('download-blender.py'))
downloader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(downloader)


class PortableExtractionTests(unittest.TestCase):
    def test_windows_zip_and_linux_tar_extract_reuse_and_reject_tampered_binary(self):
        for target in ['windows', 'linux']:
            with self.subTest(platform=target), tempfile.TemporaryDirectory(prefix='motion download & 100% 中文 ') as root:
                destination = Path(root)
                name = 'blender.exe' if target == 'windows' else 'blender'
                archive = destination / ('test.zip' if target == 'windows' else 'test.tar.xz')
                member = f'official-root/{name}'
                if target == 'windows':
                    with zipfile.ZipFile(archive, 'w') as bundle:
                        bundle.writestr(member, b'synthetic executable fixture')
                else:
                    with tarfile.open(archive, 'w:xz') as bundle:
                        entry = tarfile.TarInfo(member)
                        entry.size, entry.mode = len(b'synthetic executable fixture'), 0o755
                        bundle.addfile(entry, io.BytesIO(b'synthetic executable fixture'))
                build = {'version': '1.0.0', 'platform': target, 'arch': 'x64', 'sha256': downloader.sha_file(archive)}
                executable = downloader.extract(build, archive, destination)
                self.assertEqual(executable.parent.name, f'blender-1.0.0-{target}-x64-portable')
                self.assertEqual(executable.read_bytes(), b'synthetic executable fixture')
                self.assertEqual(downloader.extract(build, archive, destination), executable)
                stamp = json.loads((executable.parent / 'motion-ci-verified.json').read_text(encoding='utf-8'))
                self.assertEqual(stamp['archiveSha256'], build['sha256'])
                executable.write_bytes(b'corrupted binary')
                with self.assertRaisesRegex(ValueError, 'Unverified existing extraction'):
                    downloader.extract(build, archive, destination)

    def test_archive_traversal_is_rejected_before_writing_outside_staging(self):
        for target in ['windows', 'linux']:
            with self.subTest(platform=target), tempfile.TemporaryDirectory() as root:
                destination = Path(root)
                archive = destination / ('bad.zip' if target == 'windows' else 'bad.tar.xz')
                if target == 'windows':
                    with zipfile.ZipFile(archive, 'w') as bundle:
                        bundle.writestr('../escaped-file', b'escape')
                else:
                    with tarfile.open(archive, 'w:xz') as bundle:
                        entry = tarfile.TarInfo('../escaped-file')
                        entry.size = 6
                        bundle.addfile(entry, io.BytesIO(b'escape'))
                build = {'version': '1.0.0', 'platform': target, 'arch': 'x64', 'sha256': downloader.sha_file(archive)}
                with self.assertRaises((ValueError, tarfile.FilterError)):
                    downloader.extract(build, archive, destination)
                self.assertFalse((destination / 'escaped-file').exists())


if __name__ == '__main__':
    unittest.main()
