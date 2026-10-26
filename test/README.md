# Source and browser checks

These checks do not compile packages or Rust. Run from the repository root with Node.js 22+ and Python 3. Shell regressions also require Bash/POSIX utilities (Git Bash works on Windows).

```sh
npm ci --prefix test
npm test --prefix test
python test/cron-test.py
python test/router-settings-test.py
python test/shell-regression-test.py
```

The render test emulates ucode builtins under Node; it does not replace native ucode or router validation. Shell tests use isolated configuration, service and archive fixtures.

For browser checks, use an installed Edge/Chromium executable, or install Playwright Chromium with `npx --prefix test playwright install chromium`:

```powershell
$env:BETTBOX_BROWSER = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
# Optional: load the host theme to check CSS interactions.
$env:BETTBOX_THEME_CSS = 'D:\WorkSpace\Github\Z_luci_ui\luci-theme-zen\htdocs\luci-static\zen\theme.css'
npm run test:browser --prefix test
```

Browser fixtures execute the production LuCI views/components/styles with controlled transports. They never connect to a router. Screenshots are generated in ignored `dist/implementation/`.

`ui-browser-test.cjs`, `router-smoke.sh` and `full-feature-test.sh` are opt-in real-device checks. Read their setup and side effects before running; never commit router sessions, backups or credentials. The browser integration test requires `BETTBOX_URL` and a private `BETTBOX_STORAGE_STATE`, as described in [the UI implementation record](../docs/UI_IMPLEMENTATION.md).
