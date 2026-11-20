//! r3 CLI contract: process exit status, stream isolation and actionable diagnostics.
use assert_cmd::Command;
use serde_json::{Value, json};
use std::{fs, path::Path, process::Output};

const COMMANDS: &[&str] = &[
    "inspect",
    "roundtrip",
    "diff",
    "decompile",
    "workspace",
    "compile-ts",
    "check",
    "build",
    "compile-ts-bcmkn",
    "compile-ts-kitten4",
    "compile-ts-scenario",
    "test",
    "run",
    "run-scenario",
    "coverage",
    "bench-import",
    "validate",
    "pack",
    "unpack",
    "analyze-ir",
    "watch",
];

fn nekoc() -> Command {
    let mut cmd = Command::cargo_bin("nekoc").unwrap();
    cmd.current_dir(env!("CARGO_MANIFEST_DIR"));
    cmd
}

fn report(output: Output, code: i32) -> Value {
    assert_eq!(output.status.code(), Some(code), "{output:?}");
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|error| panic!("{error}: {output:?}"));
    assert_eq!(value["ok"], code == 0, "{value}");
    value
}

fn blank(path: &Path) {
    fs::write(path, nekoc::bcmkn_compiler::DEFAULT_TEMPLATE).unwrap();
}

#[test]
fn all_commands_have_chinese_help_and_document_exit_codes() {
    for command in std::iter::once(None).chain(COMMANDS.iter().copied().map(Some)) {
        let mut cmd = nekoc();
        if let Some(command) = command {
            cmd.arg(command);
        }
        let output = cmd.arg("--help").output().unwrap();
        assert!(output.status.success(), "{command:?}: {output:?}");
        assert!(output.stderr.is_empty());
        let text = String::from_utf8(output.stdout).unwrap();
        assert!(text.contains("用法："), "{command:?}: {text}");
        assert!(text.contains("退出码：0") && text.contains("2 命令行参数错误"));
        assert!(text.contains("--json"));
    }
    nekoc().args(["--json", "--version"]).assert().success();
    nekoc().args(["help", "run"]).assert().success();
}

#[test]
fn usage_errors_are_exit_two_even_with_json_before_or_after_command() {
    for args in [
        vec!["--json"],
        vec!["--json", "unknown-command"],
        vec!["check", "--json"],
        vec!["run", "missing.bcmkn", "--ticks", "bad", "--json"],
        vec!["diff", "a", "b", "--limit", "0", "--json"],
        vec!["--json", "run", "a", "--legacy-runtime", "--seed", "1"],
        vec!["coverage", "--json"],
        vec!["bench-import", "--json"],
    ] {
        let result = report(nekoc().args(&args).output().unwrap(), 2);
        assert_eq!(result["error"]["kind"], "usage", "{args:?}");
        assert!(result["error"]["hint"].as_str().unwrap().contains("--help"));
    }
    nekoc().assert().code(2);
    let output = nekoc().args(["run", "--bad-option"]).output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("下一步："));
}

#[test]
fn operational_errors_are_json_with_hints_instead_of_rust_debug_output() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("不存在.bcmkn");
    for command in ["check", "build", "validate", "run"] {
        let mut cmd = nekoc();
        cmd.arg(command).arg(&input).arg("--json");
        if command == "build" {
            cmd.arg("--check");
        }
        let result = report(cmd.output().unwrap(), 1);
        assert_eq!(result["error"]["kind"], "file_not_found");
        assert!(!result["diagnostics"].as_array().unwrap().is_empty());
        assert!(
            result["error"]["message"]
                .as_str()
                .unwrap()
                .contains("不存在")
        );
        assert!(result["error"]["hint"].as_str().unwrap().contains("路径"));
    }
    fs::write(&input, "not json").unwrap();
    let result = report(
        nekoc()
            .arg("validate")
            .arg(&input)
            .arg("--json")
            .output()
            .unwrap(),
        1,
    );
    assert_eq!(result["error"]["kind"], "invalid_json");
    let output = nekoc().arg("validate").arg(&input).output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("下一步："));
}

