use nekoc::{
    bcmkn_compiler,
    engine::{Engine, Program},
};
use serde_json::Value;
use std::{fs, time::Duration};
use tempfile::tempdir;

#[test]
fn classes_preserve_javascript_scalar_logs_in_interpreter_and_jit() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("classes.ts");
    let output = dir.path().join("classes.bcmkn");
    fs::write(&input, include_str!("fixtures/ts-classes.ts")).unwrap();
    bcmkn_compiler::compile_ts_bcmkn(&input, "samples/kitten-n-0.27.4.bcmkn", &output).unwrap();
    let project: Value = serde_json::from_slice(&fs::read(output).unwrap()).unwrap();
    let expected = [
        "defaults",
        "0",
        "",
        "false",
        "2",
        "3",
        "initialization",
        "field;constructor;field;constructor;",
        "3",
        "5",
        "3",
        "7",
        "10",
        "81",
        "counter!",
        "15",
        "true",
        "false",
        "identity and containers",
        "86",
        "true",
        "false",
        "7",
        "89",
        "8",
        "true",
        "91",
        "9",
        "true",
        "single evaluation",
        "22",
        "1",
        "1",
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
