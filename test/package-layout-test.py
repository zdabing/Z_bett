"""Expand the real merged package recipes with GNU Make and SDK hook stubs.

Only dry-run recipes are inspected. No compiler, cargo build, or APK install is
run. Stubs intentionally mimic the competing Rust/Go default compile hooks.
"""
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class PackageLayoutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.make = os.environ.get('BETTBOX_TEST_MAKE') or shutil.which('make') or shutil.which('mingw32-make')
        self.assertTrue(self.make, 'GNU Make is required (BETTBOX_TEST_MAKE may select it)')
        shell = os.environ.get('BETTBOX_TEST_SHELL') or shutil.which('sh')
        self.assertTrue(shell, 'POSIX shell is required for the package timestamp')
        self.shell = shell
        self.write('rules.mk', 'SHELL := ' + Path(shell).as_posix() + '\nBUILD_DIR := fixture-build\n'
                   'INCLUDE_DIR := $(TOPDIR)/include\nCONFIG_USE_APK := y\n'
                   'TARGET_AR := target-ar\nPKG_INSTALL_DIR := fixture-install\n')
        self.write('include/package.mk', '''
define Build/Prepare/Default
\t@echo UNPACK_GO
endef
define BuildPackage
$$(eval $$(Package/$(1)))
APK_INFO_$(1):=
endef
INSTALL_DIR := install -d
INSTALL_BIN := install -m755
INSTALL_CONF := install -m600
CP := cp -r
''')
        self.write('feeds/packages/lang/rust/rust-package.mk', '''
define Build/Compile/Cargo
\t@echo CARGO_COMPILE path=$(1) locked=$(RUST_PKG_LOCKED) $(CARGO_PKG_VARS)
endef
Build/Compile=$(call Build/Compile/Cargo)
''')
        self.write('feeds/packages/lang/golang/golang-package.mk', '''
define GoPackage/Build/Compile
\t@echo GO_COMPILE
endef
define GoPackage/Build/Configure
\t@echo GO_CONFIGURE
endef
Build/Compile=$(call GoPackage/Build/Compile)
Build/Configure=$(call GoPackage/Build/Configure)
GO_PKG_BUILD_BIN_DIR := go-output
define GoBinPackage
endef
''')
        self.write('fixture.mk', 'TOPDIR := ' + self.folder.as_posix() + '\n'
                   'include ' + (ROOT / 'bettbox/Makefile').as_posix() + '''
fixture_compile:
\t$(Build/Compile)
fixture_configure:
\t$(Build/Configure)
fixture_prepare:
\t$(Build/Prepare)
fixture_install:
\t$(call Package/bettbox/install,package-output)
fixture_metadata:
\t@echo PROVIDES=$(PROVIDES)
\t@echo APK=$(APK_INFO_bettbox)
\t@echo DEPS=$(DEPENDS)
\t@echo CACHE=$(PKG_FILE_DEPENDS)
''')

    def write(self, name, value):
        path = self.folder / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value, encoding='utf-8', newline='\n')

    def recipe(self, target):
        result = subprocess.run([self.make, '--no-print-directory', '-n', '-f',
                                 str(self.folder / 'fixture.mk'), 'fixture_' + target],
                                cwd=ROOT, capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_go_and_rust_compile_once_in_order(self):
        text = self.recipe('compile')
        self.assertEqual(text.count('echo GO_COMPILE'), 1)
        self.assertEqual(text.count('echo CARGO_COMPILE'), 1)
        self.assertLess(text.index('echo GO_COMPILE'), text.index('echo CARGO_COMPILE'))
        self.assertIn('path=.bettbox-forge locked=1', text)
        self.assertIn('TARGET_AR="target-ar"', text)

    def test_go_configure_is_not_replaced_by_rust(self):
        self.assertIn('GO_CONFIGURE', self.recipe('configure'))

    def test_prepare_unpacks_go_and_copies_the_helper(self):
        text = self.recipe('prepare')
        self.assertLess(text.index('UNPACK_GO'), text.index('cp -r ./forge'))
        self.assertIn('/.bettbox-forge', text)
        self.assertIn('./forge/Cargo.toml ./forge/Cargo.lock ./forge/src ./forge/tests', text)
        self.assertNotIn('cp -r ./forge ', text, 'never copy the host target/cache into SDK sources')
        self.assertIn('CACHE=./forge/Cargo.toml ./forge/Cargo.lock ./forge/src ./forge/tests', self.recipe('metadata'))

    def test_core_package_owns_both_executables(self):
        text = self.recipe('install')
        self.assertIn('go-output/mihomo package-output/usr/bin/mihomo', text)
        self.assertIn('fixture-install/bin/bettbox-forge package-output/usr/bin/bettbox-forge', text)

    def test_legacy_dependency_and_file_handover_metadata_survive_expansion(self):
        text = self.recipe('metadata')
        self.assertIn('PROVIDES=mihomo clash-meta bettbox-forge', text)
        self.assertIn('APK=--info "replaces:bettbox-forge"', text)
        self.assertIn('@(aarch64||x86_64)', text)

    def test_old_helper_is_not_a_separate_feed_package_or_luci_dependency(self):
        self.assertFalse((ROOT / 'bettbox-forge/Makefile').exists())
        source = (ROOT / 'luci-app-bettbox/Makefile').read_text(encoding='utf-8')
        depends = next(line for line in source.splitlines() if line.startswith('LUCI_DEPENDS:='))
        self.assertEqual(depends, 'LUCI_DEPENDS:=+luci-base +bettbox')

    def hook(self, package, updating):
        calls = self.folder / 'hook-calls'
        self.write('config', 'config core config\n')
        self.write('migration.sh', '#!/bin/sh\necho migrate >> "$BETTBOX_HOOK_CALLS"\n')
        self.write('cli.sh', '#!/bin/sh\necho "cli $*" >> "$BETTBOX_HOOK_CALLS"\n')
        self.write('core.sh', '#!/bin/sh\n[ "$1" != enabled ] || exit 0\necho "core $*" >> "$BETTBOX_HOOK_CALLS"\n')
        self.write('rpcd.sh', '#!/bin/sh\necho "rpcd $*" >> "$BETTBOX_HOOK_CALLS"\n')
        for path in self.folder.glob('*.sh'):
            path.chmod(0o755)
        source = (ROOT / package / 'Makefile').read_text(encoding='utf-8')
        body = re.search(r'define Package/' + re.escape(package) + r'/postinst\n(.*?)\nendef', source, re.S)[1]
        body = body.replace('$$', '$')
        for old, new in [('/etc/config/bettbox', 'config'), ('/usr/libexec/bettbox/router-settings.sh', 'migration.sh'),
                         ('/usr/bin/bettbox', 'cli.sh'), ('/etc/init.d/bettbox', 'core.sh'), ('/etc/init.d/rpcd', 'rpcd.sh')]:
            body = body.replace(old, '"' + (self.folder / new).as_posix() + '"')
        # Never delete real host cache files when executing LuCI's hook fixture.
        self.write('hook.sh', '#!/bin/sh\nrm(){ :; }\n' + body)
        env = dict(os.environ, BETTBOX_SELF_UPDATE='1' if updating else '0', IPKG_INSTROOT='',
                   BETTBOX_HOOK_CALLS=str(calls))
        result = subprocess.run([self.shell, str(self.folder / 'hook.sh')], env=env, capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stderr)
        return calls.read_text().splitlines() if calls.exists() else []

    def test_self_update_core_hook_migrates_without_implicit_restart(self):
        self.assertEqual(self.hook('bettbox', True), ['migrate'])

    def test_regular_core_install_keeps_existing_migrate_and_restart_behavior(self):
        self.assertEqual(self.hook('bettbox', False), ['migrate', 'cli apply', 'core restart'])

    def test_self_update_luci_hook_defers_rpcd_reload(self):
        self.assertEqual(self.hook('luci-app-bettbox', True), [])
        self.assertEqual(self.hook('luci-app-bettbox', False), ['rpcd reload'])


if __name__ == '__main__':
    unittest.main()
