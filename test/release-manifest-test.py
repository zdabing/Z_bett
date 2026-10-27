"""Feed assembly/publishing checks with fake APK metadata and GitHub responses.

No compilation, APK installation, network requests or release publication.
"""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('release_manifest', ROOT / 'test/release-manifest.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.metadata = {}
        self.native_calls = []
        self.native = patch.object(MODULE, 'run', self.apk_command)
        self.native.start()
        self.addCleanup(self.native.stop)

    def apk_command(self, args):
        self.native_calls.append(args)
        if 'verify' in args:
            return ''
        return json.dumps({'info': self.metadata[str(Path(args[-1]))]})

    def artifacts(self, mutate=None):
        artifacts = self.root / 'artifacts'
        for target in MODULE.TARGETS:
            source = self.root / 'built' / target
            source.mkdir(parents=True)
            for name in MODULE.NAMES:
                version = MODULE.package_version(name)
                path = source / (name + '-' + version + '.apk')
                path.write_bytes(('fake APK ' + name + target).encode())
                info = dict(name=name, version=version, arch=target if name == 'bettbox' else 'noarch',
                            provides=['bettbox-forge=' + version], replaces=['bettbox-forge'])
                info['installed-size'] = 1000000
                if mutate:
                    mutate(info)
                self.metadata[str(path)] = info
            MODULE.collect(target, 'fake-apk', source, artifacts / target)
        return artifacts

    def assembled(self):
        artifacts = self.artifacts()
        output = self.root / 'release'
        manifest = MODULE.assemble('v2026.10.27', artifacts, output)
        return manifest, output

    def test_both_targets_have_qualified_assets_and_matching_checksums(self):
        manifest, output = self.assembled()
        self.assertEqual(manifest['schema'], 1)
        self.assertEqual(manifest['openwrt'], '25.12')
        self.assertEqual(len(list(output.glob('*.apk'))), 4)
        self.assertEqual(len([call for call in self.native_calls if 'verify' in call]), 4)
        for target, record in manifest['targets'].items():
            for item in record['packages']:
                self.assertTrue(item['filename'].endswith('-' + target + '.apk'))
                self.assertEqual(item['sha256'], MODULE.sha(output / item['filename']))

    def test_wrong_apk_architecture_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'identity'):
            self.artifacts(lambda info: info.update(arch='wrong'))

    def test_missing_helper_handover_metadata_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'migration'):
            self.artifacts(lambda info: info.update(replaces=[]))

    def test_corrupt_artifact_is_rejected_before_feed_assembly(self):
        artifacts = self.artifacts()
        next(artifacts.rglob('*.apk')).write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            MODULE.assemble('v2026.10.27', artifacts, self.root / 'release')

    def test_tag_cannot_contain_paths_shell_or_unexpected_suffix(self):
        for tag in ['../latest', '$(reboot)', 'v1.2.3\n', 'v1.2.3-beta', '', 'v' + '1' * 70 + '.2.3']:
            with self.assertRaises(ValueError):
                MODULE.assemble(tag, self.root, self.root / 'unused')

    def publish(self, mode):
        _, output = self.assembled()
        self.native.stop()
        calls = []

        def gh(args, **kwargs):
            calls.append(args)
            if 'git/ref/tags/' in args[-1]:
                references = sum('git/ref/tags/' in item[-1] for item in calls)
                if references == 1:
                    return subprocess.CompletedProcess(args, 0 if mode == 'existing' else 1, '', 'HTTP 404')
                return subprocess.CompletedProcess(args, 0, json.dumps({'object': {'type':'commit','sha': 'b' * 40 if mode == 'tag-race' else 'a' * 40}}), '')
            stdout = ''
            if args[:2] == ['gh', 'api']:
                assets = [dict(name=path.name, size=path.stat().st_size, digest='sha256:' + MODULE.sha(path))
                          for path in list(output.glob('*.apk')) + [output / 'bettbox-update.json']]
                if mode == 'bad-digest':
                    assets[0]['digest'] = None
                stdout = json.dumps(dict(assets=assets))
            return subprocess.CompletedProcess(args, 0, stdout, '')

        with patch.object(MODULE.subprocess, 'run', gh), patch.object(MODULE.time, 'sleep', lambda _: None):
            if mode == 'good':
                MODULE.publish('v2026.10.27', 'a' * 40, MODULE.REPOSITORY, output)
            else:
                with self.assertRaises(ValueError):
                    MODULE.publish('v2026.10.27', 'a' * 40, MODULE.REPOSITORY, output)
        return calls

    def test_publish_keeps_draft_until_github_checksums_match(self):
        calls = self.publish('good')
        create = next(c for c in calls if c[:3] == ['gh', 'release', 'create'])
        self.assertIn('--draft', create)
        self.assertIn('a' * 40, create)
        self.assertTrue(any(c[:3] == ['gh', 'release', 'edit'] and '--draft=false' in c and '--latest' in c for c in calls))

    def test_missing_github_digest_never_publishes_draft(self):
        calls = self.publish('bad-digest')
        self.assertFalse(any(c[:3] == ['gh', 'release', 'edit'] for c in calls))

    def test_existing_tag_is_never_overwritten(self):
        calls = self.publish('existing')
        self.assertFalse(any(c[:2] == ['gh', 'release'] for c in calls))

    def test_tag_race_cannot_publish_the_wrong_commit(self):
        calls = self.publish('tag-race')
        self.assertFalse(any(c[:3] == ['gh', 'release', 'edit'] for c in calls))


if __name__ == '__main__':
    unittest.main()
