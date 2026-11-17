use nekoc::engine::{Engine, Program};
use serde_json::Value;
use std::{fs, process::Command, time::Duration};

#[test]
fn replacements_match_node_in_interpreter_and_jit_with_both_optimizations() {
    let dir = tempfile::tempdir().unwrap();
    let input = "tests/fixtures/tsstrreplace.ts";
    let oracle = Command::new("node")
        .args(["tests/tsarrayfix-oracle.mjs", input])
        .output()
        .unwrap();
    assert!(oracle.status.success(), "{oracle:?}");
    let expected: Vec<String> = serde_json::from_slice(&oracle.stdout).unwrap();
    assert_eq!(&expected[..4], ["Xbc", "abX", "-abc", "a[b]c"]);
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
