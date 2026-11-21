//! r4-lint: advisory analysis of original KN / K4 documents, never execution.
use assert_cmd::Command;
use nekoc::lint::{LARGE_RESOURCE_BYTES, LintReport, build_report};
use serde_json::{Value, json};
use std::fs;

fn kn() -> Value {
    json!({
        "toolType": "KN",
        "scenes": {"scenesDict": {"stage": {"name": "舞台", "nekoBlockJsonList": []}}},
        "actors": {"actorsDict": {"cat/~": {"name": "小猫", "nekoBlockJsonList": []}}},
        "variables": {"variablesDict": {}},
        "styles": {"stylesDict": {}},
        "procedures": {"proceduresDict": {}}
    })
}

fn literal(name: &str) -> Value {
    json!({"type": "broadcast_input", "fields": {"message": name}})
}

fn send(name: &str) -> Value {
    json!({"id": "send", "type": "self_broadcast", "inputs": {"message": literal(name)}})
}

fn codes(report: &LintReport) -> Vec<&str> {
    report.diagnostics.iter().map(|d| d.code).collect()
}

#[test]
fn reports_all_categories_with_original_json_pointers_and_chinese_guidance() {
    let mut project = kn();
    project["variables"]["variablesDict"] = json!({
        "v/~": {"type": "any", "name": "得分", "visible": false, "currentEntity": "cat/~"},
        "list": {"type": "list", "name": "待办"}
    });
    project["actors"]["actorsDict"]["cat/~"]["nekoBlockJsonList"] = json!([
        {"id": "entry", "type": "on_running_group_activated", "next": send("无人接收")},
        {"id": "draft", "type": "self_go_forward"}
    ]);
    project["styles"]["stylesDict"] = json!({
        "first": {"name": "原图", "url": "https://invalid.example/a.png", "size": LARGE_RESOURCE_BYTES + 1},
        "second": {"name": "副本", "url": "https://invalid.example/a.png"}
    });
    let before = project.clone();
    let report = build_report(&project).unwrap();
    assert_eq!(project, before);
    assert_eq!(report.format, "kitten-n");
    assert_eq!(
        codes(&report),
        [
            "unused_variable",
            "unused_list",
            "untriggered_script",
            "broadcast_without_receiver",
            "large_resource",
            "duplicate_costume"
        ]
    );
    for diagnostic in &report.diagnostics {
        assert!(
            project.pointer(&diagnostic.location.path).is_some(),
            "{diagnostic:?}"
        );
        assert_eq!(diagnostic.severity, "warning");
        assert!(diagnostic.message.chars().any(|c| c > '\u{3000}'));
        assert!(!diagnostic.suggestion.is_empty());
    }
    let variable = &report.diagnostics[0];
    assert_eq!(variable.location.path, "/variables/variablesDict/v~1~0");
    assert_eq!(variable.location.owner_name.as_deref(), Some("小猫"));
    let broadcast = &report.diagnostics[3];
    assert_eq!(broadcast.location.block_id.as_deref(), Some("send"));
    assert_eq!(broadcast.location.owner_id.as_deref(), Some("cat/~"));
    assert!(broadcast.location.path.ends_with("/0/next"));
}

#[test]
fn references_in_inputs_statements_procedures_and_monitors_are_not_unused() {
    let mut project = kn();
    project["variables"]["variablesDict"] = json!({
        "write": {"name": "写入"}, "read": {"name": "读取"},
        "list": {"type": "list", "name": "列表名"},
        "monitor": {"visible": true}, "proc": {"name": "过程变量"}
    });
    project["scenes"]["scenesDict"]["stage"]["nekoBlockJsonList"] = json!([{
        "type": "on_running_group_activated", "next": {
            "type": "variables_set", "fields": {"variable": "write"},
            "inputs": {"value": {"type": "variables_get", "fields": {"variable": "read"}}},
            "statements": {"DO": {"type": "list_get", "fields": {"list": "列表名"}}}
        }
    }]);
    project["procedures"]["proceduresDict"]["p"] = json!({"name": "过程", "nekoBlockJsonList": [{"type": "variables_set", "fields": {"variable": "proc"}}]});
    assert!(build_report(&project).unwrap().diagnostics.is_empty());
}

