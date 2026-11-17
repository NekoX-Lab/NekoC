use nekoc::{
    bcmkn_compiler,
    engine::{Engine, Program},
    optimizer,
};
use serde_json::Value;
use std::{fs, process::Command, time::Duration};

#[test]
fn tsstrfix_matches_node_with_optimization_and_both_execution_tiers() {
    stacker::grow(32 * 1024 * 1024, || {
        let dir = tempfile::tempdir().unwrap();
        let prepared = dir.path().join("strings.json");
        let result = Command::new("node")
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .arg("tests/tsstrfix-cases.mjs")
            .arg(&prepared)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let data: Value = serde_json::from_slice(&fs::read(prepared).unwrap()).unwrap();
        let expected: Vec<String> = serde_json::from_value(data["expected"].clone()).unwrap();
        for optimized in [false, true] {
            let report = if optimized {
                optimizer::optimize_report(&data["report"])
            } else {
                data["report"].clone()
            };
            let work = bcmkn_compiler::assemble_workspace_bcmkn(
                &report,
                "strings",
                bcmkn_compiler::default_template(),
            )
            .unwrap();
            for jit in [false, true] {
                let mut engine = Engine::new(Program::compile(&work).unwrap());
                if !jit {
                    engine.disable_jit();
                }
                engine.enable_jit_profile();
                engine.use_virtual_clock();
                engine.start();
                let mut actual = Vec::new();
                for _ in 0..2000 {
                    actual.extend(
                        engine
                            .advance(1.0 / 60.0, 2_000_000, Duration::from_secs(10))
                            .unwrap()
                            .logs,
                    );
                    if engine.active_tasks() == 0 {
                        break;
                    }
                }
                assert_eq!(
                    engine.active_tasks(),
                    0,
                    "unfinished: optimized={optimized}, jit={jit}"
                );
                assert_eq!(
                    actual.len(),
                    expected.len(),
                    "log count: optimized={optimized}, jit={jit}"
                );
                for (i, (a, e)) in actual.iter().zip(&expected).enumerate() {
                    assert_eq!(
                        a, e,
                        "Node comparison #{i}: optimized={optimized}, jit={jit}"
                    );
                }
                if jit {
                    assert!(engine.jit_profile()["native_ops"].as_u64().unwrap() > 0);
                }
            }
        }
    });
}

#[test]
fn tsstrfix_yielding_argument_reentry_keeps_saved_receiver() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("reentry.ts");
    let output = dir.path().join("reentry.bcmkn");
    fs::write(
        &input,
        r#"
        let pending = "abcd";
        function delayedIndex(n: number): number { wait(0.02); return n; }
        onStart(() => { console.log(pending.substring(delayedIndex(1), 3)); });
        onStart(() => { pending = "wxyz"; console.log(pending.substring(delayedIndex(2), 4)); });
    "#,
    )
    .unwrap();
    bcmkn_compiler::compile_ts_bcmkn(&input, "samples/kitten-n-0.27.4.bcmkn", &output).unwrap();
    let work: Value = serde_json::from_slice(&fs::read(output).unwrap()).unwrap();
    for jit in [false, true] {
        let mut engine = Engine::new(Program::compile(&work).unwrap());
        if !jit {
            engine.disable_jit();
        }
        engine.use_virtual_clock();
        engine.start();
        let mut logs = Vec::new();
        for _ in 0..60 {
            logs.extend(
                engine
                    .advance(1.0 / 60.0, 100_000, Duration::from_secs(2))
                    .unwrap()
                    .logs,
            );
        }
        assert_eq!(logs, ["bc", "yz"], "jit={jit}");
    }
}
