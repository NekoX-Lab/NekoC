use nekoc::{
    bcmkn_compiler,
    engine::{Engine, Program},
    optimizer,
};
use serde_json::Value;
use std::{fs, process::Command, time::Duration};

#[test]
fn tsinlinebudget_matches_node_with_frames_effects_captures_defaults_and_optimization() {
    stacker::grow(32 * 1024 * 1024, || {
        let dir = tempfile::tempdir().unwrap();
        let prepared = dir.path().join("inline.json");
        let result = Command::new("node")
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .arg("tests/tsinlinebudget-cases.mjs")
            .arg(&prepared)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let data: Vec<Value> = serde_json::from_slice(&fs::read(prepared).unwrap()).unwrap();
        for (case_index, case) in data.into_iter().enumerate() {
            let expected: Vec<String> = serde_json::from_value(case["expected"].clone()).unwrap();
            for optimize in [false, true] {
                let report = if optimize {
                    optimizer::optimize_report(&case["report"])
                } else {
                    case["report"].clone()
                };
                let work = bcmkn_compiler::assemble_workspace_bcmkn(
                    &report,
                    "inline-budget",
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
                    assert_eq!(engine.active_tasks(), 0, "jit={jit} optimize={optimize}");
                    assert_eq!(actual, expected, "jit={jit} optimize={optimize}");
                    // Reporter-only chains use the value evaluator; the first
                    // case also has a hot statement loop that enters native JIT.
                    if jit && case_index == 0 {
                        assert!(engine.jit_profile()["native_ops"].as_u64().unwrap() > 0);
                    }
                }
            }
        }
    });
}
