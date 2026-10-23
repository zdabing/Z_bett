// SPDX-License-Identifier: GPL-3.0
//
// bettbox-forge: Bettbox JS override script sandbox for OpenWrt.
//
// CLI port of upstream Bettbox `plugins/code_forge/rust` (rquickjs/QuickJS).
// The script contract is kept 1:1:
//   - the profile config is exported as JSON, key "rule" renamed to "rules",
//     "proxy-providers" defaulting to {}
//   - the engine calls main(config); custom toggles are Object.assign'd into
//     the script's global `ruleOptionsEnable` before the call
//   - a returned object (or a settled Promise of one) replaces the config,
//     anything else keeps the input
//   - `options` mode reads `ruleOptionsEnable`, `serviceConfigs` icons and
//     `Compatible_With_Bettbox.policyGroupOptions`
//
// Engine: boa (pure Rust) instead of QuickJS — see README "Rust 怎么选".
// Sandboxing: loop-iteration/recursion limits plus a wall-clock watchdog
// thread (upstream also capped the QuickJS heap; boa has no public heap cap,
// this is the one documented deviation).

use boa_engine::{Context, JsString, Source, property::Attribute};
use serde_json::{Map, Value as Json};
use std::io::Write as _;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, Instant};

const RUN_TIMEOUT: Duration = Duration::from_secs(10);
const RUN_TIMEOUT_OVERRIDE_MAX: Duration = Duration::from_secs(60);
const OPTIONS_TIMEOUT: Duration = Duration::from_secs(2);
const LOOP_ITERATION_LIMIT: usize = 50_000_000;
const RECURSION_LIMIT: usize = 512;
const MAX_LOG_LINES: usize = 200;

const EXTRACT_OPTIONS: &str = r#"
;var __options = typeof ruleOptionsEnable !== 'undefined' && ruleOptionsEnable && typeof ruleOptionsEnable === 'object' ? ruleOptionsEnable : {};
var __icons = {};
if (typeof serviceConfigs !== 'undefined' && Array.isArray(serviceConfigs)) {
  for (var __i = 0; __i < serviceConfigs.length; __i++) {
    var __service = serviceConfigs[__i];
    if (__service && __service.name && typeof __service.icon === 'string') {
      __icons[__service.name] = __service.icon;
    }
  }
}
var __groups = [];
if (typeof Compatible_With_Bettbox !== 'undefined' && Compatible_With_Bettbox && Array.isArray(Compatible_With_Bettbox.policyGroupOptions)) {
  var __declared = Compatible_With_Bettbox.policyGroupOptions;
  for (var __j = 0; __j < __declared.length; __j++) {
    if (typeof __declared[__j] === 'string') {
      __groups.push(__declared[__j]);
    }
  }
}
return JSON.stringify({ options: __options, icons: __icons, policyGroupOptions: __groups });
"#;

const PRELUDE: &str = r#"
globalThis.__LOGS = [];
const __fmt = (v) => { if (typeof v === 'string') return v; try { return JSON.stringify(v); } catch (e) { return String(v); } };
const __write = (lv, a) => { if (globalThis.__LOGS.length < 200) globalThis.__LOGS.push(lv + ": " + a.map(__fmt).join(" ")); };
globalThis.console = {
  log: (...a) => __write("log", a),
  info: (...a) => __write("info", a),
  warn: (...a) => __write("warn", a),
  error: (...a) => __write("error", a),
  debug: (...a) => __write("debug", a),
  trace: (...a) => __write("trace", a)
};
"#;

// Copies sandbox output (logs / captured error) into plain JSON strings on
// the global object so the Rust side only ever reads strings.
const EXPORT_GLOBALS: &str = r#"
globalThis.__LOGS_JSON = JSON.stringify(globalThis.__LOGS);
if (globalThis.__ERR) { globalThis.__ERR_JSON = JSON.stringify(globalThis.__ERR); }
"#;

#[derive(Clone, Copy, Debug, PartialEq)]
enum ErrorKind {
    Syntax,
    Runtime,
    Timeout,
    InvalidInput,
    InvalidOutput,
}

impl ErrorKind {
    fn as_str(self) -> &'static str {
        match self {
            ErrorKind::Syntax => "Syntax",
            ErrorKind::Runtime => "Runtime",
            ErrorKind::Timeout => "Timeout",
            ErrorKind::InvalidInput => "InvalidInput",
            ErrorKind::InvalidOutput => "InvalidOutput",
        }
    }
}

struct Failure {
    kind: ErrorKind,
    message: String,
    stack: Option<String>,
    logs: Vec<Json>,
}

