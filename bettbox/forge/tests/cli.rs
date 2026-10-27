// SPDX-License-Identifier: GPL-3.0
// Native integration checks for `cargo test`, independent of the router/SDK.
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new(script: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "bettbox-forge-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("script.js"), script).unwrap();
        std::fs::write(path.join("config.json"), r#"{"mode":"rule"}"#).unwrap();
        Self(path)
    }

    fn command(&self, mode: &str, extra: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_bettbox-forge"))
            .current_dir(&self.0)
            .args([mode, "--script", "script.js"])
            .args(extra)
            .output()
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Only this fixture's newly created private directory is removed.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn run_stdout_is_json_and_console_goes_to_stderr() {
    let f = Fixture::new("function main(c, o){ console.log('hello'); c.flag=o.flag; return c }");
    let result = f.command(
        "run",
        &["--config", "config.json", "--options", r#"{"flag":true}"#],
    );
    assert!(result.status.success(), "{:?}", result);
    let config: Value = serde_json::from_slice(&result.stdout).unwrap();
    let logs: Value = serde_json::from_slice(&result.stderr).unwrap();
    assert_eq!(config["flag"], json!(true));
    assert_eq!(logs["logs"], json!(["log: hello"]));
}

#[test]
fn output_file_and_option_extraction_keep_the_cli_contract() {
    let f = Fixture::new("const ruleOptionsEnable={ads:true}; const serviceConfigs=[{name:'AI',icon:'ai.svg'}]; function main(c){c.mode='direct';return c}");
    let result = f.command("run", &["--config", "config.json", "--out", "out.json"]);
    assert!(result.status.success());
    assert!(result.stdout.is_empty());
    let config: Value =
        serde_json::from_slice(&std::fs::read(f.0.join("out.json")).unwrap()).unwrap();
    assert_eq!(config["mode"], json!("direct"));
    let result = f.command("options", &[]);
    assert!(result.status.success());
    let options: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(options["options"]["ads"], json!(true));
    assert_eq!(options["icons"]["AI"], json!("ai.svg"));
}

#[test]
fn failed_script_does_not_write_output_and_returns_structured_error() {
    let f = Fixture::new("function main( {");
    let result = f.command("run", &["--config", "config.json", "--out", "out.json"]);
    assert!(!result.status.success());
    assert!(result.stdout.is_empty());
    assert!(!f.0.join("out.json").exists());
    let error: Value = serde_json::from_slice(&result.stderr).unwrap();
    assert_eq!(error["error"]["kind"], json!("Syntax"));
}

#[test]
fn timeout_returns_124_and_preserves_existing_output() {
    let f = Fixture::new("function main(){while(true){}}");
    std::fs::write(f.0.join("out.json"), "previous").unwrap();
    let result = f.command(
        "run",
        &[
            "--config",
            "config.json",
            "--timeout",
            "1",
            "--out",
            "out.json",
        ],
    );
    assert_eq!(result.status.code(), Some(124));
    assert_eq!(
        std::fs::read_to_string(f.0.join("out.json")).unwrap(),
        "previous"
    );
    let error: Value = serde_json::from_slice(&result.stderr).unwrap();
    assert_eq!(error["error"]["kind"], json!("Timeout"));
}

#[test]
fn invalid_arguments_and_version_have_stable_exit_codes() {
    let result = Command::new(env!("CARGO_BIN_EXE_bettbox-forge"))
        .arg("version")
        .output()
        .unwrap();
    assert!(result.status.success());
    assert_eq!(
        String::from_utf8(result.stdout).unwrap().trim(),
        env!("CARGO_PKG_VERSION")
    );
    let result = Command::new(env!("CARGO_BIN_EXE_bettbox-forge"))
        .arg("unknown")
        .output()
        .unwrap();
    assert_eq!(result.status.code(), Some(2));
}
