use nekoc::engine::{Engine, Program};
use serde_json::Value;
use std::{fs, process::Command, time::Duration};

#[test]
fn array_fixtures_match_node_in_interpreter_and_jit_with_both_optimizations() {
    let dir = tempfile::tempdir().unwrap();
    for name in [
        "eval",
        "args",
        "snapshot",
        "identity",
        "named",
        "modules",
        "procedures",
    ] {
        let input = format!("tests/fixtures/tsarrayfix-{name}.ts");
        let oracle = Command::new("node")
            .args(["tests/tsarrayfix-oracle.mjs", &input])
            .output()
            .unwrap();
        assert!(oracle.status.success(), "{oracle:?}");
        let expected: Vec<String> = serde_json::from_slice(&oracle.stdout).unwrap();
        for optimize in [false, true] {
            let output = dir.path().join(format!("{name}-{optimize}.bcmkn"));
            let mut build = Command::new(env!("CARGO_BIN_EXE_nekoc"));
            build.args(["build", &input, "-o"]).arg(&output);
            if optimize {
                build.arg("--optimize");
            }
            let result = build.output().unwrap();
            assert!(result.status.success(), "{name}: {result:?}");
            let project: Value = serde_json::from_slice(&fs::read(output).unwrap()).unwrap();
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
                        .advance(1.0 / 60.0, 100_000, Duration::from_secs(2))
                        .unwrap();
                    logs.extend(frame.logs);
                }
                assert_eq!(logs, expected, "{name}, optimize={optimize}, jit={jit}");
            }
        }
    }
}

#[test]
fn unsafe_dsl_procedure_callbacks_are_rejected_before_emitting_works() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["map", "find"] {
        let input = format!("tests/fixtures/tsarrayfix-proc-{name}-rejected.ts");
        let check = Command::new(env!("CARGO_BIN_EXE_nekoc"))
            .args(["check", &input, "--json"])
            .output()
            .unwrap();
        assert!(!check.status.success());
        let diagnostics: Value = serde_json::from_slice(&check.stdout).unwrap();
        assert_eq!(diagnostics["ok"], false);
        assert!(
            diagnostics["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|d| {
                    d["line"] == 5
                        && d["message"]
                            .as_str()
                            .is_some_and(|s| s.contains("may not shrink"))
                })
        );
        for optimize in [false, true] {
            let output = dir.path().join(format!("{name}-{optimize}.bcmkn"));
            let mut build = Command::new(env!("CARGO_BIN_EXE_nekoc"));
            build.args(["build", &input, "-o"]).arg(&output);
            if optimize {
                build.arg("--optimize");
            }
            let result = build.output().unwrap();
            assert!(!result.status.success(), "{result:?}");
            assert!(String::from_utf8_lossy(&result.stderr).contains("may not shrink"));
            assert!(!output.exists());
        }
    }
}

#[test]
fn yielding_reentrant_mutations_keep_the_saved_receiver_and_arguments() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("reentry.ts");
    fs::write(&input, include_str!("fixtures/tsarrayfix-reentry.ts")).unwrap();
    for optimize in [false, true] {
        let output = dir.path().join(format!("reentry-{optimize}.bcmkn"));
        let mut build = Command::new(env!("CARGO_BIN_EXE_nekoc"));
        build.arg("build").arg(&input).arg("-o").arg(&output);
        if optimize {
            build.arg("--optimize");
        }
        let result = build.output().unwrap();
        assert!(result.status.success(), "{result:?}");
        let project: Value = serde_json::from_slice(&fs::read(output).unwrap()).unwrap();
        for jit in [false, true] {
            let mut engine = Engine::new(Program::compile(&project).unwrap());
            if !jit {
                engine.disable_jit();
            }
            engine.use_virtual_clock();
            engine.start();
            let mut logs = Vec::new();
            for _ in 0..120 {
                logs.extend(
                    engine
                        .advance(1.0 / 60.0, 100_000, Duration::from_secs(2))
                        .unwrap()
                        .logs,
                );
            }
            assert_eq!(logs, ["1,3,0 2,3,9"], "optimize={optimize}, jit={jit}");
        }
    }
}