impl Failure {
    fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            stack: None,
            logs: Vec::new(),
        }
    }

    fn to_json(&self) -> String {
        let mut error = Map::new();
        error.insert("kind".into(), Json::String(self.kind.as_str().to_owned()));
        error.insert("message".into(), Json::String(self.message.clone()));
        error.insert(
            "stack".into(),
            self.stack.clone().map(Json::String).unwrap_or(Json::Null),
        );
        error.insert("logs".into(), Json::Array(self.logs.clone()));
        let mut out = Map::new();
        out.insert("error".into(), Json::Object(error));
        serde_json::to_string(&Json::Object(out)).unwrap_or_else(|_| "{}".to_owned())
    }
}

/// Mirror of upstream `normalize` (mod.rs): `rule` -> `rules`,
/// `proxy-providers` defaulting to {}.
fn normalize(input: Json) -> Result<Map<String, Json>, Failure> {
    let Json::Object(source) = input else {
        return Err(Failure::new(
            ErrorKind::InvalidInput,
            "profile is not a JSON object",
        ));
    };
    let mut config = Map::with_capacity(source.len() + 1);
    for (key, value) in source {
        if key == "rule" {
            config.insert("rules".to_owned(), value);
        } else {
            config.insert(key, value);
        }
    }
    let providers = config
        .entry("proxy-providers")
        .or_insert_with(|| Json::Object(Map::new()));
    if providers.is_null() {
        *providers = Json::Object(Map::new());
    }
    Ok(config)
}

fn new_sandbox(timeout: Duration) -> Context {
    let mut context = Context::default();
    let limits = context.runtime_limits_mut();
    limits.set_loop_iteration_limit(LOOP_ITERATION_LIMIT as u64);
    limits.set_recursion_limit(RECURSION_LIMIT);
    start_watchdog(timeout);
    context
}

/// Wall-clock hard stop: upstream guarantees a 10s/2s ceiling; a watchdog
/// thread is the portable way to keep that guarantee.
fn start_watchdog(timeout: Duration) {
    let started = Arc::new(Instant::now());
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(50));
        if started.elapsed() >= timeout {
            let failure = Failure::new(ErrorKind::Timeout, "script timed out");
            let _ = writeln!(std::io::stderr(), "{}", failure.to_json());
            std::process::exit(124);
        }
    });
}

fn register_globals(context: &mut Context, config_json: &str, custom_json: Option<&str>) {
    let _ = context.register_global_property(
        JsString::from("__CONFIG_JSON"),
        JsString::from(config_json),
        Attribute::all(),
    );
    if let Some(custom) = custom_json {
        let _ = context.register_global_property(
            JsString::from("__CUSTOM_JSON"),
            JsString::from(custom),
            Attribute::all(),
        );
    }
}

fn eval_string(context: &mut Context, source: &str, kind: ErrorKind) -> Result<String, Failure> {
    let value = context
        .eval(Source::from_bytes(source.as_bytes()))
        .map_err(|error| Failure::new(kind, error.to_string()))?;
    match value.as_string() {
        Some(text) => Ok(text.to_std_string_escaped()),
        None => Err(Failure::new(kind, "expected a string result from script")),
    }
}

fn read_global_string(context: &mut Context, name: &str) -> Option<String> {
    let value = context
        .global_object()
        .get(JsString::from(name), context)
        .ok()?;
    value.as_string().map(|s| s.to_std_string_escaped())
}

fn collect_logs(context: &mut Context) -> Vec<Json> {
    read_global_string(context, "__LOGS_JSON")
        .and_then(|text| serde_json::from_str::<Json>(&text).ok())
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .take(MAX_LOG_LINES)
        .collect()
}

fn capture_err(context: &mut Context) -> Option<(String, Option<String>, Vec<Json>)> {
    let err = read_global_string(context, "__ERR_JSON")?;
    let parsed: Json = serde_json::from_str(&err).ok()?;
    match parsed {
        Json::Object(map) => {
            let message = map
                .get("message")
                .and_then(Json::as_str)
                .unwrap_or("script error")
                .to_owned();
            let stack = map.get("stack").and_then(Json::as_str).map(str::to_owned);
            Some((message, stack, Vec::new()))
        }
        _ => Some(("script error".to_owned(), None, Vec::new())),
    }
}