#[test]
fn user_paths_do_not_override_error_sources() {
    let dir = tempfile::tempdir().unwrap();
    for name in [
        "with node.bcmkn",
        "ENOENT.bcmkn",
        "EACCES.bcmkn",
        "EPERM.bcmkn",
        "Cannot find package 'typescript'.bcmkn",
    ] {
        let input = dir.path().join(name);
        for contents in [None, Some("not json")] {
            if let Some(contents) = contents {
                fs::write(&input, contents).unwrap();
            }
            let result = report(
                nekoc()
                    .arg("validate")
                    .arg(&input)
                    .arg("--json")
                    .output()
                    .unwrap(),
                1,
            );
            let kind = if contents.is_some() {
                "invalid_json"
            } else {
                "file_not_found"
            };
            assert_eq!(result["error"]["kind"], kind, "{result}");
            assert!(result["error"]["message"].as_str().unwrap().contains(name));
            assert!(
                !result["error"]["hint"]
                    .as_str()
                    .unwrap()
                    .contains("安装 Node.js")
            );
        }
    }
}

#[test]
fn test_json_preserves_stdin_and_only_captures_output_streams() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("stdin.ts");
    fs::write(&input, "import fs from 'node:fs'; test('stdin', () => { expect(fs.readFileSync(0, 'utf8').trim()).toBe('hello'); });").unwrap();
    let plain = nekoc()
        .arg("test")
        .arg(&input)
        .write_stdin("hello\n")
        .output()
        .unwrap();
    assert!(plain.status.success(), "{plain:?}");
    assert!(plain.stderr.is_empty(), "{plain:?}");
    let result = report(
        nekoc()
            .arg("test")
            .arg(&input)
            .arg("--json")
            .write_stdin("hello\n")
            .output()
            .unwrap(),
        0,
    );
    assert_eq!(
        result["result"]["stdout"],
        String::from_utf8(plain.stdout).unwrap()
    );
    assert_eq!(result["result"]["stderr"], "");
    assert!(
        result["result"]["stdout"]
            .as_str()
            .unwrap()
            .contains("ok stdin")
    );
}

#[test]
fn json_flag_after_double_dash_is_a_filename() {
    let dir = tempfile::tempdir().unwrap();
    blank(&dir.path().join("--json"));
    let output = nekoc()
        .current_dir(dir.path())
        .args(["validate", "--", "--json"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        "No validation issues"
    );
}

#[test]
fn check_and_validate_keep_their_reports_on_success_and_failure() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("project.json");
    blank(&input);
    let checked = report(
        nekoc()
            .arg("--json")
            .arg("check")
            .arg(&input)
            .output()
            .unwrap(),
        0,
    );
    assert_eq!(checked, json!({"ok": true, "diagnostics": []}));
    let validation = dir.path().join("validation.json");
    let result = report(
        nekoc()
            .arg("validate")
            .arg(&input)
            .arg("--json")
            .arg("--out")
            .arg(&validation)
            .output()
            .unwrap(),
        0,
    );
    assert_eq!(
        result,
        serde_json::from_slice::<Value>(&fs::read(&validation).unwrap()).unwrap()
    );
    let mut broken: Value = serde_json::from_slice(&fs::read(&input).unwrap()).unwrap();
    broken["procedures"]["proceduresDict"] = json!({
        "bad": {"id": "bad", "params": [], "nekoBlockJsonList": [
            {"id": "param", "type": "procedures_2_parameter", "fields": {"param_name": "missing"}}
        ]}
    });
    fs::write(&input, broken.to_string()).unwrap();
    for command in ["check", "validate"] {
        let value = report(
            nekoc()
                .arg(command)
                .arg(&input)
                .arg("--json")
                .output()
                .unwrap(),
            1,
        );
        let key = if command == "check" {
            "diagnostics"
        } else {
            "issues"
        };
        assert!(!value[key].as_array().unwrap().is_empty(), "{value}");
    }
}

