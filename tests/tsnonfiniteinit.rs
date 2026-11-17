use nekoc::{
    bcmkn_compiler,
    engine::{Engine, Program},
    optimizer,
};
use serde_json::Value;
use std::{fs, process::Command, time::Duration};

#[test]
fn tsnonfiniteinit_matches_node_after_json_with_optimization_and_jit() {
    let dir = tempfile::tempdir().unwrap();
    let prepared = dir.path().join("prepared.json");
    let result = Command::new("node")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .arg("tests/tsnonfiniteinit-cases.mjs")
        .arg(&prepared)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let data: Vec<Value> = serde_json::from_slice(&fs::read(prepared).unwrap()).unwrap();
    for (case, data) in data.into_iter().enumerate() {
        let expected: Vec<String> = serde_json::from_value(data["expected"].clone()).unwrap();
        for optimize in [false, true] {
            let report = if optimize {
                optimizer::optimize_report(&data["report"])
            } else {
                data["report"].clone()
            };
            let work = bcmkn_compiler::assemble_workspace_bcmkn(
                &report,
                "nonfinite initialization",
                bcmkn_compiler::default_template(),
            )
            .unwrap();
            assert_eq!(nekoc::validate::build_report(&work).unwrap()["ok"], true);
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
                    "case={case} jit={jit} optimize={optimize}"
                );
                assert_eq!(
                    actual, expected,
                    "case={case} jit={jit} optimize={optimize}"
                );
                if jit && case == 0 {
                    assert!(engine.jit_profile()["native_ops"].as_u64().unwrap() > 0);
                }
            }
        }
    }
}