#[test]
fn event_hats_reporters_and_unknown_extensions_are_not_dormant_commands() {
    let mut project = kn();
    project["scenes"]["scenesDict"]["stage"]["nekoBlockJsonList"] = json!([
        {"type": "on_keydown"}, {"type": "start_as_a_mirror"},
        {"type": "when"}, {"type": "procedures_2_defnoreturn"},
        {"type": "variables_get", "is_output": true},
        {"type": "variables_get", "is_output": true, "disabled": true},
        {"type": "custom_extension_hat"}, {"type": "custom_extension_command"},
        {"type": "wait", "is_shadow": true},
        {"id": "off", "type": "on_running_group_activated", "disabled": true}
    ]);
    let report = build_report(&project).unwrap();
    assert_eq!(codes(&report), ["untriggered_script"]);
    assert_eq!(
        report.diagnostics[0].location.block_id.as_deref(),
        Some("off")
    );
}

#[test]
fn static_receivers_match_across_owners_and_dynamic_receivers_suppress_guesses() {
    for receiver_kind in ["self_listen", "self_listen_with_param"] {
        let mut project = kn();
        project["scenes"]["scenesDict"]["stage"]["nekoBlockJsonList"] =
            json!([{"type": "on_running_group_activated", "next": send("消息")}]);
        project["actors"]["actorsDict"]["cat/~"]["nekoBlockJsonList"] =
            json!([{"type": receiver_kind, "inputs": {"message": literal("消息")}}]);
        assert!(build_report(&project).unwrap().diagnostics.is_empty());
        project["actors"]["actorsDict"]["cat/~"]["nekoBlockJsonList"][0]["inputs"]["message"] =
            json!({"type": "variables_get", "fields": {"variable": "runtime-name"}});
        assert!(build_report(&project).unwrap().diagnostics.is_empty());
    }
}

#[test]
fn disabled_and_nested_receivers_do_not_hide_missing_receivers() {
    let mut project = kn();
    project["scenes"]["scenesDict"]["stage"]["nekoBlockJsonList"] = json!([
        {"type": "on_running_group_activated", "next": send("消息")},
        {"type": "self_listen", "disabled": true, "inputs": {"message": literal("消息")}},
        {"type": "when", "statements": {"DO": {"type": "self_listen", "inputs": {"message": literal("消息")}}}}
    ]);
    assert_eq!(
        codes(&build_report(&project).unwrap()),
        ["untriggered_script", "broadcast_without_receiver"]
    );
    project["scenes"]["scenesDict"]["stage"]["nekoBlockJsonList"][0]["next"]["inputs"]["message"] =
        json!({"type": "text_join"});
    assert_eq!(
        codes(&build_report(&project).unwrap()),
        ["untriggered_script"]
    );
}

fn k4() -> Value {
    json!({"work_type": "KITTEN", "theatre": {"scenes": {"stage": {"name": "舞台", "block_data_json": {
        "blocks": {
            "hat": {"type": "start_on_click", "parent_id": null},
            "send": {"type": "self_broadcast", "parent_id": "hat"},
            "message": {"type": "broadcast_input", "fields": {"MESSAGE": "消息"}, "parent_id": "send"},
            "use": {"type": "variables_set", "fields": {"VAR": "used"}, "parent_id": "send"},
            "draft/~": {"id": "draft/~", "type": "self_go_forward"}
        },
        "connections": {
            "hat": {"send": {"type": "next"}},
            "send": {"message": {"type": "input", "input_type": "value", "input_name": "message"}, "use": {"type": "next"}}
        }
    }}}, "actors": {}, "styles": {
        "one": {"url": "data:image/svg+xml,abc", "width": 4097},
        "two": {"url": "data:image/svg+xml,abc"}
    }}, "variables": {"used": {}, "unused": {"type": "list", "name": "空闲列表", "current_entity": "stage"}}})
}

#[test]
fn native_k4_graphs_preserve_original_locations_and_message_fields() {
    let project = k4();
    let report = build_report(&project).unwrap();
    assert_eq!(report.format, "kitten4");
    assert_eq!(
        codes(&report),
        [
            "unused_list",
            "untriggered_script",
            "broadcast_without_receiver",
            "large_resource",
            "duplicate_costume"
        ]
    );
    assert_eq!(
        report.diagnostics[0].location.owner_name.as_deref(),
        Some("舞台")
    );
    assert_eq!(
        report.diagnostics[1].location.path,
        "/theatre/scenes/stage/block_data_json/blocks/draft~1~0"
    );
    for diagnostic in &report.diagnostics {
        assert!(project.pointer(&diagnostic.location.path).is_some());
    }
}

