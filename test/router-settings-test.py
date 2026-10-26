"""Run the real legacy-setting migration with an isolated UCI state."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


def mock_uci(args):
    path = Path(os.environ['BETTBOX_TEST_STATE'])
    state = json.loads(path.read_text(encoding='utf-8'))
    if args[0] == '-q':
        args = args[1:]
    state['calls'].append(args)
    command, key = args
    code = 0
    if command == 'get':
        if key not in state['values']:
            code = 1
        else:
            print(state['values'][key])
    elif command == 'delete':
        state['values'] = {name: value for name, value in state['values'].items()
                           if name != key and not name.startswith(key + '.')}
    elif command != 'commit':
        raise AssertionError('Unexpected UCI operation: ' + str(args))
    path.write_text(json.dumps(state), encoding='utf-8')
    return code


class RouterSettingsTests(unittest.TestCase):
    def migrate(self, values, config_exists=True):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            config = folder / 'bettbox'
            if config_exists:
                config.touch()
            store = folder / 'state.json'
            store.write_text(json.dumps({'values': values, 'calls': []}), encoding='utf-8')
            source = (ROOT / 'bettbox/files/usr/libexec/bettbox/router-settings.sh').read_text(encoding='utf-8')
            source = source.replace('/etc/config/bettbox', config.as_posix())
            wrapper = 'uci() { "$BETTBOX_TEST_PYTHON" "$BETTBOX_TEST_HELPER" --mock-uci "$@"; }\n'
            env = dict(os.environ, BETTBOX_TEST_STATE=store.as_posix(),
                       BETTBOX_TEST_PYTHON=Path(sys.executable).as_posix(),
                       BETTBOX_TEST_HELPER=Path(__file__).resolve().as_posix(), MSYS_NO_PATHCONV='1')
            shell = os.environ.get('BETTBOX_TEST_SHELL') or shutil.which('bash') or shutil.which('sh')
            self.assertTrue(shell, 'A POSIX shell is required')
            result = subprocess.run([shell, '-c', wrapper + source], env=env,
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(store.read_text(encoding='utf-8'))

    def test_removes_legacy_options_and_preserves_router_configuration(self):
        retained = {'bettbox.config.enabled': '0', 'bettbox.config.profile': 'provider',
                    'bettbox.config.transparent_mode': 'tun', 'bettbox.dns.override': '1',
                    'bettbox.provider.url': 'https://example.invalid/sub',
                    'system.ntp.server': 'pool.ntp.org'}
        result = self.migrate(dict(retained, **{'bettbox.config.find_process_mode': 'always',
                              'bettbox.ntp': 'ntp', 'bettbox.ntp.enabled': '1',
                              'bettbox.ntp.write_system': '1'}))
        self.assertEqual(result['values'], retained)
        self.assertEqual(result['calls'].count(['commit', 'bettbox']), 1)

    def test_clean_install_does_not_commit(self):
        result = self.migrate({'bettbox.config.enabled': '0'})
        self.assertFalse(any(call[0] != 'get' for call in result['calls']))

    def test_migration_is_idempotent(self):
        first = self.migrate({'bettbox.config.find_process_mode': 'always', 'bettbox.ntp': 'ntp'})
        second = self.migrate(first['values'])
        self.assertFalse(any(call[0] != 'get' for call in second['calls']))

    def test_missing_configuration_is_untouched(self):
        result = self.migrate({'bettbox.ntp': 'ntp'}, config_exists=False)
        self.assertEqual(result['values'], {'bettbox.ntp': 'ntp'})
        self.assertEqual(result['calls'], [])


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--mock-uci':
        sys.exit(mock_uci(sys.argv[2:]))
    unittest.main()
