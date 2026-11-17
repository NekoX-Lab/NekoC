use nekoc::engine::{Engine, Program};
use std::{fs, process::Command, time::Duration};

#[test]
fn calls_and_splice_match_node_in_both_modes_and_optimizations_including_native_jit() {
    let dir = tempfile::tempdir().unwrap();
    for name in [
        "defaults",
        "procedures",
        "classes",
        "plain-classes",
        "modules",
        "splice",
    ] {
        let input = format!("tests/fixtures/tsargorder-{name}.ts");
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
            let project = nekoc::json::from_slice(&fs::read(output).unwrap()).unwrap();
            for jit in [false, true] {
                let mut engine = Engine::new(Program::compile(&project).unwrap());
                if !jit {
                    engine.disable_jit();
                }
                engine.enable_jit_profile();
                engine.use_virtual_clock();
                engine.start();
                let mut logs = Vec::new();
                for _ in 0..2000 {
                    logs.extend(
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
                    "{name} optimize={optimize} jit={jit}"
                );
                assert_eq!(logs, expected, "{name} optimize={optimize} jit={jit}");
                if jit && matches!(name, "defaults" | "splice") {
                    assert!(engine.jit_profile()["native_ops"].as_u64().unwrap() > 0);
                }
            }
        }
    }
}
