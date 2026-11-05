"""Download a pinned official portable Blender build; Python 3.12+, stdlib only.

The official release index and SHA-256 list must both contain the exact build.
Nothing is installed globally. Cache reuse requires the verified archive hash.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import sys
import tarfile
import tempfile
import time
import urllib.request
import zipfile


def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'motion-skill-portable-ci/1'})
    return urllib.request.urlopen(request, timeout=45)


def sha_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def metadata(version, target, arch):
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Use an exact official version, for example 4.2.0 or 5.2.3')
    series = '.'.join(version.split('.')[:2])
    index_url = f'https://download.blender.org/release/Blender{series}/'
    extension = '.zip' if target == 'windows' else '.tar.xz'
    filename = f'blender-{version}-{target}-{arch}{extension}'
    with fetch(index_url) as response:
        index = response.read().decode('utf-8')
    if filename not in re.findall(r'href="([^"]+)"', index):
        raise ValueError(f'Official release index does not contain {filename}: {index_url}')
    checksum_name = f'blender-{version}.sha256'
    if checksum_name not in re.findall(r'href="([^"]+)"', index):
        raise ValueError(f'Official checksum list is missing: {checksum_name}')
    checksum_url = index_url + checksum_name
    with fetch(checksum_url) as response:
        checksum_text = response.read().decode('utf-8')
    checksums = {}
    for line in checksum_text.splitlines():
        match = re.fullmatch(r'([a-fA-F0-9]{64})\s+\*?(.+)', line.strip())
        if match:
            checksums[match[2]] = match[1].lower()
    if filename not in checksums:
        raise ValueError(f'No official SHA-256 for {filename}')
    return {'version': version, 'platform': target, 'arch': arch, 'filename': filename,
            'indexUrl': index_url, 'url': index_url + filename,
            'checksumUrl': checksum_url, 'sha256': checksums[filename]}


def download(build, destination):
    archive = destination / build['filename']
    if archive.is_file() and sha_file(archive) == build['sha256']:
        return archive
    partial = archive.with_name(archive.name + '.partial')
    for attempt in range(3):
        try:
            print(f'Downloading {build["url"]} (attempt {attempt + 1})', file=sys.stderr, flush=True)
            with fetch(build['url']) as response, partial.open('wb') as stream:
                shutil.copyfileobj(response, stream, length=1024 * 1024)
            actual = sha_file(partial)
            if actual != build['sha256']:
                raise ValueError(f'SHA-256 mismatch: expected {build["sha256"]}, got {actual}')
            partial.replace(archive)
            return archive
        except Exception:
            partial.unlink(missing_ok=True)
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)


def extract(build, archive, destination):
    install = destination / f'blender-{build["version"]}-{build["platform"]}-{build["arch"]}-portable'
    stamp = install / 'motion-ci-verified.json'
    if install.exists():
        if stamp.is_file():
            cached = json.loads(stamp.read_text(encoding='utf-8'))
            executable = install / cached.get('executableRelative', '')
            if (cached.get('archiveSha256') == build['sha256'] and executable.is_file()
                    and cached.get('executableSha256') == sha_file(executable)):
                return executable.resolve()
        raise ValueError(f'Unverified existing extraction kept unchanged: {install}')
    staging = Path(tempfile.mkdtemp(prefix='blender-extract-', dir=destination))
    try:
        if archive.suffix == '.zip':
            with zipfile.ZipFile(archive) as bundle:
                for member in bundle.infolist():
                    path = staging / member.filename
                    if not path.resolve().is_relative_to(staging.resolve()):
                        raise ValueError(f'Archive traversal: {member.filename}')
                    if (member.external_attr >> 16) & 0o170000 == 0o120000:
                        raise ValueError(f'Unexpected Windows archive symlink: {member.filename}')
                bundle.extractall(staging)
        else:
            with tarfile.open(archive, 'r:xz') as bundle:
                # Python 3.12's data filter rejects traversal, external links and
                # special files while retaining the official executable bits.
                bundle.extractall(staging, filter='data')
        name = 'blender.exe' if build['platform'] == 'windows' else 'blender'
        candidates = [path for path in staging.rglob(name) if path.is_file()]
        if len(candidates) != 1:
            raise ValueError(f'Expected one {name} executable, found {len(candidates)}')
        # Official archives have one root directory. Avoid duplicating its name
        # in the extraction path, especially for Windows' longest addon paths.
        children = list(staging.iterdir())
        payload = children[0] if len(children) == 1 and children[0].is_dir() else staging
        relative = candidates[0].relative_to(payload)
        (payload / stamp.name).write_text(json.dumps({'archiveSha256': build['sha256'],
                                                     'executableSha256': sha_file(candidates[0]),
                                                     'executableRelative': relative.as_posix()}, indent=2) + '\n', encoding='utf-8')
        payload.rename(install)
        return (install / relative).resolve()
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', required=True)
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--platform', choices=['windows', 'linux'])
    parser.add_argument('--arch', choices=['x64', 'arm64'])
    parser.add_argument('--metadata-only', action='store_true')
    parser.add_argument('--github-env', action='store_true', help='Append BLENDER_EXECUTABLE to GITHUB_ENV')
    args = parser.parse_args()
    target = args.platform or {'Windows': 'windows', 'Linux': 'linux'}.get(platform.system())
    if target is None:
        parser.error('Portable extraction supports Windows/Linux; use --platform with --metadata-only elsewhere')
    machine = platform.machine().lower()
    arch = args.arch or ('arm64' if machine in ('arm64', 'aarch64') else 'x64' if machine in ('amd64', 'x86_64') else None)
    if arch is None:
        parser.error(f'Unsupported architecture: {machine}')
    if sys.version_info < (3, 12):
        parser.error('Python 3.12 or higher is required for safe tar extraction')
    destination = args.destination.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    build = metadata(args.version, target, arch)
    if not args.metadata_only:
        build['archive'] = str(download(build, destination))
        build['archiveBytes'] = Path(build['archive']).stat().st_size
        build['verifiedSha256'] = build['sha256']
        build['executable'] = str(extract(build, Path(build['archive']), destination))
        build['executableSha256'] = sha_file(Path(build['executable']))
    report_path = destination / f'blender-{args.version}-{target}-{arch}-download.json'
    report_path.write_text(json.dumps(build, indent=2) + '\n', encoding='utf-8')
    if args.github_env:
        if args.metadata_only or not os.environ.get('GITHUB_ENV'):
            parser.error('--github-env requires a full download and the GITHUB_ENV environment variable')
        with open(os.environ['GITHUB_ENV'], 'a', encoding='utf-8') as stream:
            stream.write(f'BLENDER_EXECUTABLE={build["executable"]}\n')
    print(json.dumps(build, indent=2))


if __name__ == '__main__':
    main()
