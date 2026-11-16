use nekoc::{
    bcmkn_compiler,
    engine::{Engine, Program},
};
use serde_json::Value;
use std::{fs, time::Duration};
use tempfile::tempdir;

#[test]
fn tsmap_collections_match_node_in_interpreter_and_jit() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("tsmap.ts");
    let output = dir.path().join("tsmap.bcmkn");
    fs::write(&input, include_str!("fixtures/tsmap.ts")).unwrap();
    bcmkn_compiler::compile_ts_bcmkn(&input, "samples/kitten-n-0.27.4.bcmkn", &output).unwrap();
    let project: Value = serde_json::from_slice(&fs::read(output).unwrap()).unwrap();
    let expected = [
        "cat 3",
        "dog 2",
        "bird 1",
        "unique 3",
        "unique 2",
        "unique 1",
        "keys 4 2 3 5 6",
        "a b",
        "a c",
        "a d",
        "3 true",
        "live 1 10",
        "live 3 31",
        "live 5 50",
        "size 1",
        "guarded 51",
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
            logs.extend(
                engine
                    .advance(1.0 / 60.0, 100_000, Duration::from_secs(2))
                    .unwrap()
                    .logs,
            );
        }
        assert_eq!(logs, expected, "jit={jit}");
    }
}