#[test]
fn file_commands_emit_json_only_after_successful_writes() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("有 空格.json");
    blank(&input);
    for command in [
        "inspect",
        "workspace",
        "decompile",
        "pack",
        "analyze-ir",
        "roundtrip",
    ] {
        let out = dir.path().join(format!("{command}.out"));
        let mut cmd = nekoc();
        cmd.arg(command).arg(&input).arg("--json");
        if command != "roundtrip" {
            cmd.arg("--out");
        }
        let value = report(cmd.arg(&out).output().unwrap(), 0);
        assert_eq!(value["command"], command);
        assert_eq!(value["result"]["out"], out.to_str().unwrap());
        assert!(out.is_file());
        if command != "decompile" {
            assert!(fs::metadata(&out).unwrap().len() > 0);
        }
    }
    let out = dir.path().join("absent-directory/result.json");
    let value = report(
        nekoc()
            .arg("inspect")
            .arg(&input)
            .arg("--out")
            .arg(&out)
            .arg("--json")
            .output()
            .unwrap(),
        1,
    );
    assert_eq!(value["error"]["kind"], "file_not_found");
    assert!(!out.exists());
    let mut source: Value = serde_json::from_slice(&fs::read(&input).unwrap()).unwrap();
    source["variables"]["variablesDict"]["text-list"] = json!({
        "id":"text-list", "name":"data", "type":"list", "isGlobal":true,
        "value":vec!["long repeated text".repeat(100); 4]
    });
    let (packed, _) = nekoc::pack::pack(
        &source,
        &nekoc::pack::PackOptions {
            min_list_bytes: 0,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(nekoc::pack::is_packed(&packed));
    fs::write(&input, nekoc::json::to_vec(&packed).unwrap()).unwrap();
    let restored = dir.path().join("unpacked.json");
    report(
        nekoc()
            .arg("unpack")
            .arg(&input)
            .arg("--out")
            .arg(&restored)
            .arg("--json")
            .output()
            .unwrap(),
        0,
    );
    let restored: Value = serde_json::from_slice(&fs::read(restored).unwrap()).unwrap();
    assert_eq!(
        restored["variables"]["variablesDict"]["text-list"]["value"],
        source["variables"]["variablesDict"]["text-list"]["value"]
    );
}

#[test]
fn diff_results_are_structured_and_differences_exit_one() {
    let dir = tempfile::tempdir().unwrap();
    let left = dir.path().join("left.json");
    let right = dir.path().join("right.json");
    fs::write(&left, r#"{"name":"甲"}"#).unwrap();
    fs::write(&right, r#"{"name":"乙"}"#).unwrap();
    let result = report(
        nekoc()
            .arg("diff")
            .arg(&left)
            .arg(&right)
            .arg("--json")
            .output()
            .unwrap(),
        1,
    );
    assert_eq!(result["result"]["differences"][0]["path"], "$.name");
    assert_eq!(result["result"]["differences"][0]["kind"], "changed");
    let result = report(
        nekoc()
            .arg("diff")
            .arg(&left)
            .arg(&left)
            .arg("--json")
            .output()
            .unwrap(),
        0,
    );
    assert_eq!(result["result"]["differences"], json!([]));
    // Truncation must not split the UTF-8 encoding of Chinese values.
    fs::write(&right, json!({"name": "中文".repeat(80)}).to_string()).unwrap();
    let result = report(
        nekoc()
            .arg("diff")
            .arg(&left)
            .arg(&right)
            .arg("--json")
            .output()
            .unwrap(),
        1,
    );
    assert!(
        result["result"]["differences"][0]["right"]
            .as_str()
            .unwrap()
            .ends_with("...")
    );
}

#[test]
fn run_json_never_mixes_snapshot_and_expectation_messages() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("project.json");
    let out = dir.path().join("snapshot.json");
    blank(&input);
    let result = report(
        nekoc()
            .arg("run")
            .arg(&input)
            .arg("--json")
            .arg("--out")
            .arg(&out)
            .output()
            .unwrap(),
        0,
    );
    let snapshot: Value = serde_json::from_slice(&fs::read(&out).unwrap()).unwrap();
    assert_eq!(result["result"]["snapshot"], snapshot);
    let matched = report(
        nekoc()
            .arg("run")
            .arg(&input)
            .arg("--expect")
            .arg(&out)
            .arg("--json")
            .output()
            .unwrap(),
        0,
    );
    assert_eq!(matched["result"]["snapshot"], snapshot);
    fs::write(&out, "{}").unwrap();
    let mismatch = report(
        nekoc()
            .arg("run")
            .arg(&input)
            .arg("--expect")
            .arg(&out)
            .arg("--json")
            .output()
            .unwrap(),
        1,
    );
    assert_eq!(mismatch["result"]["snapshot"], snapshot);
    assert!(
        !mismatch["result"]["differences"]
            .as_str()
            .unwrap()
            .is_empty()
    );
    let plain = nekoc().arg("run").arg(&input).output().unwrap();
    assert!(plain.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&plain.stdout).unwrap(),
        snapshot
    );
}

#[test]
fn scenarios_and_batch_reports_are_single_json_documents() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("project.json");
    let scenario = dir.path().join("scenario.json");
    blank(&input);
    fs::write(&scenario, "{}").unwrap();
    report(
        nekoc()
            .arg("run-scenario")
            .arg(&input)
            .arg(&scenario)
            .arg("--json")
            .output()
            .unwrap(),
        0,
    );
    fs::write(&scenario, r#"{"expect":{"missing":true}}"#).unwrap();
    let result = report(
        nekoc()
            .arg("run-scenario")
            .arg(&input)
            .arg(&scenario)
            .arg("--json")
            .output()
            .unwrap(),
        1,
    );
    assert!(!result["result"]["differences"].as_str().unwrap().is_empty());
    for command in ["coverage", "bench-import"] {
        let input = Path::new("tests/fixtures/kitten4/cloud-writes.bcm");
        let result = report(
            nekoc()
                .arg(command)
                .arg(input)
                .arg(input)
                .args(["--frames", "0", "--json"])
                .output()
                .unwrap(),
            0,
        );
        assert_eq!(result["result"]["reports"].as_array().unwrap().len(), 2);
        // If a later input cannot be read, stdout still contains one failure document.
        report(
            nekoc()
                .arg(command)
                .arg(input)
                .arg(dir.path().join("missing.bcm"))
                .args(["--frames", "0", "--json"])
                .output()
                .unwrap(),
            1,
        );
    }
    // Benchmark compile failures used to be printed but incorrectly exited zero.
    let mut broken: Value = serde_json::from_slice(&fs::read(&input).unwrap()).unwrap();
    broken["actors"]["actorsDict"]["nekoc-default-actor"]["nekoBlockJsonList"] = json!([
        {"type":"on_running_group_activated","next":{"type":"r3_unknown_block"}}
    ]);
    fs::write(&input, broken.to_string()).unwrap();
    let result = report(
        nekoc()
            .arg("bench-import")
            .arg(&input)
            .args(["--snapshot", "--json"])
            .output()
            .unwrap(),
        1,
    );
    assert!(result["result"]["reports"][0]["error"].is_string());
}

#[test]
fn compiler_and_test_runner_capture_their_output_and_exit_status() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("demo.nk.ts");
    let template = dir.path().join("template.bcmkn");
    let scenario = dir.path().join("scenario.json");
    blank(&template);
    fs::write(
        &input,
        "stage({name: 'r3'}); onStart(() => { setVar('answer', 1); });",
    )
    .unwrap();
    fs::write(&scenario, "{}").unwrap();
    for command in [
        "build",
        "compile-ts",
        "compile-ts-bcmkn",
        "compile-ts-kitten4",
        "compile-ts-scenario",
    ] {
        let out = dir.path().join(format!("{command}.out"));
        let mut cmd = nekoc();
        cmd.arg(command)
            .arg(&input)
            .arg("--out")
            .arg(&out)
            .arg("--json");
        if matches!(command, "compile-ts-bcmkn" | "compile-ts-scenario") {
            cmd.arg("--template").arg(&template);
        }
        if command == "compile-ts-scenario" {
            cmd.arg("--scenario").arg(&scenario);
        }
        if matches!(command, "build" | "compile-ts" | "compile-ts-bcmkn") {
            cmd.arg("--optimize");
        }
        let result = report(cmd.output().unwrap(), 0);
        assert_eq!(result["result"]["out"], out.to_str().unwrap());
        assert!(out.is_file());
    }
    fs::write(&input, "onStart(() => { missingApi(); });").unwrap();
    let result = report(
        nekoc()
            .arg("build")
            .arg(&input)
            .arg("--json")
            .output()
            .unwrap(),
        1,
    );
    assert_eq!(result["error"]["kind"], "compile_failed");
    let result = report(
        nekoc()
            .arg("build")
            .arg(&input)
            .args(["--check", "--json"])
            .output()
            .unwrap(),
        1,
    );
    assert!(!result["diagnostics"].as_array().unwrap().is_empty());
    for (source, code) in [
        (
            "test('pass', () => { console.log('user output'); expect(1).toBe(1); });",
            0,
        ),
        (
            "test('fail', () => { console.log('user output'); expect(1).toBe(2); });",
            1,
        ),
    ] {
        fs::write(&input, source).unwrap();
        let result = report(
            nekoc()
                .arg("test")
                .arg(&input)
                .arg("--json")
                .output()
                .unwrap(),
            code,
        );
        assert!(
            result["result"]["stdout"]
                .as_str()
                .unwrap()
                .contains("user output")
        );
        if code == 1 {
            assert!(
                result["result"]["stderr"]
                    .as_str()
                    .unwrap()
                    .contains("fail")
            );
        }
    }
}

