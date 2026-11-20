use nekoc::{
    bcmkn_compiler::{assemble_workspace_bcmkn, default_template},
    engine::{Engine, Program},
    json::Json,
    player::{FrameInput, Handshake, Player, error_message},
    ts_frontend,
};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};

fn compile(dir: &Path, source: &str, template: Json) -> Json {
    let input = dir.join("r2-srcmap.ts");
    let report = dir.join("workspace.json");
    std::fs::write(&input, source).unwrap();
    ts_frontend::compile_ts(&input, &report).unwrap();
    let report: Value = serde_json::from_slice(&std::fs::read(report).unwrap()).unwrap();
    assemble_workspace_bcmkn(&report, "r2-srcmap", template).unwrap()
}

fn find_block<'a>(project: &'a Value, kind: &str) -> &'a Value {
    let mut pending = vec![project];
    while let Some(value) = pending.pop() {
        if value.get("type").and_then(Value::as_str) == Some(kind) {
            return value;
        }
        match value {
            Value::Object(map) => pending.extend(map.values()),
            Value::Array(array) => pending.extend(array),
            _ => {}
        }
    }
    panic!("missing {kind}");
}

fn run_error(project: &Value, interpreter: bool) -> String {
    let mut vm = Engine::new(Program::compile(project).unwrap());
    if interpreter {
        vm.disable_jit();
    }
    vm.use_virtual_clock();
    vm.start();
    for _ in 0..20 {
        if let Err(error) = vm.advance(1.0 / 60.0, 2_000_000, Duration::from_secs(5)) {
            return format!("{error:#}");
        }
    }
    panic!("expected a runtime error");
}

#[test]
fn ts_locations_reach_cli_and_player_and_move_after_recompilation() {
    let dir = tempfile::tempdir().unwrap();
    let source = "sprite(\"Cat\", {}, () => {\n  onStart(() => {\n    setStyle(99);\n  });\n});";
    let mut template = default_template();
    template["sourceMap"] = json!({"b2": {"file": "old.ts", "line": 99, "column": 1}});
    for (prefix, line) in [("", 3), ("// moved\n\n", 5)] {
        let project = compile(dir.path(), &format!("{prefix}{source}"), template);
        let block = find_block(&project, "set_sprite_style")["id"]
            .as_str()
            .unwrap();
        let location = &project["sourceMap"][block];
        assert_eq!(location["line"], line);
        assert_eq!(location["column"], 5);
        let source_location = format!("{}:{line}:5", location["file"].as_str().unwrap());
        for interpreter in [true, false] {
            let message = run_error(&project, interpreter);
            for expected in [
                "invalid costume",
                "actor Cat (nekoc-actor-Cat)",
                block,
                &source_location,
            ] {
                assert!(message.contains(expected), "missing {expected}: {message}");
            }
            assert!(!message.contains("old.ts"));
        }
        let mut player = Player::load(Handshake::new(project.clone())).unwrap();
        let error = (0..20)
            .find_map(|_| player.frame(&FrameInput::default()).err())
            .unwrap();
        let wire: Value = serde_json::from_str(&error_message(&error)).unwrap();
        assert!(wire["error"].as_str().unwrap().contains(&source_location));
        assert!(wire["error"].as_str().unwrap().contains("actor Cat"));
        let path = dir.path().join("work.bcmkn");
        std::fs::write(&path, serde_json::to_vec(&*project).unwrap()).unwrap();
        let output = std::process::Command::new(env!("CARGO_BIN_EXE_nekoc"))
            .args(["run", path.to_str().unwrap(), "--ticks", "2"])
            .output()
            .unwrap();
        assert!(!output.status.success());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains(&source_location), "{stderr}");
        assert!(
            stderr.contains(block) && stderr.contains("actor Cat"),
            "{stderr}"
        );
        template = project;
    }
}

