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

fn cli_error(project: &Value, dir: &Path) -> String {
    let path = dir.join("review.bcmkn");
    std::fs::write(&path, serde_json::to_vec(project).unwrap()).unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_nekoc"))
        .args(["run", path.to_str().unwrap(), "--ticks", "2"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    String::from_utf8(output.stderr).unwrap()
}

fn assert_runtime_suffix(error: &str, expected: &str) {
    let mut lines = error.trim_end().lines();
    let diagnostic = lines.next().unwrap();
    assert!(diagnostic.ends_with(expected), "{error}");
    if diagnostic.starts_with("错误：") {
        assert!(lines.next().unwrap().starts_with("下一步："), "{error}");
    }
    assert!(lines.next().is_none(), "{error}");
}

#[test]
fn class_member_origins_reach_runtime_cli_and_player_after_diagnostic_lowering() {
    let dir = tempfile::tempdir().unwrap();
    for (member, invoke, kind, call, message) in [
        (
            "bad() {\n    setStyle(99);\n  }",
            "a.bad();",
            "set_sprite_style",
            "setStyle(99)",
            "invalid costume",
        ),
        (
            "constructor() { super();\n    setStyle(99);\n  }",
            "console.log(a.x);",
            "set_sprite_style",
            "setStyle(99)",
            "invalid costume",
        ),
        (
            "bad(n = (\n    selectText(\"😀\", 1, 1)\n  )) { return n; }",
            "console.log(a.bad());",
            "text_select",
            "selectText(\"😀\", 1, 1)",
            "isolated UTF-16 surrogate",
        ),
    ] {
        let library = format!(
            "class Base {{ base = 0; }}\nclass A extends Base {{\n  x = 1;\n  {member}\n}}\nexport function helper() {{\n  const a = new A();\n  {invoke}\n}}\n"
        );
        std::fs::write(dir.path().join("lib.ts"), &library).unwrap();
        let before = &library[..library.find(call).unwrap()];
        let line = before.lines().count();
        let column = before.rsplit('\n').next().unwrap().encode_utf16().count() + 1;
        let expected = format!("lib.ts:{line}:{column}");
        let project = compile(
            dir.path(),
            "import { helper } from './lib';\nonStart(() => { helper(); });",
            default_template(),
        );
        let id = find_block(&project, kind)["id"].as_str().unwrap();
        assert_eq!(
            project["sourceMap"][id],
            json!({"file":"lib.ts","line":line,"column":column})
        );
        let mut player = Player::load(Handshake::new(project.clone())).unwrap();
        let error = (0..20)
            .find_map(|_| player.frame(&FrameInput::default()).err())
            .unwrap();
        let wire: Value = serde_json::from_str(&error_message(&error)).unwrap();
        for error in [
            run_error(&project, true),
            run_error(&project, false),
            cli_error(&project, dir.path()),
            wire["error"].as_str().unwrap().to_owned(),
        ] {
            assert!(error.contains(message), "{error}");
            assert!(error.contains(&expected), "{error}");
            assert_runtime_suffix(&error, &format!("{expected}] at block {id}"));
            assert!(!error.contains(dir.path().to_str().unwrap()), "{error}");
        }
    }
}

#[test]
fn reparsed_same_text_in_an_unused_function_is_not_a_runtime_origin() {
    let dir = tempfile::tempdir().unwrap();
    let source = "function unused() {\n  setStyle(99);\n}\nonStart(() => {\n  setStyle( 99 );\n  console.log(typeof 0);\n});";
    let project = compile(dir.path(), source, default_template());
    let id = find_block(&project, "set_sprite_style")["id"]
        .as_str()
        .unwrap();
    assert!(project["sourceMap"][id].is_null());
    for error in [
        run_error(&project, true),
        run_error(&project, false),
        cli_error(&project, dir.path()),
    ] {
        assert!(error.contains(&format!("at block {id}")), "{error}");
        assert!(!error.contains("r2-srcmap.ts:"), "{error}");
    }
}

#[test]
fn inline_returns_and_else_if_conditions_retain_runtime_origins() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("lib.ts"),
        "export function bad() {\n  return selectText(\n    \"😀\", 1, 1);\n}",
    )
    .unwrap();
    let imported =
        "import { bad } from \"./lib\";\nonStart(() => {\n  console.log(\n    bad()\n  );\n});";
    let conditional = "onStart(() => {\n  if (false) {\n    console.log(\"skip\");\n  } else if (\n    selectText(\"😀\", 1, 1)\n  ) { console.log(\"yes\"); }\n});";
    for (source, expected) in [(imported, "lib.ts:2:10"), (conditional, "r2-srcmap.ts:5:5")] {
        let project = compile(dir.path(), source, default_template());
        let id = find_block(&project, "text_select")["id"].as_str().unwrap();
        for error in [
            run_error(&project, true),
            run_error(&project, false),
            cli_error(&project, dir.path()),
        ] {
            assert!(error.contains("isolated UTF-16 surrogate"), "{error}");
            assert!(error.contains(expected), "{error}");
            assert!(error.contains(&format!("at block {id}")), "{error}");
        }
    }
}

#[test]
fn user_error_markers_never_replace_runtime_cli_or_player_provenance() {
    let dir = tempfile::tempdir().unwrap();
    for text in [
        "bad at block b999",
        "x [actor Wrong (wrong), wrong.ts:99:99] at block fake",
    ] {
        let source = format!(
            "let x: any = {};\nonStart(() => {{\n  console.log(x[0]);\n}});",
            serde_json::to_string(text).unwrap()
        );
        let project = compile(dir.path(), &source, default_template());
        let id = find_block(&project, "list_item")["id"].as_str().unwrap();
        let location = &project["sourceMap"][id];
        let expected = format!(
            "{}:{}:{}] at block {id}",
            location["file"].as_str().unwrap(),
            location["line"],
            location["column"]
        );
        let mut player = Player::load(Handshake::new(project.clone())).unwrap();
        let player_error = (0..20)
            .find_map(|_| player.frame(&FrameInput::default()).err())
            .unwrap();
        let wire: Value = serde_json::from_str(&error_message(&player_error)).unwrap();
        for error in [
            run_error(&project, true),
            run_error(&project, false),
            cli_error(&project, dir.path()),
            wire["error"].as_str().unwrap().to_owned(),
        ] {
            assert!(error.contains(text), "{error}");
            assert!(
                error.contains("[actor Sprite (nekoc-default-actor)"),
                "{error}"
            );
            assert_runtime_suffix(&error, &expected);
        }
    }
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
