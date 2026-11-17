use nekoc::engine::{Engine, Program};
use serde_json::Value;
use std::{fs, process::Command, time::Duration};

#[test]
fn replacements_match_node_in_interpreter_and_jit_with_both_optimizations() {
    assert_replacements_match_node("tests/fixtures/tsstrreplace.ts");
}

#[test]
fn narrowed_nullable_arguments_and_optional_receivers_match_node() {
    assert_replacements_match_node("tests/fixtures/tsstrreplace-nullable.ts");
}

fn assert_replacements_match_node(input: &str) {
    let dir = tempfile::tempdir().unwrap();
    let oracle = Command::new("node")
        .args(["tests/tsarrayfix-oracle.mjs", input])
        .output()
        .unwrap();
    assert!(oracle.status.success(), "{oracle:?}");
    let expected: Vec<String> = serde_json::from_slice(&oracle.stdout).unwrap();
    if input.ends_with("tsstrreplace.ts") {
        assert_eq!(&expected[..4], ["Xbc", "abX", "-abc", "a[b]c"]);
    } else {
        assert_eq!(
            expected,
            [
                "Xaba",
                "skipped",
                "XXbX",
                "aaYa",
                "undefinedundefined",
                "XXbX",
                "Xbc",
                "NULL",
                "NULL",
                "0"
            ]
        );
    }
    let check = Command::new(env!("CARGO_BIN_EXE_nekoc"))
        .args(["check", input, "--json"])
        .output()
        .unwrap();
    assert!(check.status.success(), "{check:?}");
    for optimize in [false, true] {
        let output = dir.path().join(format!("replace-{optimize}.bcmkn"));
        let mut build = Command::new(env!("CARGO_BIN_EXE_nekoc"));
        build.args(["build", input, "-o"]).arg(&output);
        if optimize {
            build.arg("--optimize");
        }
        let result = build.output().unwrap();
        assert!(result.status.success(), "{result:?}");
        let project: Value = serde_json::from_slice(&fs::read(&output).unwrap()).unwrap();
        let validation = nekoc::validate::build_report(&project).unwrap();
        assert_eq!(validation["ok"], true, "{validation}");
        for jit in [false, true] {
            let mut engine = Engine::new(Program::compile(&project).unwrap());
            if !jit {
                engine.disable_jit();
            }
            engine.use_virtual_clock();
            engine.start();
            let mut logs = Vec::new();
            for _ in 0..120 {
                let frame = engine
                    .advance(1.0 / 60.0, 1_000_000, Duration::from_secs(2))
                    .unwrap();
                logs.extend(frame.logs);
                engine.recycle_lines(frame.lines);
            }
            assert_eq!(logs, expected, "optimize={optimize}, jit={jit}");
        }
    }
}

