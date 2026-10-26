"""Exercise the real CLI and cron scripts with isolated files and services."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
LIBEXEC = ROOT / 'bettbox/files/usr/libexec/bettbox'
CURRENT = '*/10 * * * * /usr/bin/bettbox cron'
LEGACY = '*/10 * * * * /usr/bin/bettbox subscription cron'
OTHER = '*/15 * * * * /root/mijia-guard.sh'


class CronTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.folder = Path(self.directory.name)
        self.shell = os.environ.get('BETTBOX_TEST_SHELL') or shutil.which('bash') or shutil.which('sh')
        self.assertTrue(self.shell, 'A POSIX shell is required')
        self.table = self.folder / 'crontabs/root'
        self.calls = self.folder / 'service-calls'
        self.args = self.folder / 'subscription-args'
        self.env = dict(os.environ, MSYS_NO_PATHCONV='1',
                        BETTBOX_TEST_CALLS=self.calls.as_posix(),
                        BETTBOX_TEST_ARGS=self.args.as_posix())
        (self.folder / 'common.sh').write_text('', encoding='utf-8')
        service = self.folder / 'cron-service'
        service.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$BETTBOX_TEST_CALLS"\n',
                           encoding='utf-8', newline='\n')
        service.chmod(0o755)
        source = (LIBEXEC / 'cron.sh').read_text(encoding='utf-8')
        source = source.replace('/usr/libexec/bettbox/common.sh',
                                '"' + (self.folder / 'common.sh').as_posix() + '"')
        source = source.replace('CRONTAB=/etc/crontabs/root',
                                'CRONTAB="' + self.table.as_posix() + '"')
        source = source.replace('/etc/init.d/cron', '"' + service.as_posix() + '"')
        self.script = self.folder / 'cron.sh'
        self.script.write_text(source, encoding='utf-8', newline='\n')

    def run_cron(self, action):
        result = subprocess.run([self.shell, self.script.as_posix(), action],
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def write_table(self, text):
        self.table.parent.mkdir(parents=True, exist_ok=True)
        self.table.write_text(text, encoding='utf-8', newline='\n')

    def test_ensure_migrates_legacy_and_preserves_other_jobs(self):
        self.write_table('# other tasks\n' + OTHER + '\n' + LEGACY + '\n')
        self.run_cron('ensure')
        self.assertEqual(self.table.read_text(), '# other tasks\n' + OTHER + '\n' + CURRENT + '\n')
        self.assertEqual(self.calls.read_text(), 'restart\n')
        self.run_cron('ensure')
        self.assertEqual(self.calls.read_text(), 'restart\n', 'Unchanged cron must not restart')

    def test_ensure_deduplicates_old_and_new_jobs(self):
        self.write_table('\n'.join([CURRENT, LEGACY, CURRENT, OTHER]) + '\n')
        self.run_cron('ensure')
        self.assertEqual(self.table.read_text(), OTHER + '\n' + CURRENT + '\n')

    def test_comment_does_not_count_as_installed_job(self):
        self.write_table('# ' + CURRENT + '\n')
        self.run_cron('ensure')
        self.assertEqual(self.table.read_text(), '# ' + CURRENT + '\n' + CURRENT + '\n')

    def test_ensure_creates_missing_crontab(self):
        self.run_cron('ensure')
        self.assertEqual(self.table.read_text(), CURRENT + '\n')

    def test_remove_last_job_accepts_empty_grep_result(self):
        for entry in (CURRENT, LEGACY):
            with self.subTest(entry=entry):
                self.write_table(entry + '\n')
                self.run_cron('remove')
                self.assertEqual(self.table.read_text(), '')

    def test_remove_preserves_other_jobs_and_is_idempotent(self):
        self.write_table('\n'.join([OTHER, LEGACY, CURRENT]) + '\n')
        self.run_cron('remove')
        self.assertEqual(self.table.read_text(), OTHER + '\n')
        self.run_cron('remove')
        self.assertEqual(self.calls.read_text(), 'restart\n')

    def test_remove_missing_crontab_is_noop(self):
        self.run_cron('remove')
        self.assertFalse(self.table.exists())
        self.assertFalse(self.calls.exists())

    def test_cli_accepts_canonical_and_legacy_cron_commands(self):
        dispatcher = (ROOT / 'bettbox/files/usr/bin/bettbox').read_text(encoding='utf-8')
        dispatcher = dispatcher.replace('LIBEXEC=/usr/libexec/bettbox',
                                        'LIBEXEC="' + self.folder.as_posix() + '"')
        cli = self.folder / 'bettbox'
        cli.write_text(dispatcher, encoding='utf-8', newline='\n')
        (self.folder / 'subscription.sh').write_text(
            '#!/bin/sh\nprintf "%s\\n" "$@" > "$BETTBOX_TEST_ARGS"\n',
            encoding='utf-8', newline='\n')
        for args in (['cron'], ['subscription', 'cron'], ['subscriptions', 'cron']):
            with self.subTest(args=args):
                result = subprocess.run([self.shell, cli.as_posix(), *args],
                                        env=self.env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.args.read_text(), 'cron\n')


if __name__ == '__main__':
    unittest.main()
