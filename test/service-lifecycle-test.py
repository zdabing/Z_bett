"""Execute the production init hooks with an isolated procd/network harness.

The harness follows rc.common's ordering: start_service, submit instances,
service_started; stop_service BEFORE procd_kill. No host network is modified.
"""
import os
from pathlib import Path
import subprocess
import unittest
from importlib.util import spec_from_file_location, module_from_spec

ROOT = Path(__file__).resolve().parents[1]
spec = spec_from_file_location('shell_fixture', Path(__file__).with_name('shell-regression-test.py'))
fixture = module_from_spec(spec)
spec.loader.exec_module(fixture)


class LifecycleTests(unittest.TestCase):
    setUp = fixture.ShellTests.setUp
    executable = fixture.ShellTests.executable
    set_uci = fixture.ShellTests.set_uci

    def run_init(self, action, scenario='', running=False, target=None):
        self.set_uci(**{'bettbox.config.enabled': '1', 'bettbox.config.watchdog': '0'})
        self.env.update(BETTBOX_TEST_SCENARIO=scenario, BETTBOX_TEST_RUN=self.run.as_posix())
        if running:
            (self.run / 'alive').touch()
            (self.run / 'config.yaml').write_text('old-valid-config\n')
        for name in ('firewall', 'dnsmasq', 'cron'):
            self.executable(name, '''echo "%s $1" >> "$BETTBOX_TEST_CALLS"
case "$BETTBOX_TEST_SCENARIO:%s:$1" in
 firewall-fail:firewall:start|dns-fail:dnsmasq:apply|restore-fail:dnsmasq:restore) exit 1 ;;
esac
exit 0''' % (name, name))
        self.executable('render', '''echo validate >> "$BETTBOX_TEST_CALLS"
[ "$BETTBOX_TEST_SCENARIO" != invalid ] || exit 1
echo new-valid-config > "$BETTBOX_TEST_RUN/config.yaml"''')
        self.executable('ucode', '''shift
echo "core $*" >> "$BETTBOX_TEST_CALLS"
case "$1" in
 target) if [ "$2" = current ]; then cat "$BETTBOX_TEST_RUN/selector" 2>/dev/null || echo package; else echo none; fi ;;
 validate) [ "$BETTBOX_TEST_SCENARIO" != core-invalid ] ;;
 select) [ "$BETTBOX_TEST_SCENARIO" != select-fail ] || exit 1; echo "$2" > "$BETTBOX_TEST_RUN/selector" ;;
 restore) echo "$2" > "$BETTBOX_TEST_RUN/selector" ;;
esac''')
        self.executable('date', '''n=$(cat "$BETTBOX_TEST_RUN/clock" 2>/dev/null || echo 0)
n=$((n+10)); echo "$n" > "$BETTBOX_TEST_RUN/clock"; echo "$n"''')
        source = (ROOT / 'bettbox/files/etc/init.d/bettbox').read_text(encoding='utf-8')
        source = source.replace('RUN_DIR=/var/run/bettbox', 'RUN_DIR="' + self.run.as_posix() + '"')
        source = source.replace('/usr/libexec/bettbox/common.sh', '"' + (self.folder / 'common.sh').as_posix() + '"')
        source = source.replace('/usr/bin/bettbox apply', '"' + (self.bin / 'render').as_posix() + '"')
        source = source.replace('/proc/net/udp', (self.folder / 'proc/net/udp').as_posix())
        source = source.replace('/proc/"$pid"/fd', self.folder.as_posix() + '/proc/"$pid"/fd')
        source = source.replace('"$RUN_DIR" /etc/bettbox/profiles /etc/bettbox/scripts /etc/bettbox/geo /etc/bettbox/state', '"$RUN_DIR"')
        for name in ('firewall', 'dnsmasq', 'cron'):
            source = source.replace('/usr/libexec/bettbox/' + name + '.sh', '"' + (self.bin / name).as_posix() + '"')
        prefix = self.bin.as_posix()
        if os.name == 'nt':
            prefix = '/' + prefix[0].lower() + prefix[2:]
        shim = '''
procd_lock() { :; }
procd_open_instance() { echo "register $1" >> "$BETTBOX_TEST_CALLS"; }
procd_set_param() { :; }
procd_close_instance() { :; }
procd_running() { [ -f "$BETTBOX_TEST_RUN/alive" ]; }
procd_kill() { echo kill >> "$BETTBOX_TEST_CALLS"; rm -f "$BETTBOX_TEST_RUN/alive"; }
start() {
 start_service
 # rc.common does not propagate start_service's exit status on its own.
 if [ "$BETTBOX_START_REQUESTED" = 1 ]; then touch "$BETTBOX_TEST_RUN/alive"; fi
 service_started
}
stop() { stop_service; procd_kill; }
bettbox_uptime() { date +%s; }
bettbox_core_pid() { echo 123; }
bettbox_core_ready() {
 echo probe >> "$BETTBOX_TEST_CALLS"
 case "$BETTBOX_TEST_SCENARIO" in
  not-ready|changed-network) return 1 ;;
  rollback) grep -q old-valid-config "$BETTBOX_TEST_RUN/config.yaml"; return $? ;;
  core-fail) [ "$(cat "$BETTBOX_TEST_RUN/selector" 2>/dev/null)" = package ]; return $? ;;
  delayed)
   n=$(cat "$BETTBOX_TEST_RUN/probes" 2>/dev/null || echo 0); n=$((n+1))
   echo "$n" > "$BETTBOX_TEST_RUN/probes"; [ "$n" -ge 3 ]; return $? ;;
 esac
 return 0
}
if [ -f "$BETTBOX_TEST_RUN/alive" ]; then
 bettbox_network_settings > "$BETTBOX_TEST_RUN/network-settings"
 [ "$BETTBOX_TEST_SCENARIO" != changed-network ] || echo different-listener > "$BETTBOX_TEST_RUN/network-settings"
fi
if [ "$1" = probe_dns ]; then bettbox_dns_ready; else "$@"; fi
'''
        script = self.folder / 'init-fixture.sh'
        script.write_text('PATH="' + prefix + ':$PATH"\n' + source + shim, encoding='utf-8', newline='\n')
        result = subprocess.run([self.shell, script.as_posix(), action] + ([target] if target else []), env=self.env,
                                text=True, encoding='utf-8', capture_output=True)
        calls = self.calls.read_text().splitlines() if self.calls.exists() else []
        return result, calls

    def test_initial_start_waits_before_network_takeover(self):
        result, calls = self.run_init('start')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(calls.index('register core'), calls.index('probe'))
        self.assertLess(calls.index('probe'), calls.index('firewall start'))
        self.assertLess(calls.index('firewall start'), calls.index('dnsmasq apply'))
        self.assertTrue((self.run / 'ready').exists())

    def test_delayed_readiness_never_installs_rules_early(self):
        result, calls = self.run_init('start', 'delayed')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls.count('probe'), 3)
        self.assertGreater(calls.index('firewall start'), max(i for i, call in enumerate(calls) if call == 'probe'))

    def test_readiness_timeout_releases_without_installing_rules(self):
        result, calls = self.run_init('start', 'not-ready')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('firewall start', calls)
        self.assertNotIn('dnsmasq apply', calls)
        self.assertEqual(calls[-3:], ['dnsmasq restore', 'firewall stop', 'kill'])
        self.assertFalse((self.run / 'alive').exists())

    def test_firewall_failure_never_redirects_dns(self):
        result, calls = self.run_init('start', 'firewall-fail')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('dnsmasq apply', calls)
        self.assertEqual(calls[-3:], ['dnsmasq restore', 'firewall stop', 'kill'])

    def test_dns_failure_rolls_back_network_and_new_core(self):
        result, calls = self.run_init('start', 'dns-fail')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('dnsmasq apply', calls)
        self.assertEqual(calls[-3:], ['dnsmasq restore', 'firewall stop', 'kill'])
        self.assertFalse((self.run / 'ready').exists())

    def test_stop_restores_dns_before_removing_rules_and_core(self):
        result, calls = self.run_init('stop', running=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, ['dnsmasq restore', 'firewall stop', 'kill'])

    def test_stop_does_not_kill_dns_provider_if_restore_fails(self):
        result, calls = self.run_init('stop', 'restore-fail', running=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('kill', calls)
        self.assertTrue((self.run / 'alive').exists())

    def test_invalid_restart_keeps_old_instance_and_config(self):
        result, calls = self.run_init('restart', 'invalid', running=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, ['validate'])
        self.assertTrue((self.run / 'alive').exists())
        self.assertEqual((self.run / 'config.yaml').read_text(), 'old-valid-config\n')

    def test_restart_validates_once_before_old_instance_stops(self):
        result, calls = self.run_init('restart', running=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls.count('validate'), 1)
        self.assertLess(calls.index('validate'), calls.index('kill'))
        self.assertLess(calls.index('kill'), calls.index('register core'))

    def test_failed_new_core_recovers_last_validated_runtime(self):
        result, calls = self.run_init('restart', 'rollback', running=True)
        self.assertNotEqual(result.returncode, 0, 'recovered old core is still a failed requested update')
        self.assertEqual(calls.count('validate'), 1)
        self.assertEqual(calls.count('register core'), 2)
        self.assertEqual((self.run / 'config.yaml').read_text(), 'old-valid-config\n')
        self.assertTrue((self.run / 'ready').exists())
        self.assertTrue((self.run / 'alive').exists())
        self.assertEqual(list(self.run.glob('previous.*')), [])

    def test_invalid_initial_start_does_not_take_over(self):
        result, calls = self.run_init('start', 'invalid')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, ['validate'])
        self.assertFalse((self.run / 'alive').exists())

    def test_changed_network_parameters_do_not_reapply_old_core_with_new_rules(self):
        result, calls = self.run_init('restart', 'changed-network', running=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls.count('register core'), 1)
        self.assertFalse((self.run / 'alive').exists())
        self.assertFalse((self.run / 'ready').exists())

    def test_reload_uses_same_prevalidated_restart(self):
        result, calls = self.run_init('reload_service', running=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls.count('validate'), 1)
        self.assertLess(calls.index('validate'), calls.index('kill'))

    def dns_fixture(self, owner):
        (self.folder / 'proc/net').mkdir(parents=True)
        (self.folder / 'proc/123/fd').mkdir(parents=True)
        (self.folder / 'proc/123/fd/7').touch()
        (self.folder / 'proc/net/udp').write_text('0: 00000000:041D 00000000:0000 07 0:0 00:0 0 0 0 42\n')
        self.executable('readlink', 'echo "socket:[' + str(owner) + ']"')

    def test_dns_readiness_accepts_core_owned_socket_without_ipv6_proc_file(self):
        self.dns_fixture(42)
        result, _ = self.run_init('probe_dns')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_dns_readiness_rejects_another_process_on_same_port(self):
        self.dns_fixture(99)
        result, _ = self.run_init('probe_dns')
        self.assertNotEqual(result.returncode, 0)

    def test_dns_readiness_rejects_wrong_listener_port(self):
        self.dns_fixture(42)
        (self.folder / 'proc/net/udp').write_text('0: 00000000:0035 00000000:0000 07 0:0 00:0 0 0 0 42\n')
        result, _ = self.run_init('probe_dns')
        self.assertNotEqual(result.returncode, 0)

    def test_core_switch_validates_candidate_before_stopping(self):
        target='releases/v1.19.33-arm64-aaaa'
        result,calls=self.run_init('core_switch',running=True,target=target)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertLess(calls.index('core validate '+target),calls.index('kill'))
        self.assertLess(calls.index('kill'),calls.index('core select '+target))
        self.assertEqual(calls.count('validate'),1)
        self.assertTrue((self.run/'alive').exists())

    def test_core_switch_keeps_stopped_service_stopped(self):
        result,calls=self.run_init('core_switch',target='package')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertNotIn('validate',calls)
        self.assertNotIn('register core',calls)
        self.assertFalse((self.run/'alive').exists())

    def test_core_switch_rejects_bad_config_before_network_changes(self):
        result,calls=self.run_init('core_switch','core-invalid',running=True,target='package')
        self.assertNotEqual(result.returncode,0)
        self.assertNotIn('kill',calls)
        self.assertTrue((self.run/'alive').exists())

    def test_core_switch_recovers_previous_binary_after_failed_start(self):
        result,calls=self.run_init('core_switch','core-fail',running=True,target='releases/v1.19.33-arm64-aaaa')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('core restore package none',calls)
        self.assertEqual((self.run/'selector').read_text().strip(),'package')
        self.assertTrue((self.run/'alive').exists())
        self.assertTrue((self.run/'ready').exists())

    def test_core_selector_write_failure_recovers_original_selection(self):
        result,calls=self.run_init('core_switch','select-fail',running=True,target='package')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('core restore package none',calls)
        self.assertTrue((self.run/'alive').exists())

    def test_apk_hook_environment_cannot_implicitly_stop_or_restart_core(self):
        self.env['BETTBOX_SELF_UPDATE'] = '1'
        result, calls = self.run_init('restart', running=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [])
        self.assertTrue((self.run / 'alive').exists())


if __name__ == '__main__':
    unittest.main()
