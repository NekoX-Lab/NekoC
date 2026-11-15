use nekoc::{
    bcmkn_compiler,
    engine::{Engine, Program},
};
use serde_json::Value;
use std::{fs, time::Duration};
use tempfile::tempdir;

#[test]
fn nullable_values_preserve_javascript_logs_in_interpreter_and_jit() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("nullable.ts");
    let output = dir.path().join("nullable.bcmkn");
    fs::write(&input, include_str!("fixtures/ts-nullable.ts")).unwrap();
    bcmkn_compiler::compile_ts_bcmkn(&input, "samples/kitten-n-0.27.4.bcmkn", &output).unwrap();
    let project: Value = serde_json::from_slice(&fs::read(output).unwrap()).unwrap();
    let expected = [
        "printing",
        "null undefined null undefined undefined",
        "s=undefined t=null null null",
        "null true",
        "linked list",
        "100 4",
        "40 20 undefined",
        "10 undefined",
        "binary tree",
        "4 10 true false",
        "true 50 20",
        "true true false",
        "optional config",
        "a:100:untitled:false",
        "b:0::true",
        "undefined undefined true",
        "5 64",
        "nullable results",
        "1 null -1",
        "at 3",
        "kit 3",
        "one undefined many",
        "case null",
        "arrays of nullable values",
        "4 1 true 4",
        "1,0,3,0",
        "comparison and truthiness",
        "true true true false false",
        "9 0 false",
        "falsy zero",
        "empty falsy",
        "no flag",
        "single evaluation",
        "101 101",
        "5 201",
        "undefined 201",
        "202 202",
        "box 7",
        "box 7",
        "7",
        "-1 true",
        "-1 3",
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
