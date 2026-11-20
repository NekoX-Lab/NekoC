use nekoc::{
    bcmkn_compiler,
    engine::{Engine, Program},
};
use serde_json::Value;
use std::{fs, time::Duration};
use tempfile::tempdir;

#[test]
fn share_object_fixture_matches_node_in_interpreter_and_jit() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("r2-tsobject.ts");
    let output = dir.path().join("r2-tsobject.bcmkn");
    fs::write(&input, include_str!("fixtures/r2-tsobject.ts")).unwrap();
    bcmkn_compiler::compile_ts_bcmkn(&input, "samples/kitten-n-0.27.4.bcmkn", &output).unwrap();
    let project: Value = serde_json::from_slice(&fs::read(output).unwrap()).unwrap();
    // Independently produced by Node from the same pure TS fixture. The Node
    // test also compares its oracle dynamically to the `nekoc run` output.
    let expected = [
        "5", "cell2", "true", "true", "false", "6", "9", "true", "8", "9", "1", "12", "1", "true",
        "20", "3", "true", "false", "3", "4", "5", "6", "7", "30",
    ];
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
        assert_eq!(logs, expected, "jit={jit}");
    }
}
