use nekoc::engine::{Engine, Program};
use serde_json::Value;
use std::{fs, process::Command, time::Duration};

#[test]
fn destructuring_matches_node_in_both_tiers_and_optimization_modes() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["probe", "return", "order", "local", "alias", "import"] {
        let input = format!("tests/fixtures/tstopdestructure-{name}.ts");
        let oracle = Command::new("node")
            .args(["tests/tstopdestructure-oracle.mjs", &input])
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
                    logs.extend(
                        engine
                            .advance(1.0 / 60.0, 100_000, Duration::from_secs(2))
                            .unwrap()
                            .logs,
                    );
                }
                assert_eq!(logs, expected, "{name}, optimize={optimize}, jit={jit}");
                assert_eq!(engine.active_tasks(), 0);
            }
        }
    }
}