#[test]
fn missing_current_mapping_clears_template_and_imports_keep_block_identity() {
    let dir = tempfile::tempdir().unwrap();
    let project = compile(
        dir.path(),
        "onStart(() => { setStyle(99); });",
        default_template(),
    );
    let report_path = dir.path().join("workspace.json");
    let mut report: Value = serde_json::from_slice(&std::fs::read(report_path).unwrap()).unwrap();
    report.as_object_mut().unwrap().remove("sourceMap");
    let project = assemble_workspace_bcmkn(&report, "block-only", project).unwrap();
    assert!(project.get("sourceMap").is_none());
    let id = find_block(&project, "set_sprite_style")["id"]
        .as_str()
        .unwrap();
    let (imported, _) = nekoc::player::import(project.clone()).unwrap();
    let error = run_error(&imported, true);
    assert!(
        error.contains("[actor ") && error.contains(&format!("at block {id}")),
        "{error}"
    );
    assert!(!error.contains("r2-srcmap.ts"));
}

#[test]
fn unknown_parameter_errors_name_the_reporter_and_source() {
    let mut project = default_template();
    project["actors"]["actorsDict"]["nekoc-default-actor"]["name"] = json!("参数猫");
    project["actors"]["actorsDict"]["nekoc-default-actor"]["nekoBlockJsonList"] = json!([{
        "id": "hat", "type": "on_running_group_activated", "next": {
            "id": "log", "type": "console_log", "inputs": {"console_log": {
                "id": "missing-param", "type": "procedures_2_parameter", "fields": {"param_name": "unknown"}
            }}
        }
    }]);
    project["sourceMap"] =
        json!({"missing-param": {"file": "lib/参数.ts", "line": 7, "column": 9}});
    let error = format!("{:#}", Program::compile(&project).unwrap_err());
    for expected in [
        "unknown procedure parameter",
        "参数猫",
        "at block missing-param",
        "lib/参数.ts:7:9",
    ] {
        assert!(error.contains(expected), "missing {expected}: {error}");
    }
}

#[test]
fn nested_procedure_failures_keep_the_inner_block_and_calling_actor() {
    let dir = tempfile::tempdir().unwrap();
    let source = "defineProc(\"bad\", [], () => {\n  setStyle(99);\n});\nsprite(\"Cat\", {}, () => { onStart(() => { callProc(\"bad\"); }); });";
    let project = compile(dir.path(), source, default_template());
    let inner = find_block(&project, "set_sprite_style")["id"]
        .as_str()
        .unwrap();
    for interpreter in [true, false] {
        let error = run_error(&project, interpreter);
        assert!(error.contains("r2-srcmap.ts:2:3"), "{error}");
        assert!(error.contains(&format!("at block {inner}")), "{error}");
        assert_eq!(error.matches("[actor Cat").count(), 1, "{error}");
    }
}

#[test]
fn imported_k4_list_bounds_errors_keep_reporter_identity_without_source_files() {
    let source =
        nekoc::json::from_str(include_str!("fixtures/kitten4/scheduling-order.bcm")).unwrap();
    let mut project = nekoc::kitten4::to_neko(&source).unwrap();
    let actor = project["actors"]["actorsDict"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap();
    actor["name"] = json!("List cat");
    actor["nekoBlockJsonList"] = json!([{
        "id":"hat", "type":"on_running_group_activated", "next":{
            "id":"assign", "type":"variables_set", "fields":{"variable":"log"}, "inputs":{"value":{
                "id":"bounds", "type":"list_item", "fields":{"item":"any"}, "inputs":{
                    "list":{"type":"temporary_list","inputs":{}},
                    "list_index":{"type":"math_number","fields":{"NUM":1}}
                }
            }}
        }
    }]);
    for interpreter in [true, false] {
        let error = run_error(&project, interpreter);
        assert!(error.contains("lists_get_value_bad_index"), "{error}");
        assert!(error.contains("[actor List cat"), "{error}");
        assert!(error.ends_with("at block bounds"), "{error}");
        assert!(!error.contains(".ts:"), "{error}");
    }
}