#[test]
fn native_k4_receiver_edges_work_without_importing_or_executing_blocks() {
    let mut project = k4();
    let workspace = &mut project["theatre"]["scenes"]["stage"]["block_data_json"];
    workspace["blocks"]["receive"] = json!({"type": "self_listen", "parent_id": null});
    workspace["blocks"]["receive-message"] =
        json!({"type": "broadcast_input", "fields": {"MESSAGE": "消息"}});
    workspace["connections"]["receive"] = json!({"receive-message": {"type": "input", "input_type": "value", "input_name": "message"}});
    assert!(!codes(&build_report(&project).unwrap()).contains(&"broadcast_without_receiver"));
    project["theatre"]["scenes"]["stage"]["block_data_json"]["blocks"]["receive"]["disabled"] =
        json!(true);
    assert!(codes(&build_report(&project).unwrap()).contains(&"broadcast_without_receiver"));
}

#[test]
fn disabled_statement_chains_suppress_sends_without_suppressing_siblings() {
    let mut project = kn();
    project["scenes"]["scenesDict"]["stage"]["nekoBlockJsonList"] = json!([{
        "type": "on_running_group_activated", "next": {
            "type": "controls_if", "disabled": true,
            "statements": {"DO": {"type": "wait", "next": send("禁用分支")}},
            "next": send("后续命令")
        }
    }]);
    let report = build_report(&project).unwrap();
    assert_eq!(codes(&report), ["broadcast_without_receiver"]);
    assert!(report.diagnostics[0].message.contains("后续命令"));

    let mut project = k4();
    let graph = &mut project["theatre"]["scenes"]["stage"]["block_data_json"];
    graph["blocks"]["hat"]["disabled"] = json!(true);
    graph["blocks"]["branch"] = json!({"type": "controls_if", "disabled": true});
    graph["blocks"]["head"] = json!({"type": "wait"});
    graph["connections"]["hat"] = json!({"branch": {"type": "next"}});
    graph["connections"]["branch"] =
        json!({"head": {"type": "input", "input_type": "statement", "input_name": "DO"}});
    graph["connections"]["head"] = json!({"send": {"type": "next"}});
    assert!(!codes(&build_report(&project).unwrap()).contains(&"broadcast_without_receiver"));
}

#[test]
fn k4_published_ast_without_workspace_fails_instead_of_reporting_unused_data() {
    let mut project = k4();
    project["theatre"]["scenes"]["stage"]
        .as_object_mut()
        .unwrap()
        .remove("block_data_json");
    let error = build_report(&project).unwrap_err().to_string();
    assert!(error.contains("/theatre/scenes/stage"));
    assert!(error.contains("发布 AST"));
}

#[test]
fn asset_thresholds_do_not_guess_remote_sizes_or_empty_url_duplicates() {
    let mut project = kn();
    project["styles"]["stylesDict"] = json!({
        "boundary": {"size": LARGE_RESOURCE_BYTES, "width": 4096, "height": 4096},
        "remote": {"url": "https://invalid.example/unknown.png"},
        "empty1": {"url": ""}, "empty2": {"url": ""},
        "size-object": {"size": {"width": 10, "height": 10}},
        "small": {"url": "data:image/png;base64,YQ=="},
        "invalid": {"url": "data:image/png;base64,===="}
    });
    assert!(build_report(&project).unwrap().diagnostics.is_empty());
    project["audios"] = json!({"audiosDict": {"a": {"fileSize": LARGE_RESOURCE_BYTES + 1}}});
    project["videos"] = json!({"videosDict": {"v": {"file_size": LARGE_RESOURCE_BYTES + 1}}});
    assert_eq!(
        codes(&build_report(&project).unwrap()),
        ["large_resource", "large_resource"]
    );
}

