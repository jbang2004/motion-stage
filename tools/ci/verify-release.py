"""Verify and exercise the actual release ZIP on a native CI operating system."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import platform
import re
import subprocess
import tempfile
import time
import zipfile

# CI redirects stdout on Windows; its locale encoding can otherwise hide the
# original failing test behind an unrelated UnicodeEncodeError.
if hasattr(os.sys.stdout, 'reconfigure'):
    os.sys.stdout.reconfigure(encoding='utf-8')
if hasattr(os.sys.stderr, 'reconfigure'):
    os.sys.stderr.reconfigure(encoding='utf-8')

parser = argparse.ArgumentParser()
parser.add_argument('--release', type=Path, default=Path('release.json'))
parser.add_argument('--archive', type=Path)
parser.add_argument('--output', type=Path, default=Path('ci-results'))
parser.add_argument('--extract-only', action='store_true')
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
release = json.loads(args.release.read_text(encoding='utf-8'))
archive = args.archive or Path(release['archive'])
assert hashlib.sha256(archive.read_bytes()).hexdigest() == release['archiveSha256']
destination = Path(tempfile.mkdtemp(prefix='Motion release & 100% 中文 ', dir=os.environ.get('RUNNER_TEMP')))
with zipfile.ZipFile(archive) as bundle:
    names = set()
    for item in bundle.infolist():
        path = Path(item.filename)
        assert path.parts[0] == 'motion-stage' and '..' not in path.parts and not path.is_absolute()
        assert item.filename not in names
        assert ((item.external_attr >> 16) & 0o170000) != 0o120000
        if path.name == 'Open MotionStage.command':
            assert ((item.external_attr >> 16) & 0o111) == 0o111, 'Portable ZIP must preserve the macOS launcher execute bit even when built on Windows'
        names.add(item.filename)
    bundle.extractall(destination)
    if os.name != 'nt':
        for item in bundle.infolist():
            mode = (item.external_attr >> 16) & 0o777
            if mode:
                (destination / item.filename).chmod(mode)
installed = destination / 'motion-stage'
manifest = json.loads((installed / 'bundle-manifest.json').read_text(encoding='utf-8'))
expected = {'bundle-manifest.json'}
for row in manifest['files']:
    path = installed / row['path']
    assert path.stat().st_size == row['bytes'], row['path']
    assert hashlib.sha256(path.read_bytes()).hexdigest() == row['sha256'], row['path']
    expected.add(row['path'])
assert {p.relative_to(installed).as_posix() for p in installed.rglob('*') if p.is_file()} == expected
result = {'release': release, 'system': platform.platform(), 'machine': platform.machine(),
          'node': subprocess.check_output(['node', '--version'], text=True).strip(),
          'extractedRoot': str(installed), 'manifestFilesChecked': len(manifest['files'])}
with (args.output / 'extracted-root.txt').open('w', encoding='utf-8') as output:
    output.write(str(installed))
if os.environ.get('GITHUB_OUTPUT'):
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
        output.write('skill-root=' + str(installed) + '\n')
if not args.extract_only:
    tests = sorted(str(p) for p in (installed / 'scripts/test').glob('*.test.mjs'))
    env = {**os.environ, 'PYTHON_EXECUTABLE': os.sys.executable, 'PYTHONUTF8': '1', 'NODE_PATH': ''}
    start = time.monotonic()
    with (args.output / 'tests.log').open('w', encoding='utf-8') as output:
        run = subprocess.run(['node', '--test', *tests], cwd=installed, env=env,
                             stdout=output, stderr=subprocess.STDOUT)
    text = (args.output / 'tests.log').read_text(encoding='utf-8')
    result.update(exitCode=run.returncode, seconds=round(time.monotonic() - start, 2))
    for name in ['tests', 'pass', 'fail', 'skipped']:
        counts = re.findall(r'^(?:#|ℹ) ' + name + r' (\d+)$', text, flags=re.MULTILINE)
        result[name] = int(counts[-1]) if counts else None
    (args.output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result, ensure_ascii=True, indent=2), flush=True)
    if run.returncode:
        print(text[-30000:], flush=True)
        raise SystemExit(run.returncode)
    help_run = subprocess.run(['node', str(installed / 'scripts/motion-feedback.mjs'), '--help'],
                              cwd=destination, env=env, text=True, encoding='utf-8', capture_output=True, check=True)
    assert release['version'] in help_run.stdout
else:
    (args.output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result, ensure_ascii=True, indent=2), flush=True)
