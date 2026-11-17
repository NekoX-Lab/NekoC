use nekoc::engine::{Engine, Program};
use serde_json::Value;
use std::{fs, process::Command, time::Duration};

#[test]
fn original_unframed_probe_reproduces_corruption_in_both_modes() {
    let dir = tempfile::tempdir().unwrap();
    let output = dir.path().join("unframed.bcmkn");
    let result = Command::new(env!("CARGO_BIN_EXE_nekoc"))
        .args(["build", "tests/fixtures/tseventframes-broadcast.ts", "-o"])
        .arg(&output)
        .output()
        .unwrap();
    assert!(result.status.success(), "{result:?}");
    let mut work: Value = serde_json::from_slice(&fs::read(output).unwrap()).unwrap();
    // Remove only the frame indirection from local accesses, reconstructing
    // the previous global-binding graph without storing a frozen work fixture.
    fn unframe(node: &mut Value) {
        if let Some(object) = node.as_object_mut() {
            let ty = object.get("type").and_then(Value::as_str).unwrap_or("");
            let frame = object.get("inputs").and_then(|n| n.get("list"));
            if ["replace_list_item", "list_item"].contains(&ty)
                && frame.is_some_and(|n| n["type"] == "procedures_2_parameter")
                && object["inputs"]["list_index"]["fields"]["NUM"] == "1"
            {
                let write = ty == "replace_list_item";
                let value = object["inputs"]["list_item_value"].clone();
                object.insert(
                    "type".into(),
                    Value::from(if write {
                        "variables_set"
                    } else {
                        "variables_get"
                    }),
                );
                object.insert(
                    "fields".into(),
                    serde_json::json!({"variable": "unframed-local"}),
                );
                object.insert(
                    "inputs".into(),
                    if write {
                        serde_json::json!({"value": value})
                    } else {
                        serde_json::json!({})
                    },
                );
            }
            for child in object.values_mut() {
                unframe(child);
            }
        } else if let Some(array) = node.as_array_mut() {
            for child in array {
                unframe(child);
            }
        }
    }
    unframe(&mut work);
    for jit in [false, true] {
        let mut engine = Engine::new(Program::compile(&work).unwrap());
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
        assert_eq!(
            logs,
            ["2", "2", "bad-return-side-effect"],
            "unframed jit={jit}"
        );
    }
}

#[test]
fn overlapping_event_locals_survive_wait_in_interpreter_and_jit() {
    let dir = tempfile::tempdir().unwrap();
    for (name, expected) in [
        ("broadcast", vec!["1", "2"]),
        ("timers", vec!["1 1", "2 2", "shared 2 3"]),
        ("intervals", vec!["1 1", "2 2"]),
        ("inline", vec!["1 1", "2 2"]),
        (
            "complex",
            vec![
                "callbacks 1 2 2",
                "1 1 8",
                "inline 1",
                "callbacks 2 4 3",
                "2 2 13",
                "inline 2",
                "shared 2 3 3 2",
            ],
        ),
        (
            "clones",
            vec![
                "1 1 true", "2 2 true", "3 3 true", "4 4 true", "5 5 true", "6 6 true",
            ],
        ),
        ("stop", vec!["2"]),
        (
            "flow",
            vec![
                "switch two",
                "switch one",
                "try two",
                "try one",
                "loop done 2",
                "loop one",
                "loop done 1",
                "continue done 2",
                "continue done 1",
            ],
        ),
        (
            "nested",
            vec![
                "warp 9",
                "repeat hello 2",
                "if 9",
                "array 10",
                "destructure 12",
                "event-array 10",
            ],
        ),
        (
            "return-loops",
            vec![
                "for 7",
                "do 8",
                "conditional 1",
                "do-continue 2",
                "fallthrough 1",
                "fallthrough done",
            ],
        ),
    ] {
        if !["inline", "clones"].contains(&name) {
            let oracle = Command::new("node")
                .args(["tests/tseventframes-oracle.mjs", name])
                .output()
                .unwrap();
            assert!(oracle.status.success(), "{oracle:?}");
            let node_logs: Vec<String> = serde_json::from_slice(&oracle.stdout).unwrap();
            assert_eq!(node_logs, expected, "Node oracle {name}");
        }
        for optimize in [false, true] {
            let output = dir.path().join(format!("{name}-{optimize}.bcmkn"));
            let mut build = Command::new(env!("CARGO_BIN_EXE_nekoc"));
            build
                .args([
                    "build",
                    &format!("tests/fixtures/tseventframes-{name}.ts"),
                    "-o",
                ])
                .arg(&output);
            if optimize {
                build.arg("--optimize");
            }
            let result = build.output().unwrap();
            assert!(result.status.success(), "{result:?}");
            let work: Value = serde_json::from_slice(&fs::read(output).unwrap()).unwrap();
            for jit in [false, true] {
                let mut engine = Engine::new(Program::compile(&work).unwrap());
                if !jit {
                    engine.disable_jit();
                }
                engine.use_virtual_clock();
                // Starting while the previous invocation is suspended cancels
                // its continuations; no old frame may resume into the new run.
                engine.start();
                for _ in 0..3 {
                    engine
                        .advance(1.0 / 60.0, 100_000, Duration::from_secs(2))
                        .unwrap();
                }
                for _ in 0..2 {
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
}
