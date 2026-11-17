use nekoc::{
    bcmkn_compiler::{self, workspace_data_to_neko_blocks},
    check,
    engine::{Engine, Program},
    optimizer, validate,
};
use serde_json::{Value, json};
use std::{fs, process::Command, time::Duration};

fn advance(engine: &mut Engine, frames: usize) -> Vec<String> {
    let mut logs = Vec::new();
    for _ in 0..frames {
        logs.extend(
            engine
                .advance(1.0 / 60.0, 1_000_000, Duration::from_secs(5))
                .unwrap()
                .logs,
        );
    }
    logs
}

#[test]
fn knterminalshape_checks_and_assembles_only_legal_next_sockets() {
    for terminal in ["dispose_clone", "restart"] {
        let workspace = json!({"blocks": {
            "end":{"id":"end", "type":terminal},
            "after":{"id":"after", "type":"console_log", "parent_id":"end"}
        }, "connections":{"end":{"after":{"type":"next"}}}});
        let error = workspace_data_to_neko_blocks(&workspace).unwrap_err();
        assert!(error.to_string().contains("has no next socket"));
        for (section, dict, kind) in [
            ("actors", "actorsDict", "actor"),
            ("scenes", "scenesDict", "scene"),
            ("procedures", "proceduresDict", "procedure"),
        ] {
            for container in ["next", "inputs", "statements"] {
                let end = json!({"id":"end", "type":terminal, "parent_id":"outer", "next":{
                    "id":"after", "type":"console_log", "parent_id":"end"}});
                let mut outer = json!({"id":"outer", "type":"controls_if"});
                if container == "next" {
                    outer[container] = end;
                } else {
                    outer[container] = json!({"DO0":end});
                }
                let mut project = json!({});
                project[section] = json!({dict:{"owner":{"nekoBlockJsonList":[outer]}}});
                let diagnostics = check::project_diagnostics(&project, None).unwrap();
                let issue = diagnostics
                    .iter()
                    .find(|d| d.code == "terminal_block_has_next")
                    .unwrap();
                assert_eq!(issue.source, "project");
                if container == "next" {
                    let dir = tempfile::tempdir().unwrap();
                    let input = dir.path().join("invalid.bcmkn");
                    fs::write(&input, serde_json::to_vec(&project).unwrap()).unwrap();
                    let checked =
                        check::check_file(&input, &check::CheckOptions::default()).unwrap();
                    assert!(!checked.ok);
                    assert!(
                        checked
                            .diagnostics
                            .iter()
                            .any(|d| d.code == "terminal_block_has_next")
                    );
                }
                let report = validate::build_report(&project).unwrap();
                assert!(
                    report["issues"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|i| i["owner_kind"] == kind && i["block_type"] == terminal)
                );
                let mut native = project.clone();
                native["_nekocKitten4"] = json!({"source":null});
                assert!(
                    !check::project_diagnostics(&native, None)
                        .unwrap()
                        .iter()
                        .any(|d| d.code == "terminal_block_has_next")
                );
                // A serialized null next is an absent edge.
                let outer = &mut project[section][dict]["owner"]["nekoBlockJsonList"][0];
                let end = if container == "next" {
                    &mut outer[container]
                } else {
                    &mut outer[container]["DO0"]
                };
                end["next"] = Value::Null;
                assert!(
                    !check::project_diagnostics(&project, None)
                        .unwrap()
                        .iter()
                        .any(|d| d.code == "terminal_block_has_next")
                );
            }
        }
    }
    let stop = json!({"blocks":{"s":{"id":"s","type":"stop"},"n":{"id":"n","type":"console_log"}},
        "connections":{"s":{"n":{"type":"next"}}}});
    assert!(
        workspace_data_to_neko_blocks(&stop).unwrap()[0]
            .get("next")
            .is_some()
    );
}

#[test]
fn knterminalshape_preserves_continuations_and_task_lifecycle_in_interpreter_and_jit() {
    let dir = tempfile::tempdir().unwrap();
    let prepared = dir.path().join("cases.json");
    let output = Command::new("node")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .arg("tests/knterminalshape-cases.mjs")
        .arg(&prepared)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: Vec<Value> = serde_json::from_slice(&fs::read(prepared).unwrap()).unwrap();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        for optimize in [false, true] {
            let report = if optimize {
                optimizer::optimize_report(&case["report"])
            } else {
                case["report"].clone()
            };
            let work = bcmkn_compiler::assemble_workspace_bcmkn(
                &report,
                name,
                bcmkn_compiler::default_template(),
            )
            .unwrap();
            assert!(
                validate::build_report(&work).unwrap()["ok"]
                    .as_bool()
                    .unwrap(),
                "{name}"
            );
            if let Some(path) = std::env::var_os("NEKOC_TERMINAL_ARTIFACTS") {
                fs::write(
                    std::path::Path::new(&path).join(format!("{name}-{optimize}.bcmkn")),
                    serde_json::to_vec(&work).unwrap(),
                )
                .unwrap();
            }
            for jit in [false, true] {
                let make_engine = || {
                    let mut engine = Engine::new(Program::compile(&work).unwrap());
                    if !jit {
                        engine.disable_jit();
                    }
                    engine.use_virtual_clock();
                    engine.enable_jit_profile();
                    engine.start();
                    engine
                };
                let mut engine = make_engine();
                match name {
                    "continuation" => {
                        let logs = advance(&mut engine, 20);
                        assert_eq!(
                            logs,
                            serde_json::from_value::<Vec<String>>(case["expected"].clone())
                                .unwrap(),
                            "jit={jit} optimize={optimize}"
                        );
                        assert_eq!(engine.active_tasks(), 0);
                        if jit {
                            assert!(engine.jit_profile()["native_ops"].as_u64().unwrap() > 0);
                        }
                    }
                    "cancellation" => {
                        assert!(advance(&mut engine, 3).is_empty());
                        engine.key("66");
                        advance(&mut engine, 1);
                        engine.key_event("66", false);
                        engine.key("65");
                        let mut logs = advance(&mut engine, 1);
                        engine.key_event("65", false);
                        logs.extend(advance(&mut engine, 20));
                        logs.sort();
                        assert_eq!(
                            logs,
                            ["alive:0", "observer", "pending:0"],
                            "jit={jit} optimize={optimize}"
                        );
                        assert_eq!(engine.active_tasks(), 0);
                    }
                    "restart" => {
                        for key in ["65", "67", "68"] {
                            let mut engine = make_engine();
                            assert_eq!(advance(&mut engine, 2), ["start"]);
                            engine.key("66");
                            advance(&mut engine, 1);
                            engine.key_event("66", false);
                            engine.key(key);
                            let mut logs = advance(&mut engine, 1);
                            engine.key_event(key, false);
                            logs.extend(advance(&mut engine, 20));
                            // Restart also clears logs buffered by the old run.
                            assert_eq!(logs, ["start"], "key={key} jit={jit} optimize={optimize}");
                            assert_eq!(engine.active_tasks(), 0);
                        }
                    }
                    "stop" | "minimal" => {
                        assert!(advance(&mut engine, 2).is_empty());
                    }
                    _ => unreachable!(),
                }
            }
        }
    }
}