#[test]
fn unsupported_overloads_fail_check_and_build_without_emitting_a_work() {
    let dir = tempfile::tempdir().unwrap();
    for (index, expression) in [
        "\"abc\".replace(/b/, \"X\")",
        "\"abc\".replace(\"b\", () => \"X\")",
        "\"abc\".replaceAll(/b/g, \"X\")",
        "\"abc\".replaceAll(\"b\", () => \"X\")",
        "\"😀\".replaceAll(\"\", \"X\")",
    ]
    .iter()
    .enumerate()
    {
        let input = dir.path().join(format!("invalid-{index}.ts"));
        fs::write(&input, format!("// original\nconsole.log({expression});")).unwrap();
        for types in [false, true] {
            let mut check = Command::new(env!("CARGO_BIN_EXE_nekoc"));
            check.arg("check").arg(&input).arg("--json");
            if !types {
                check.arg("--no-types");
            }
            let result = check.output().unwrap();
            assert!(!result.status.success(), "{result:?}");
            let checked: Value = serde_json::from_slice(&result.stdout).unwrap();
            assert_eq!(checked["ok"], false);
            let diagnostic = checked["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .find(|d| d["source"] == "compat")
                .unwrap();
            assert_eq!(diagnostic["line"], 2);
            assert_eq!(diagnostic["column"], 13);
            assert!(
                diagnostic["message"]
                    .as_str()
                    .unwrap()
                    .contains("String.replace")
            );
        }
        for optimize in [false, true] {
            let output = dir.path().join(format!("invalid-{index}-{optimize}.bcmkn"));
            let mut build = Command::new(env!("CARGO_BIN_EXE_nekoc"));
            build.arg("build").arg(&input).arg("-o").arg(&output);
            if optimize {
                build.arg("--optimize");
            }
            let result = build.output().unwrap();
            assert!(!result.status.success(), "{result:?}");
            assert!(String::from_utf8_lossy(&result.stderr).contains("String.replace"));
            assert!(!output.exists());
        }
    }
}

#[test]
fn cli_reports_original_coordinates_before_nullable_and_class_rewrites() {
    let dir = tempfile::tempdir().unwrap();
    for (index, (source, line, column, message)) in [
        (
            "let s: string | null = \"😀\";\nconsole.log(s?.replaceAll(\"\", \"X\"));",
            2,
            13,
            "UTF-16",
        ),
        (
            "class A {\n  s: string = \"abc\";\n  f(): string {\n    return this.s.replace(\"b\", () => \"X\");\n  }\n}\nconsole.log(new A().f());",
            4,
            12,
            "exactly two string arguments",
        ),
        (
            "class A {\n  s: string = \"abc\";\n  f(): string {\n    return this.s.replace(/b/, \"X\");\n  }\n}\nconsole.log(new A().f());",
            4,
            12,
            "exactly two string arguments",
        ),
        (
            "let search: string = \"\\uD83D\";\nconsole.log(\"😀\".replace(search, \"X\"));",
            1,
            22,
            "complete Unicode",
        ),
        (
            "let replacement: string = \"\\uD83D\";\nconsole.log(\"😀\".replace(\"😀\", replacement));",
            1,
            27,
            "complete Unicode",
        ),
    ]
    .iter()
    .enumerate()
    {
        let input = dir.path().join(format!("location-{index}.ts"));
        fs::write(&input, source).unwrap();
        for types in [false, true] {
            let mut check = Command::new(env!("CARGO_BIN_EXE_nekoc"));
            check.arg("check").arg(&input).arg("--json");
            if !types {
                check.arg("--no-types");
            }
            let result = check.output().unwrap();
            assert!(!result.status.success(), "{result:?}");
            let checked: Value = serde_json::from_slice(&result.stdout).unwrap();
            let diagnostic = checked["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .find(|d| d["source"] == "compat")
                .unwrap();
            assert_eq!(diagnostic["line"], *line);
            assert_eq!(diagnostic["column"], *column);
            assert!(diagnostic["message"].as_str().unwrap().contains(message));
        }
        for optimize in [false, true] {
            let output = dir.path().join(format!("location-{index}-{optimize}.bcmkn"));
            let mut build = Command::new(env!("CARGO_BIN_EXE_nekoc"));
            build.arg("build").arg(&input).arg("-o").arg(&output);
            if optimize {
                build.arg("--optimize");
            }
            let result = build.output().unwrap();
            assert!(!result.status.success(), "{result:?}");
            let stderr = String::from_utf8_lossy(&result.stderr);
            assert!(stderr.contains(&format!(":{line}:{column}:")), "{stderr}");
            assert!(stderr.contains(message), "{stderr}");
            assert!(!stderr.contains("invalid JSON"), "{stderr}");
            assert!(!output.exists());
        }
    }
}

#[test]
fn nullable_arguments_fail_cli_check_and_build_before_emitting_a_work() {
    let cases = Command::new("node")
        .args([
            "--input-type=module",
            "-e",
            "import { diagnosticCases } from './tests/tsstrreplace-diagnostics.mjs'; console.log(JSON.stringify(diagnosticCases.filter(c => c.name.startsWith('nullable-'))));",
        ])
        .output()
        .unwrap();
    assert!(cases.status.success(), "{cases:?}");
    let cases: Vec<Value> = serde_json::from_slice(&cases.stdout).unwrap();
    assert_eq!(cases.len(), 12);
    let dir = tempfile::tempdir().unwrap();
    for case in cases {
        let input = dir
            .path()
            .join(format!("{}.ts", case["name"].as_str().unwrap()));
        fs::write(&input, case["source"].as_str().unwrap()).unwrap();
        for types in [false, true] {
            let mut check = Command::new(env!("CARGO_BIN_EXE_nekoc"));
            check.arg("check").arg(&input).arg("--json");
            if !types {
                check.arg("--no-types");
            }
            let result = check.output().unwrap();
            assert!(!result.status.success(), "{result:?}");
            let checked: Value = serde_json::from_slice(&result.stdout).unwrap();
            let diagnostic = checked["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .find(|d| d["source"] == "compat")
                .unwrap();
            assert_eq!(diagnostic["line"], case["line"]);
            assert_eq!(diagnostic["column"], case["column"]);
            assert!(
                diagnostic["message"]
                    .as_str()
                    .unwrap()
                    .contains("without implicit conversion")
            );
        }
        for optimize in [false, true] {
            let output = dir.path().join(format!(
                "{}-{optimize}.bcmkn",
                case["name"].as_str().unwrap()
            ));
            let mut build = Command::new(env!("CARGO_BIN_EXE_nekoc"));
            build.arg("build").arg(&input).arg("-o").arg(&output);
            if optimize {
                build.arg("--optimize");
            }
            let result = build.output().unwrap();
            assert!(!result.status.success(), "{result:?}");
            let stderr = String::from_utf8_lossy(&result.stderr);
            assert!(stderr.contains("without implicit conversion"), "{stderr}");
            assert!(
                stderr.contains(&format!(":{}:{}:", case["line"], case["column"])),
                "{stderr}"
            );
            assert!(!output.exists());
        }
    }
}