#[test]
fn missing_node_has_a_next_step_and_watch_rejects_missing_entry() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("entry.ts");
    fs::write(&input, "onStart(() => {});").unwrap();
    let result = report(
        nekoc()
            .env("PATH", dir.path())
            .arg("build")
            .arg(&input)
            .arg("--json")
            .output()
            .unwrap(),
        1,
    );
    assert_eq!(result["error"]["kind"], "node_unavailable");
    assert!(
        result["error"]["hint"]
            .as_str()
            .unwrap()
            .contains("node --version")
    );
    report(
        nekoc()
            .arg("watch")
            .arg(dir.path().join("absent.ts"))
            .args(["--template", "samples/kitten-n-0.27.4.bcmkn", "--out"])
            .arg(dir.path().join("out.bcmkn"))
            .arg("--json")
            .output()
            .unwrap(),
        1,
    );
}

#[test]
fn watch_stream_reports_failed_compilation_and_recovers() {
    use std::{
        io::{BufRead, BufReader},
        process::{Child, Stdio},
        sync::mpsc,
        time::Duration,
    };

    // Always reap the persistent process, including when an assertion fails.
    struct Watch(Child);
    impl Drop for Watch {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("entry.ts");
    let template = dir.path().join("template.bcmkn");
    blank(&template);
    let valid = "onStart(() => { setVar('answer', 1); });";
    fs::write(&input, valid).unwrap();
    // Relative entry path also exercises watch's empty-parent handling.
    let mut watch = Watch(
        std::process::Command::new(env!("CARGO_BIN_EXE_nekoc"))
            .current_dir(dir.path())
            .args([
                "watch",
                "entry.ts",
                "--template",
                "template.bcmkn",
                "--out",
                "out.bcmkn",
                "--json",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let stdout = watch.0.stdout.take().unwrap();
    let (sender, receiver) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if sender.send(line.unwrap()).is_err() {
                break;
            }
        }
    });
    let next = |ok: bool| {
        for _ in 0..12 {
            // Only a deadlock guard, not a wall-clock performance assertion.
            let line = receiver.recv_timeout(Duration::from_secs(60)).unwrap();
            let value: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(value["command"], "watch");
            assert_eq!(value["event"], "compile");
            if value["ok"] == ok {
                return value;
            }
        }
        panic!("watch did not emit a compile event with ok={ok}");
    };
    next(true);
    fs::write(&input, "onStart(() => { missingApi(); });").unwrap();
    let failure = next(false);
    assert_eq!(failure["error"]["kind"], "compile_failed");
    assert!(watch.0.try_wait().unwrap().is_none());
    fs::write(&input, valid).unwrap();
    next(true);
    assert!(dir.path().join("out.bcmkn").is_file());
    watch.0.kill().unwrap();
    let mut stderr = watch.0.stderr.take().unwrap();
    watch.0.wait().unwrap();
    reader.join().unwrap();
    let mut text = String::new();
    std::io::Read::read_to_string(&mut stderr, &mut text).unwrap();
    assert!(text.is_empty(), "{text}");
}