#[test]
fn embedded_base64_and_percent_encoded_resources_count_decoded_bytes() {
    for url in [
        format!(
            "data:audio/wav;base64,{}",
            "YWFh".repeat(LARGE_RESOURCE_BYTES as usize / 3 + 1)
        ),
        format!(
            "data:image/svg+xml,{}",
            "a".repeat(LARGE_RESOURCE_BYTES as usize + 1)
        ),
    ] {
        let mut project = kn();
        project["styles"]["stylesDict"]["large"] = json!({"url": url});
        assert_eq!(codes(&build_report(&project).unwrap()), ["large_resource"]);
    }
    let mut project = kn();
    project["styles"]["stylesDict"]["escaped"] = json!({"url": format!("data:image/svg+xml,{}", "%41".repeat(LARGE_RESOURCE_BYTES as usize / 2))});
    assert!(build_report(&project).unwrap().diagnostics.is_empty());
}

#[test]
fn native_official_editor_fixtures_are_inspected_without_conversion() {
    for fixture in [
        "scheduling-broadcast.bcm",
        "scheduling-broadcast-wait.bcm",
        "actor-variables.bcm",
    ] {
        let path = format!(
            "{}/tests/fixtures/kitten4/{fixture}",
            env!("CARGO_MANIFEST_DIR")
        );
        let project = nekoc::project::load_project(path).unwrap();
        let report = build_report(&project.value).unwrap();
        assert!(
            !codes(&report).contains(&"broadcast_without_receiver"),
            "{fixture}: {report:?}"
        );
        for diagnostic in &report.diagnostics {
            assert!(project.value.pointer(&diagnostic.location.path).is_some());
        }
    }
}

#[test]
fn deep_next_chains_are_iterative_and_locations_remain_complete() {
    let mut project = nekoc::json::Json::new(kn());
    let mut tail = send("深层消息");
    for _ in 0..10_000 {
        let mut block = json!({"type": "wait"});
        block["next"] = tail;
        tail = block;
    }
    project["scenes"]["scenesDict"]["stage"]["nekoBlockJsonList"] = Value::Array(vec![tail]);
    let report = build_report(&project).unwrap();
    assert_eq!(
        codes(&report),
        ["untriggered_script", "broadcast_without_receiver"]
    );
    assert_eq!(
        report.diagnostics[1].location.path.matches("/next").count(),
        10_000
    );
    assert_eq!(
        project
            .pointer(&report.diagnostics[1].location.path)
            .unwrap()["id"],
        "send"
    );
}

fn cli() -> Command {
    Command::cargo_bin("nekoc").unwrap()
}

#[test]
fn cli_json_text_help_exit_codes_and_read_only_contract() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("测试作品.bcmkn");
    let mut project = kn();
    project["variables"]["variablesDict"]["v"] = json!({"name": "闲置变量"});
    let original = serde_json::to_vec(&project).unwrap();
    fs::write(&path, &original).unwrap();
    for global in [true, false] {
        let mut cmd = cli();
        if global {
            cmd.arg("--json");
        }
        cmd.arg("lint").arg(&path);
        if !global {
            cmd.arg("--json");
        }
        let output = cmd.output().unwrap();
        assert!(output.status.success(), "{output:?}");
        assert!(output.stderr.is_empty());
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["ok"], true);
        assert_eq!(report["command"], "lint");
        assert_eq!(
            report["result"]["diagnostics"][0]["code"],
            "unused_variable"
        );
    }
    let text = cli().arg("lint").arg(&path).output().unwrap();
    assert!(text.status.success());
    let text = String::from_utf8(text.stdout).unwrap();
    assert!(
        text.contains("闲置变量")
            && text.contains("/variables/variablesDict/v")
            && text.contains("建议：")
    );
    assert_eq!(fs::read(&path).unwrap(), original);
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    let help = cli().args(["lint", "--help"]).output().unwrap();
    assert!(help.status.success());
    assert!(String::from_utf8_lossy(&help.stdout).contains("不修改作品"));
    cli().args(["lint", "--json"]).assert().code(2);
    let missing = cli()
        .arg("lint")
        .arg(dir.path().join("missing.bcm"))
        .arg("--json")
        .output()
        .unwrap();
    assert_eq!(missing.status.code(), Some(1));
    assert_eq!(
        serde_json::from_slice::<Value>(&missing.stdout).unwrap()["error"]["kind"],
        "file_not_found"
    );
    fs::write(&path, "not json").unwrap();
    cli().arg("lint").arg(&path).arg("--json").assert().code(1);
    assert!(build_report(&json!({})).is_err());
    assert!(build_report(&json!([])).is_err());
}
