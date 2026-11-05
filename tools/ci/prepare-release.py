"""One explicit release preparation path for all native CI jobs."""
import argparse
from pathlib import Path
import subprocess
import sys


def prepare(mode, run_tests, output, *, root=None):
    root = root or Path(__file__).resolve().parents[2]
    verify = [sys.executable, str(root / 'tools/ci/verify-release.py'), '--output', str(output)]
    if not run_tests:
        verify.append('--extract-only')

    if mode == 'source':
        subprocess.run([sys.executable, str(root / 'tools/package-skill.py')], cwd=root, check=True)
        verify.extend(['--release', str(root / 'release.json')])
    elif mode == 'frozen':
        release = root / 'release-input/release.json'
        archive = root / 'release-input/motion-stage.zip'
        if not release.is_file() or not archive.is_file():
            raise FileNotFoundError('Frozen verification requires both release-input/release.json and motion-stage.zip; it never rebuilds source.')
        verify.extend(['--release', str(release), '--archive', str(archive)])
    else:
        raise ValueError('Release mode must be source or frozen')

    subprocess.run(verify, cwd=root, check=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['source', 'frozen'], required=True)
    parser.add_argument('--tests', choices=['true', 'false'], default='false')
    parser.add_argument('--output', type=Path, default=Path('ci-results'))
    args = parser.parse_args()
    prepare(args.mode, args.tests == 'true', args.output)