/// run mode: evaluate main(config) and return the resulting config JSON.
fn run(
    script: &str,
    config_bytes: &[u8],
    custom_options: Option<&str>,
    timeout: Duration,
) -> Result<(String, Vec<Json>), Failure> {
    let input: Json = serde_json::from_slice(config_bytes)
        .map_err(|error| Failure::new(ErrorKind::InvalidInput, error.to_string()))?;
    let config = Json::Object(normalize(input)?);
    let custom: Option<Json> = match custom_options {
        Some(text) if !text.trim().is_empty() => Some(
            serde_json::from_str(text)
                .map_err(|error| Failure::new(ErrorKind::InvalidInput, error.to_string()))?,
        ),
        _ => None,
    };
    let custom_json = custom
        .as_ref()
        .map(|value| serde_json::to_string(value))
        .transpose()
        .map_err(|error| Failure::new(ErrorKind::InvalidInput, error.to_string()))?;
    let config_json = serde_json::to_string(&config)
        .map_err(|error| Failure::new(ErrorKind::InvalidInput, error.to_string()))?;

    let mut context = new_sandbox(timeout);
    register_globals(&mut context, &config_json, custom_json.as_deref());

    // Phase 1: syntax check the script while defining the wrapper function
    // (upstream evaluates the wrapper, then calls it; same split here).
    let define = format!(
        "{PRELUDE}\nglobalThis.__FN = (function(__config, __custom) {{ {script}\n;if (__custom && typeof ruleOptionsEnable !== 'undefined') Object.assign(ruleOptionsEnable, __custom);\nreturn main(__config); }});"
    );
    context
        .eval(Source::from_bytes(define.as_bytes()))
        .map_err(|error| Failure::new(ErrorKind::Syntax, error.to_string()))?;

    // Phase 2: parse inputs (mirrors upstream convert::to_js failures).
    context
        .eval(Source::from_bytes(
            b"globalThis.__IN = JSON.parse(globalThis.__CONFIG_JSON); globalThis.__CUSTOM = globalThis.__CUSTOM_JSON == null ? null : JSON.parse(globalThis.__CUSTOM_JSON);",
        ))
        .map_err(|error| Failure::new(ErrorKind::InvalidInput, error.to_string()))?;

    // Phase 3: call, await promises, capture errors.
    context
        .eval(Source::from_bytes(
            b"(async () => { try { let __r = globalThis.__FN(globalThis.__IN, globalThis.__CUSTOM); if (__r && typeof __r.then === 'function') __r = await __r; if (__r && typeof __r === 'object' && !Array.isArray(__r)) globalThis.__RESULT = __r; } catch (e) { globalThis.__ERR = { message: String(e && e.message !== undefined ? e.message : e), stack: e && e.stack ? String(e.stack) : null }; } })()",
        ))
        .map_err(|error| Failure::new(ErrorKind::Runtime, error.to_string()))?;
    context
        .run_jobs()
        .map_err(|error| Failure::new(ErrorKind::Runtime, error.to_string()))?;
    context
        .eval(Source::from_bytes(EXPORT_GLOBALS.as_bytes()))
        .map_err(|error| Failure::new(ErrorKind::Runtime, error.to_string()))?;

    let logs = collect_logs(&mut context);
    if let Some((message, stack, _)) = capture_err(&mut context) {
        let message = if message.is_empty() {
            "script error".to_owned()
        } else {
            message
        };
        return Err(Failure {
            kind: ErrorKind::Runtime,
            message,
            stack,
            logs,
        });
    }

    // A settled plain object replaces the config; anything else keeps the
    // input (upstream: result not an object/array -> None).
    let output = eval_string(
        &mut context,
        "JSON.stringify(globalThis.__RESULT === undefined ? globalThis.__IN : globalThis.__RESULT)",
        ErrorKind::InvalidOutput,
    )?;
    let output: Json = serde_json::from_str(&output)
        .map_err(|error| Failure::new(ErrorKind::InvalidOutput, error.to_string()))?;
    let output = serde_json::to_string(&output)
        .map_err(|error| Failure::new(ErrorKind::InvalidOutput, error.to_string()))?;
    Ok((output, logs))
}

/// options mode: extract ruleOptionsEnable / serviceConfigs icons /
/// Compatible_With_Bettbox.policyGroupOptions (upstream EXTRACT_OPTIONS).
fn extract_options(script: &str, timeout: Duration) -> Result<(String, Vec<Json>), Failure> {
    let mut context = new_sandbox(timeout);
    let define = format!("{PRELUDE}\nglobalThis.__FN = (function() {{ {script}\n{EXTRACT_OPTIONS} }});");
    context
        .eval(Source::from_bytes(define.as_bytes()))
        .map_err(|error| Failure::new(ErrorKind::Syntax, error.to_string()))?;
    let value = context
        .eval(Source::from_bytes(b"globalThis.__FN()"))
        .map_err(|error| Failure::new(ErrorKind::Runtime, error.to_string()))?;
    context
        .eval(Source::from_bytes(EXPORT_GLOBALS.as_bytes()))
        .map_err(|error| Failure::new(ErrorKind::Runtime, error.to_string()))?;
    let logs = collect_logs(&mut context);
    let Some(text) = value.as_string() else {
        return Err(Failure::new(
            ErrorKind::InvalidOutput,
            "script options are not available",
        ));
    };
    let text = text.to_std_string_escaped();
    serde_json::from_str::<Json>(&text)
        .map_err(|error| Failure::new(ErrorKind::InvalidOutput, error.to_string()))?;
    Ok((text, logs))
}

