use nekoc::{
    bcmkn_compiler,
    engine::{Cell, Engine, Program},
    optimizer,
};
use serde_json::Value;
use std::{fs, process::Command, time::Duration};

#[test]
fn tsmathnan_matches_node_in_both_modes_with_and_without_optimization() {
    stacker::grow(32 * 1024 * 1024, || {
        let dir = tempfile::tempdir().unwrap();
        let prepared = dir.path().join("math.json");
        let result = Command::new("node")
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .arg("tests/tsmathnan-cases.mjs")
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
        for optimize in [false, true] {
            let report = if optimize {
                optimizer::optimize_report(&data["report"])
            } else {
                data["report"].clone()
            };
            let work = bcmkn_compiler::assemble_workspace_bcmkn(
                &report,
                "math-nan",
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
                assert_eq!(
                    actual.len(),
                    expected.len(),
                    "jit={jit} optimize={optimize}"
                );
                for (index, (a, e)) in actual.iter().zip(&expected).enumerate() {
                    assert_eq!(a, e, "Node log #{index}, jit={jit} optimize={optimize}");
                }
                for id in ["kn-var-numericMax", "kn-var-numericMin"] {
                    assert!(matches!(engine.variable_value(id), Cell::Number(n) if n.is_nan()));
                }
                assert!(
                    matches!(engine.variable_value("kn-var-textualNan"), Cell::Text(s) if &*s == "NaN")
                );
                if jit {
                    assert!(engine.jit_profile()["native_ops"].as_u64().unwrap() > 0);
                }
            }
        }
    });
}
