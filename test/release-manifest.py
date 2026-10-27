"""Validate built APK metadata and prepare/publish the fixed updater feed.

collect/assemble do not compile. publish is called only by the opt-in release
job, creates an immutable draft, verifies GitHub digests, then makes it latest.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import time

REPOSITORY = 'zdabing/Z_bett'
TARGETS = ('x86_64', 'aarch64_generic')
NAMES = ('bettbox', 'luci-app-bettbox')
TAG = re.compile(r'v[0-9]+\.[0-9]+\.[0-9]+(?:-r[0-9]+)?\Z')
VERSION = re.compile(r'[0-9]+\.[0-9]+\.[0-9]+-r[0-9]+\Z')
ROOT = Path(__file__).resolve().parents[1]


def require(value, message):
    if not value:
        raise ValueError(message)


def run(args):
    result = subprocess.run(args, check=True, capture_output=True, text=True, encoding='utf-8')
    return result.stdout


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def package_version(name):
    text = (ROOT / name / 'Makefile').read_text(encoding='utf-8')
    version = re.search(r'^PKG_VERSION:=(.+)$', text, re.M)[1].strip()
    revision = re.search(r'^PKG_RELEASE:=(.+)$', text, re.M)[1].strip()
    result = version + '-r' + revision
    require(len(result) < 64 and VERSION.fullmatch(result), 'invalid source package version')
    return result


def metadata(tool, path):
    data = json.loads(run([tool, 'adbdump', '--format', 'json', str(path)]))
    if isinstance(data, list) and len(data) == 1:
        data = data[0]
    require(isinstance(data, dict) and isinstance(data.get('info'), dict), 'invalid APK metadata')
    return data['info']


def collect(target, apk_tool, source, output):
    require(target in TARGETS, 'unsupported target')
    source, output = Path(source), Path(output)
    output.mkdir(parents=True, exist_ok=False)
    packages = []
    for name in NAMES:
        version = package_version(name)
        matches = list(source.glob(name + '-' + version + '.apk'))
        require(len(matches) == 1, 'expected one built ' + name + ' APK')
        path = matches[0]
        run([apk_tool, '--allow-untrusted', 'verify', str(path)])
        info = metadata(apk_tool, path)
        arch = target if name == 'bettbox' else 'noarch'
        require(info.get('name') == name and info.get('version') == version and info.get('arch') == arch,
                'built APK identity does not match source/target')
        if name == 'bettbox':
            require('bettbox-forge=' + version in info.get('provides', []) and 'bettbox-forge' in info.get('replaces', []),
                    'built APK lacks the merged helper migration metadata')
        installed = info.get('installed-size')
        require(type(installed) is int and 0 < installed <= 536870912, 'invalid installed size')
        require(0 < path.stat().st_size <= 134217728, 'APK exceeds update limit')
        filename = name + '-' + version + '-' + target + '.apk'
        shutil.copyfile(path, output / filename)
        packages.append(dict(name=name, version=version, arch=arch, installed_size=installed,
                             filename=filename, size=path.stat().st_size, sha256=sha(path)))
    fragment = dict(schema=1, target=target, packages=packages)
    (output / ('manifest-' + target + '.json')).write_text(json.dumps(fragment, indent=2) + '\n', encoding='utf-8')
    return fragment


def assemble(tag, artifacts, output):
    require(len(tag) < 64 and TAG.fullmatch(tag), 'release tag must be vX.Y.Z or vX.Y.Z-rN')
    artifacts, output = Path(artifacts), Path(output)
    output.mkdir(parents=True, exist_ok=False)
    targets = {}
    for target in TARGETS:
        matches = list(artifacts.rglob('manifest-' + target + '.json'))
        require(len(matches) == 1, 'expected one artifact manifest for ' + target)
        fragment = json.loads(matches[0].read_text(encoding='utf-8'))
        require(fragment.get('schema') == 1 and fragment.get('target') == target, 'invalid artifact manifest')
        packages = fragment.get('packages')
        require(isinstance(packages, list) and len(packages) == 2, 'expected two APKs per target')
        for name, item in zip(NAMES, packages):
            version = package_version(name)
            filename = name + '-' + version + '-' + target + '.apk'
            require(item.get('name') == name and item.get('version') == version and item.get('filename') == filename,
                    'artifact package identity differs from source')
            require(item.get('arch') == (target if name == 'bettbox' else 'noarch'), 'artifact architecture mismatch')
            require(type(item.get('installed_size')) is int and 0 < item['installed_size'] <= 536870912,
                    'invalid installed size')
            path = matches[0].parent / filename
            require(path.is_file() and not path.is_symlink() and 0 < path.stat().st_size <= 134217728,
                    'missing or invalid artifact APK')
            require(item.get('size') == path.stat().st_size and item.get('sha256') == sha(path), 'artifact checksum mismatch')
            shutil.copyfile(path, output / filename)
        targets[target] = dict(packages=packages)
    manifest = dict(schema=1, tag=tag, openwrt='25.12', targets=targets)
    (output / 'bettbox-update.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    return manifest


def publish(tag, commit, repository, directory):
    require(len(tag) < 64 and TAG.fullmatch(tag) and re.fullmatch('[a-f0-9]{40}', commit), 'invalid release tag or commit')
    require(repository == REPOSITORY, 'updater publishing is restricted to ' + REPOSITORY)
    directory = Path(directory)
    manifest = json.loads((directory / 'bettbox-update.json').read_text(encoding='utf-8'))
    require(manifest.get('tag') == tag and manifest.get('schema') == 1, 'manifest tag mismatch')
    files = sorted(directory.glob('*.apk')) + [directory / 'bettbox-update.json']
    require(len(files) == 5, 'expected four architecture-qualified APKs and one update manifest')
    notes = ROOT / 'docs/releases' / (tag + '.md')
    require(notes.is_file() and notes.stat().st_size > 0, 'missing version-specific release notes: ' + tag)
    # Never clobber an existing release/tag: downloaded versions stay immutable.
    existing = subprocess.run(['gh', 'api', 'repos/' + repository + '/git/ref/tags/' + tag], capture_output=True, text=True)
    require(existing.returncode != 0 and '404' in existing.stderr, 'tag already exists or could not be checked')
    run(['gh', 'release', 'create', tag, '--repo', repository, '--draft', '--target', commit,
         '--title', 'Bettbox ' + tag, '--notes-file', str(notes)] + [str(path) for path in files])
    reference = json.loads(run(['gh', 'api', 'repos/' + repository + '/git/ref/tags/' + tag]))
    require(reference.get('object', {}).get('type') == 'commit' and reference['object'].get('sha') == commit,
            'release tag differs from build commit; release remains a draft')
    expected = {path.name: (path.stat().st_size, 'sha256:' + sha(path)) for path in files}
    for attempt in range(4):
        release = json.loads(run(['gh', 'api', 'repos/' + repository + '/releases/tags/' + tag]))
        assets = {asset['name']: (asset.get('size'), asset.get('digest')) for asset in release.get('assets', [])}
        if all(assets.get(name) == value for name, value in expected.items()):
            run(['gh', 'release', 'edit', tag, '--repo', repository, '--draft=false', '--latest'])
            return
        if attempt < 3:
            time.sleep(2)
    raise ValueError('GitHub digest verification failed; release remains a draft')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='action', required=True)
    check = commands.add_parser('validate-tag')
    check.add_argument('tag')
    collect_args = commands.add_parser('collect')
    for option in ('target', 'apk-tool', 'input', 'output'):
        collect_args.add_argument('--' + option, required=True)
    assembly = commands.add_parser('assemble')
    for option in ('tag', 'input', 'output'):
        assembly.add_argument('--' + option, required=True)
    release_args = commands.add_parser('publish')
    for option in ('tag', 'commit', 'repository', 'input'):
        release_args.add_argument('--' + option, required=True)
    args = parser.parse_args()
    if args.action == 'validate-tag':
        require(len(args.tag) < 64 and TAG.fullmatch(args.tag), 'release tag must be vX.Y.Z or vX.Y.Z-rN')
        require((ROOT / 'docs/releases' / (args.tag + '.md')).is_file(), 'missing version-specific release notes')
    elif args.action == 'collect':
        collect(args.target, args.apk_tool, args.input, args.output)
    elif args.action == 'assemble':
        assemble(args.tag, args.input, args.output)
    else:
        publish(args.tag, args.commit, args.repository, args.input)
