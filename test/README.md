# Source and browser checks

These checks do not compile packages or Rust. Run from the repository root with Node.js 22+ and Python 3. Shell regressions also require Bash/POSIX utilities (Git Bash works on Windows).

```sh
npm ci --prefix test
npm test --prefix test
python test/cron-test.py
python test/router-settings-test.py
python test/shell-regression-test.py
python test/service-lifecycle-test.py
python test/package-layout-test.py
python test/release-manifest-test.py
```

The render, RPC, worker and core updater tests emulate ucode builtins under Node; they do not replace native ucode or router validation. Shell tests use isolated configuration, service and archive fixtures. Core updater fixtures use real gzip and SHA-256 data with controlled processes, and never download or run an executable. The lifecycle harness also exercises the production core switch shell ordering and recovery with a stubbed procd/core helper. See [core update behavior and limits](../docs/CORE_UPDATE.md).

`forge-contract-test.js` executes the production Rust source's JS wrappers under Node, including option extraction and the profile fixture. It does not exercise QuickJS's allocator or the Rust CLI. `package-layout-test.py` uses GNU Make dry runs with SDK hook stubs to check that both Go/Rust compile hooks survive, both binaries are packaged, and the former helper's dependency/file handover metadata is retained. These checks do not compile. On Windows, set `BETTBOX_TEST_MAKE` to GNU Make and `BETTBOX_TEST_SHELL` to Git Bash's `sh.exe` if they are not on PATH.

Native helper unit tests (including timeout/OOM/recursion/Promise cases) and CLI integration tests are under `bettbox/forge/`. They require compilation and are a separate opt-in command:

```sh
cargo test --locked --manifest-path bettbox/forge/Cargo.toml
```

The manual CI runs them before the SDK package builds. See [migration and acceptance limits](../docs/FORGE_MIGRATION.md).

For browser checks, use an installed Edge/Chromium executable, or install Playwright Chromium with `npx --prefix test playwright install chromium`:

```powershell
$env:BETTBOX_BROWSER = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
# Optional: load the host theme to check CSS interactions.
$env:BETTBOX_THEME_CSS = 'D:\WorkSpace\Github\Z_luci_ui\luci-theme-zen\htdocs\luci-static\zen\theme.css'
npm run test:browser --prefix test
```

Browser fixtures execute the production LuCI views/components/styles with controlled transports. They never connect to a router. Screenshots are generated in ignored `dist/implementation/`.

`resources-core-test.cjs` covers core and APK update cards at seven widths, dark mode, asynchronous completion, RPC reconnect, version comparisons, failure recovery and stopped/unsupported/busy states.

`package-update-test.js` runs the production ucode with controlled filesystem/process/network fixtures and real SHA-256. `release-manifest-test.py` replaces native APK and GitHub responses while checking feed assembly and draft publication gates. `package-layout-test.py` also exercises postinst hooks with isolated paths and a mocked cache-removal command. These tests do not install APKs or publish releases. See [APK update behavior and remaining native acceptance](../docs/APK_UPDATE.md).

`ui-browser-test.cjs`, `router-smoke.sh` and `full-feature-test.sh` are opt-in real-device checks. Read their setup and side effects before running; never commit router sessions, backups or credentials. The browser integration test requires `BETTBOX_URL` and a private `BETTBOX_STORAGE_STATE`, as described in [the UI implementation record](../docs/UI_IMPLEMENTATION.md).
