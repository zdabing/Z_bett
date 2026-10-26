"""Execute production shell scripts in an isolated router-like environment."""
import http.server
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tarfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / 'bettbox/files/usr/libexec/bettbox'


def uci(args):
    if args[0] == '-c':
        directory = args[1]
        if os.name == 'nt' and directory.startswith('/tmp/'):
            directory = str(Path(os.environ['TEMP']) / directory[5:])
        candidate = Path(directory) / 'bettbox'
        return 0 if candidate.is_file() and candidate.read_text().startswith('config ') else 1
    state_path = Path(os.environ['BETTBOX_TEST_UCI'])
    state = json.loads(state_path.read_text())
    if args[0] == '-q':
        args = args[1:]
    command, *tail = args
    key = tail[0] if tail else ''
    result = 0
    if command == 'get':
        if key not in state:
            result = 1
        else:
            value = state[key]
            print(' '.join(value) if isinstance(value, list) else value)
    elif command == 'set':
        key, value = key.split('=', 1)
        state[key] = value
    elif command == 'add_list':
        key, value = key.split('=', 1)
        old = state.get(key, [])
        state[key] = (old if isinstance(old, list) else [old]) + [value]
    elif command == 'del_list':
        key, value = key.split('=', 1)
        old = state.get(key, [])
        state[key] = [item for item in (old if isinstance(old, list) else [old]) if item != value]
    elif command == 'delete':
        state = {name: value for name, value in state.items() if name != key and not name.startswith(key + '.')}
    elif command == 'show':
        for name, value in state.items():
            if name.startswith(key + '.'):
                print(name + "='" + str(value) + "'")
    elif command not in ('commit', 'changes'):
        raise AssertionError(args)
    state_path.write_text(json.dumps(state))
    return result


class ShellTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.bin = self.folder / 'bin'
        self.bin.mkdir()
        self.etc = self.folder / 'etc'
        self.run = self.folder / 'run'
        for directory in ('profiles', 'state', 'scripts'):
            (self.etc / directory).mkdir(parents=True, exist_ok=True)
        self.run.mkdir()
        self.state_path = self.folder / 'uci.json'
        self.state_path.write_text(json.dumps({'bettbox.config.enabled': '0',
            'bettbox.config.profile': 'testsub', 'bettbox.testsub.url': 'https://example.invalid/sub',
            'bettbox.testsub.auto_update': '1', 'bettbox.testsub.last_update': '0',
            'bettbox.config.transparent_mode': 'redir', 'bettbox.config.redir_port': '7895',
            'bettbox.config.mixed_port': '7893', 'bettbox.config.tproxy_port': '7894',
            'bettbox.dns.listen': '0.0.0.0:1053', 'network.lan.device': 'br-lan'}))
        self.calls = self.folder / 'calls'
        self.env = dict(os.environ, PATH=self.bin.as_posix() + os.pathsep + os.environ['PATH'],
            BETTBOX_TEST_UCI=self.state_path.as_posix(), BETTBOX_TEST_PYTHON=Path(sys.executable).as_posix(),
            BETTBOX_TEST_HELPER=Path(__file__).as_posix(), BETTBOX_TEST_CALLS=self.calls.as_posix(),
            BETTBOX_TEST_NFT=(self.folder / 'rules.nft').as_posix(), MSYS_NO_PATHCONV='1',
            BETTBOX_TEST_SERVICE_RC='0', BETTBOX_TEST_NFT_RC='0')
        self.shell = os.environ.get('BETTBOX_TEST_SHELL') or shutil.which('bash') or shutil.which('sh')
        self.assertTrue(self.shell)
        self.executable('uci', 'exec "$BETTBOX_TEST_PYTHON" "$BETTBOX_TEST_HELPER" --uci "$@"')
        self.executable('logger', ':')
        self.executable('sleep', ':')
        self.executable('timeout', 'shift; exec "$@"')
        self.executable('yq', 'case "$*" in *-o=json*) printf "{}\\n" ;; *) echo true ;; esac')
        self.executable('ucode', 'echo render >> "$BETTBOX_TEST_CALLS"; printf "mode: direct\\n" > "$3"')
        self.executable('mihomo', 'exit 0')
        self.executable('service', 'echo "$*" >> "$BETTBOX_TEST_CALLS"; exit "$BETTBOX_TEST_SERVICE_RC"')
        self.executable('nft', 'if [ "$1" = -f ]; then cat > "$BETTBOX_TEST_NFT"; fi; exit "$BETTBOX_TEST_NFT_RC"')
        self.executable('ip', 'echo "ip $*" >> "$BETTBOX_TEST_CALLS"; case "$*" in *"rule del"*) exit 1 ;; esac')
        common = (LIB / 'common.sh').read_text(encoding='utf-8')
        common = common.replace('BETTBOX_RUN=/var/run/bettbox', 'BETTBOX_RUN="' + self.run.as_posix() + '"')
        common = common.replace('BETTBOX_ETC=/etc/bettbox', 'BETTBOX_ETC="' + self.etc.as_posix() + '"')
        (self.folder / 'common.sh').write_text(common, encoding='utf-8', newline='\n')
        (self.etc / 'profiles/testsub.yaml').write_text('proxies: []\n')

    def executable(self, name, source):
        target = self.bin / name
        target.write_text('#!/bin/sh\n' + source + '\n', encoding='utf-8', newline='\n')
        target.chmod(0o755)

    def set_uci(self, **changes):
        state = json.loads(self.state_path.read_text())
        state.update(changes)
        self.state_path.write_text(json.dumps(state))

    def execute(self, name, *args):
        source = (LIB / name).read_text(encoding='utf-8')
        source = source.replace('/usr/libexec/bettbox/common.sh', '"' + (self.folder / 'common.sh').as_posix() + '"')
        source = source.replace('/etc/init.d/bettbox', '"' + (self.bin / 'service').as_posix() + '"')
        source = source.replace('/etc/init.d/dnsmasq', '"' + (self.bin / 'service').as_posix() + '"')
        if name == 'backup.sh':
            target_config = self.folder / 'live-config/bettbox'
            target_config.parent.mkdir(exist_ok=True)
            if not target_config.exists():
                target_config.write_text('config core original\n')
            source = source.replace(' /etc/config/bettbox', ' "' + target_config.as_posix() + '"')
            source = source.replace('/usr/libexec/bettbox/router-settings.sh', (self.bin / 'migration').as_posix())
            source = source.replace('/usr/bin/bettbox apply-service', '"' + (self.bin / 'service').as_posix() + '" apply-service')
            self.executable('migration', 'exit 0')
        prefix = self.bin.as_posix()
        if os.name == 'nt':
            prefix = '/' + prefix[0].lower() + prefix[2:]
        source = 'PATH="' + prefix + ':$PATH"\n' + source
        target = self.folder / name
        target.write_text(source, encoding='utf-8', newline='\n')
        return subprocess.run([self.shell, target.as_posix(), *args], env=self.env, text=True, encoding='utf-8', capture_output=True)

    def test_service_apply_stops_disabled_core_without_rendering(self):
        result = self.execute('apply.sh', 'service')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls.read_text(), 'stop\n')

    def test_service_apply_enables_and_restarts_enabled_core(self):
        self.set_uci(**{'bettbox.config.enabled': '1'})
        result = self.execute('apply.sh', 'service')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls.read_text(), 'enable\nrestart\n')

    def test_service_failure_propagates(self):
        self.env['BETTBOX_TEST_SERVICE_RC'] = '7'
        self.assertEqual(self.execute('apply.sh', 'service').returncode, 7)

    def test_live_apply_reports_core_reload_http_failure(self):
        self.set_uci(**{'bettbox.config.enabled': '1'})
        self.executable('curl', 'case "$*" in *"/version"*) echo \'{"version":"test"}\' ;; *) exit 22 ;; esac')
        self.assertNotEqual(self.execute('apply.sh', 'live').returncode, 0)

    def test_disabled_live_apply_does_not_start_core(self):
        result = self.execute('apply.sh', 'live')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls.read_text(), 'render\nstop\n')

    def test_http_401_is_not_reported_as_api_success(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(401)
                self.end_headers()
                self.wfile.write(b'{"message":"unauthorized"}')
            def log_message(self, *args):
                pass
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.set_uci(**{'bettbox.config.external_controller': '127.0.0.1:' + str(server.server_port)})
        try:
            command = '. "' + (self.folder / 'common.sh').as_posix() + '"; api_call GET /version'
            result = subprocess.run([self.shell, '-c', command], env=self.env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 22, result.stderr)
        finally:
            server.shutdown()
            server.server_close()

    def test_subscription_header_whitespace_and_case(self):
        self.executable('curl', '''while [ "$#" -gt 0 ]; do
case "$1" in -D) header=$2; shift 2 ;; -o) output=$2; shift 2 ;; *) shift ;; esac
done
printf 'SUBSCRIPTION-USERINFO: upload=10; download=20; total=100; expire=1900000000\\r\\n' > "$header"
echo proxies > "$output"''')
        result = self.execute('subscription.sh', 'update', 'testsub')
        self.assertEqual(result.returncode, 0, result.stderr)
        state = json.loads(self.state_path.read_text())
        self.assertEqual([state['bettbox.testsub.sub_' + name] for name in ('upload', 'download', 'total', 'expire')],
                         ['10', '20', '100', '1900000000'])

    def test_all_and_cron_report_download_failures(self):
        self.executable('curl', 'exit 22')
        for action in ('update-all', 'cron'):
            with self.subTest(action=action):
                self.assertNotEqual(self.execute('subscription.sh', action).returncode, 0)

    def test_redir_uses_redir_listener_and_only_lan(self):
        result = self.execute('firewall.sh', 'start')
        self.assertEqual(result.returncode, 0, result.stderr)
        rules = (self.folder / 'rules.nft').read_text()
        self.assertIn('redirect to :7895', rules)
        self.assertIn('chain redir_prerouting', rules)
        self.assertNotIn('redirect to :7893', rules)
        self.assertEqual(rules.count('iifname != "br-lan" return'), 2)
        self.assertIn('fib daddr type local return', rules)

    def test_redir_rejects_disabled_listener(self):
        self.set_uci(**{'bettbox.config.redir_port': '0'})
        self.assertNotEqual(self.execute('firewall.sh', 'start').returncode, 0)
        self.assertFalse((self.folder / 'rules.nft').exists())

    def test_tproxy_routes_both_families_and_keeps_established_packets(self):
        self.set_uci(**{'bettbox.config.transparent_mode': 'tproxy'})
        result = self.execute('firewall.sh', 'start')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('ct state established,related return', (self.folder / 'rules.nft').read_text())
        self.assertIn('chain proxy_prerouting', (self.folder / 'rules.nft').read_text())
        self.assertIn('ip -6 rule add fwmark 0x162 table 100', self.calls.read_text())
        self.assertIn('ip -6 route add local default dev lo table 100', self.calls.read_text())

    def test_firewall_failure_propagates(self):
        self.env['BETTBOX_TEST_NFT_RC'] = '1'
        self.assertNotEqual(self.execute('firewall.sh', 'start').returncode, 0)

    def test_status_is_read_only_and_uses_shared_api_helper(self):
        common = self.folder / 'common.sh'
        common.write_text(common.read_text() + '\napi_call() { echo \'{"version":"test"}\'; }\n', newline='\n')
        cli = (ROOT / 'bettbox/files/usr/bin/bettbox').read_text(encoding='utf-8')
        cli = cli.replace('LIBEXEC=/usr/libexec/bettbox', 'LIBEXEC="' + self.folder.as_posix() + '"')
        target = self.folder / 'bettbox'
        target.write_text(cli, encoding='utf-8', newline='\n')
        result = subprocess.run([self.shell, target.as_posix(), 'status'], env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('core: {"version":"test"}', result.stdout)
        self.assertFalse(self.calls.exists(), 'Status must not render or modify config')

    def test_dns_forwarding_and_exact_restore_of_original_options(self):
        original = ['119.29.29.29', '223.5.5.5', '/lan/10.0.0.2']
        self.set_uci(**{'bettbox.config.hijack_dnsmasq': '1',
            'dhcp.@dnsmasq[0].server': original, 'dhcp.@dnsmasq[0].noresolv': '1'})
        self.assertEqual(self.execute('dnsmasq.sh', 'apply').returncode, 0)
        state = json.loads(self.state_path.read_text())
        self.assertEqual(state['dhcp.@dnsmasq[0].server'], ['127.0.0.1#1053', '/lan/10.0.0.2'])
        self.assertEqual(self.execute('dnsmasq.sh', 'restore').returncode, 0)
        state = json.loads(self.state_path.read_text())
        self.assertEqual(state['dhcp.@dnsmasq[0].server'], original)
        self.assertEqual(state['dhcp.@dnsmasq[0].noresolv'], '1')

    def test_dns_restore_removes_recorded_old_port_after_settings_change(self):
        self.set_uci(**{'bettbox.config.hijack_dnsmasq': '1', 'dhcp.@dnsmasq[0].server': ['119.29.29.29']})
        self.assertEqual(self.execute('dnsmasq.sh', 'apply').returncode, 0)
        self.set_uci(**{'bettbox.dns.listen': '0.0.0.0:1054'})
        self.assertEqual(self.execute('dnsmasq.sh', 'restore').returncode, 0)
        state = json.loads(self.state_path.read_text())
        self.assertEqual(state['dhcp.@dnsmasq[0].server'], ['119.29.29.29'])
        self.assertNotIn('dhcp.@dnsmasq[0].noresolv', state)

    def test_repeated_dns_apply_does_not_restart_again(self):
        self.set_uci(**{'bettbox.config.hijack_dnsmasq': '1'})
        self.assertEqual(self.execute('dnsmasq.sh', 'apply').returncode, 0)
        self.assertEqual(self.execute('dnsmasq.sh', 'apply').returncode, 0)
        self.assertEqual(self.calls.read_text(), 'restart\n')

    def test_dns_restore_preserves_intervening_administrator_edits(self):
        self.set_uci(**{'bettbox.config.hijack_dnsmasq': '1', 'dhcp.@dnsmasq[0].noresolv': '0'})
        self.assertEqual(self.execute('dnsmasq.sh', 'apply').returncode, 0)
        self.set_uci(**{'dhcp.@dnsmasq[0].server': ['9.9.9.9', '127.0.0.1#1053']})
        self.assertEqual(self.execute('dnsmasq.sh', 'restore').returncode, 0)
        state = json.loads(self.state_path.read_text())
        self.assertEqual(state['dhcp.@dnsmasq[0].server'], ['9.9.9.9'])
        self.assertEqual(state['dhcp.@dnsmasq[0].noresolv'], '0')

    def test_dns_restart_failure_rolls_back_original_configuration(self):
        self.set_uci(**{'bettbox.config.hijack_dnsmasq': '1', 'dhcp.@dnsmasq[0].server': ['119.29.29.29']})
        self.env['BETTBOX_TEST_SERVICE_RC'] = '7'
        self.assertNotEqual(self.execute('dnsmasq.sh', 'apply').returncode, 0)
        state = json.loads(self.state_path.read_text())
        self.assertEqual(state['dhcp.@dnsmasq[0].server'], ['119.29.29.29'])
        self.assertNotIn('dhcp.@dnsmasq[0].noresolv', state)

    def archive(self, names, symlink=False):
        target = self.folder / 'restore.tar'
        with tarfile.open(target, 'w', format=tarfile.USTAR_FORMAT) as tar:
            for name, text in names:
                info = tarfile.TarInfo(name)
                if symlink:
                    info.type = tarfile.SYMTYPE
                    info.linkname = '/etc/shadow'
                    tar.addfile(info)
                else:
                    content = text.encode()
                    info.size = len(content)
                    info.mode = 0o600
                    tar.addfile(info, io.BytesIO(content))
        result = target.as_posix()
        return '/' + result[0].lower() + result[2:] if os.name == 'nt' else result

    def test_restore_rejects_unrelated_files_without_changing_live_config(self):
        archive = self.archive([('etc/config/network', 'unexpected')])
        result = self.execute('backup.sh', 'restore', archive)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unexpected path', result.stderr)
        self.assertEqual((self.folder / 'live-config/bettbox').read_text(), 'config core original\n')
        self.assertFalse(self.calls.exists())

    def test_restore_rejects_symlinks(self):
        archive = self.archive([('etc/bettbox/profiles/escape.yaml', '')], symlink=True)
        result = self.execute('backup.sh', 'restore', archive)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('links or special files', result.stderr)
        self.assertFalse(self.calls.exists())

    def test_restore_rejects_parent_traversal(self):
        archive = self.archive([('etc/bettbox/profiles/../../outside', 'unexpected')])
        result = self.execute('backup.sh', 'restore', archive)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unsafe path', result.stderr)
        self.assertFalse(self.calls.exists())

    def test_valid_restore_uses_service_reconciliation(self):
        archive = self.archive([('etc/config/bettbox', 'config core config\n'),
                                ('etc/bettbox/profiles/example.yaml', 'proxies: []\n')])
        result = self.execute('backup.sh', 'restore', archive)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.folder / 'live-config/bettbox').read_text(), 'config core config\n')
        self.assertEqual((self.etc / 'profiles/example.yaml').read_text(), 'proxies: []\n')
        self.assertEqual(self.calls.read_text(), 'apply-service\n')

    def test_restore_application_failure_is_reported(self):
        archive = self.archive([('etc/config/bettbox', 'config core config\n')])
        self.env['BETTBOX_TEST_SERVICE_RC'] = '7'
        result = self.execute('backup.sh', 'restore', archive)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('could not be applied', result.stderr)

    def test_media_connectivity_reports_http_status_without_false_unlock_claims(self):
        self.executable('curl', 'printf 403')
        result = self.execute('toolbox.sh', 'media')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.count('HTTP 403'), 6)
        self.assertNotIn('yes', result.stdout)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--uci':
        sys.exit(uci(sys.argv[2:]))
    unittest.main()