struct Args {
    mode: String,
    script: Option<String>,
    config: Option<String>,
    options: Option<String>,
    timeout: Option<Duration>,
    out: Option<String>,
}

fn parse_args() -> Option<Args> {
    let mut it = std::env::args().skip(1);
    let mode = it.next()?;
    if mode == "version" {
        return Some(Args {
            mode,
            script: None,
            config: None,
            options: None,
            timeout: None,
            out: None,
        });
    }
    if mode != "run" && mode != "options" {
        return None;
    }
    let mut args = Args {
        mode,
        script: None,
        config: None,
        options: None,
        timeout: None,
        out: None,
    };
    while let Some(flag) = it.next() {
        let mut value = || it.next().filter(|v| !v.starts_with("--"));
        match flag.as_str() {
            "--script" => args.script = value(),
            "--config" => args.config = value(),
            "--options" => args.options = value(),
            "--timeout" => {
                args.timeout = value()
                    .and_then(|v| v.parse::<u64>().ok())
                    .map(Duration::from_secs)
            }
            "--out" => args.out = value(),
            _ => return None,
        }
    }
    Some(args)
}

fn emit_stderr_error(kind: ErrorKind, message: String) {
    let failure = Failure::new(kind, message);
    let _ = writeln!(std::io::stderr(), "{}", failure.to_json());
}

fn main() -> ExitCode {
    let Some(args) = parse_args() else {
        let _ = writeln!(
            std::io::stderr(),
            "usage: bettbox-forge run --script FILE --config FILE [--options JSON] [--timeout SECS] [--out FILE]\n       bettbox-forge options --script FILE [--out FILE]\n       bettbox-forge version"
        );
        return ExitCode::from(2);
    };
    if args.mode == "version" {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }

    let Some(script_path) = args.script.clone() else {
        emit_stderr_error(ErrorKind::InvalidInput, "--script is required".to_owned());
        return ExitCode::from(2);
    };
    let script = match std::fs::read_to_string(&script_path) {
        Ok(text) => text,
        Err(error) => {
            emit_stderr_error(
                ErrorKind::InvalidInput,
                format!("cannot read script {script_path}: {error}"),
            );
            return ExitCode::from(2);
        }
    };

    let result = if args.mode == "run" {
        let Some(config_path) = args.config.clone() else {
            emit_stderr_error(ErrorKind::InvalidInput, "--config is required".to_owned());
            return ExitCode::from(2);
        };
        let config = match std::fs::read(&config_path) {
            Ok(bytes) => bytes,
            Err(error) => {
                emit_stderr_error(
                    ErrorKind::InvalidInput,
                    format!("cannot read config {config_path}: {error}"),
                );
                return ExitCode::from(2);
            }
        };
        let timeout = args
            .timeout
            .map(|t| t.min(RUN_TIMEOUT_OVERRIDE_MAX))
            .unwrap_or(RUN_TIMEOUT);
        run(&script, &config, args.options.as_deref(), timeout)
    } else {
        extract_options(&script, OPTIONS_TIMEOUT)
    };

    match result {
        Ok((output, logs)) => {
            let logs_json =
                serde_json::to_string(&Json::Array(logs)).unwrap_or_else(|_| "[]".to_owned());
            let _ = writeln!(std::io::stderr(), "{{\"logs\":{logs_json}}}");
            match args.out {
                Some(path) => {
                    if let Err(error) = std::fs::write(&path, output) {
                        emit_stderr_error(
                            ErrorKind::InvalidOutput,
                            format!("cannot write {path}: {error}"),
                        );
                        return ExitCode::from(2);
                    }
                }
                None => println!("{output}"),
            }
            ExitCode::SUCCESS
        }
        Err(failure) => {
            let code = if failure.kind == ErrorKind::Timeout {
                124
            } else {
                1
            };
            let _ = writeln!(std::io::stderr(), "{}", failure.to_json());
            ExitCode::from(code)
        }
    }
}
