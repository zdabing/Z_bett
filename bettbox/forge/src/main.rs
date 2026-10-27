// SPDX-License-Identifier: GPL-3.0
// Standalone router helper, shipped inside bettbox.apk. The QuickJS runtime,
// config conversion and option extraction follow upstream Bettbox code_forge.
// It runs only while preparing a configuration, outside the Mihomo process.
mod script;

use script::{ErrorKind, Failure, EVALUATE_LIMITS};
use serde_json::{Map, Value as Json};
use std::io::Write as _;
use std::process::ExitCode;
use std::time::Duration;

const RUN_TIMEOUT: Duration = Duration::from_secs(10);
const RUN_TIMEOUT_OVERRIDE_MAX: Duration = Duration::from_secs(60);

impl ErrorKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Syntax => "Syntax",
            Self::Runtime => "Runtime",
            Self::Timeout => "Timeout",
            Self::OutOfMemory => "OutOfMemory",
            Self::Cancelled => "Cancelled",
            Self::InvalidInput => "InvalidInput",
            Self::InvalidOutput => "InvalidOutput",
        }
    }
}

impl Failure {
    fn to_json(&self) -> String {
        let mut error = Map::new();
        error.insert("kind".into(), Json::String(self.kind.as_str().to_owned()));
        error.insert("message".into(), Json::String(self.message.clone()));
        error.insert(
            "stack".into(),
            self.stack.clone().map(Json::String).unwrap_or(Json::Null),
        );
        error.insert(
            "logs".into(),
            Json::Array(
                self.logs
                    .iter()
                    .map(|line| Json::String(format!("{}: {}", line.level, line.text)))
                    .collect(),
            ),
        );
        let mut out = Map::new();
        out.insert("error".into(), Json::Object(error));
        serde_json::to_string(&Json::Object(out)).unwrap_or_else(|_| "{}".to_owned())
    }
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
        {
            let mut limits = EVALUATE_LIMITS;
            limits.timeout = timeout;
            script::evaluate(&script, &config, args.options.as_deref(), limits, 0).map(|result| {
                (
                    String::from_utf8(result.config).expect("JSON is UTF-8"),
                    result.logs,
                )
            })
        }
    } else {
        script::extract_options(&script).map(|output| (output, Vec::new()))
    };

    match result {
        Ok((output, logs)) => {
            let logs_json = serde_json::to_string(
                &logs
                    .iter()
                    .map(|line| format!("{}: {}", line.level, line.text))
                    .collect::<Vec<_>>(),
            )
            .unwrap_or_else(|_| "[]".to_owned());
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
