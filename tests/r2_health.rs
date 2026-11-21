use nekoc::{json::Json, player, studio::document::Document};
use serde_json::{Value, json};

fn project(roots: Value) -> Value {
    let mut project = Document::blank().value().clone();
    project["actors"]["actorsDict"]["nekoc-default-actor"]["nekoBlockJsonList"] = roots;
    project
}

fn health(project: Value) -> Value {
    let (_, imported) = player::import(Json::new(project)).unwrap();
    imported["health_report"].clone()
}

fn items(report: &Value) -> &[Value] {
    report["items"].as_array().unwrap()
}

#[test]
fn unknown_loose_blocks_are_preserved_but_never_certified() {
    let original = project(
        json!([{"id":"loose","type":"future_reporter","is_output":true,"custom":{"keep":1}}]),
    );
    let (imported, report) = player::import(Json::new(original.clone())).unwrap();
    assert_eq!(*imported, original);
    let report = &report["health_report"];
    let loose = items(report)
        .iter()
        .find(|item| item["block"] == "loose")
        .unwrap();
    assert_eq!(loose["category"], "unverified");
    assert_eq!(loose["block_type"], "future_reporter");
    assert_eq!(loose["owner"], "nekoc-default-actor");
    assert!(loose["scene"].is_string());
    assert_eq!(report["summary"]["preserve"], 1);
    assert_eq!(report["summary"]["executable"], 1);
    assert!(report["summary"]["unverified"].as_u64().unwrap() >= 2);
    assert_eq!(report["text"], nekoc::health::text_summary(report));
}

#[test]
fn compile_errors_locate_nested_blocks_not_only_the_event_hat() {
    let report = health(project(
        json!([{"id":"hat","type":"on_running_group_activated",
        "next":{"id":"bad","type":"future_command","next":{"id":"later","type":"future_command_2"}}}]),
    ));
    let issue = items(&report)
        .iter()
        .find(|item| item["code"] == "script_compile_failed")
        .unwrap();
    assert_eq!(issue["block"], "bad", "{report}");
    assert_eq!(issue["block_type"], "future_command");
    assert_eq!(issue["category"], "unsupported");
    assert_eq!(report["summary"]["executable"], 0);
    assert!(
        items(&report)
            .iter()
            .any(|item| item["block"] == "later" && item["category"] == "unverified")
    );
}

#[test]
fn diagnostic_owner_names_cannot_masquerade_as_block_ids() {
    let mut p = project(json!([{"id":"hat","type":"on_running_group_activated",
        "next":{"id":"real-error","type":"future_command"}}]));
    p["actors"]["actorsDict"]["nekoc-default-actor"]["name"] = json!("hat");
    let report = health(p);
    let issue = items(&report)
        .iter()
        .find(|item| item["code"] == "script_compile_failed")
        .unwrap();
    assert_eq!(issue["block"], "real-error");
}

#[test]
fn camera_backend_requirement_is_explicit_even_for_dormant_blocks() {
    let report = health(project(
        json!([{"id":"hat","type":"on_running_group_activated",
        "next":{"id":"camera","type":"open_hide_camera","fields":{"camera_status":"turn_on"}}}]),
    ));
    assert!(
        items(&report)
            .iter()
            .any(|item| item["block"] == "camera" && item["category"] == "unsupported")
    );
    let close = health(project(
        json!([{"id":"close","type":"open_hide_camera","fields":{"camera_status":"turn_off"}}]),
    ));
    assert!(
        items(&close)
            .iter()
            .any(|item| item["block"] == "close" && item["category"] == "approximate")
    );
}

#[test]
fn translation_is_an_explicit_degradation_not_a_working_service() {
    let report = health(project(
        json!([{"id":"translation","type":"translate_result","is_output":true}]),
    ));
    let issue = items(&report)
        .iter()
        .find(|item| item["block"] == "translation")
        .unwrap();
    assert_eq!(issue["category"], "approximate");
    assert!(issue["impact"].as_str().unwrap().contains("成功翻译服务"));
}

#[test]
fn legacy_translator_placeholders_are_all_located_including_after_first_error() {
    let report = health(project(
        json!([{"id":"hat","type":"on_running_group_activated","next":{
        "id":"placeholder-one","type":"bcm_translator_text_execution_block","disabled":false,
        "mutation":"<mutation>测试占位描述</mutation>",
        "next":{"id":"placeholder-two","type":"bcm_translator_text_execution_block"}}}]),
    ));
    for id in ["placeholder-one", "placeholder-two"] {
        assert!(items(&report).iter().any(|item| item["block"] == id
            && item["category"] == "unsupported"
            && item["code"] == "known_limitation"));
    }
    assert_eq!(report["summary"]["executable"], 0);
}

#[test]
fn disabled_legacy_execution_placeholders_are_skips_not_restored_instructions() {
    let report = health(project(
        json!([{"id":"hat","type":"on_running_group_activated",
        "next":{"id":"disabled-placeholder","parent_id":"hat","type":"bcm_translator_text_execution_block",
            "disabled":true,"mutation":"<mutation>不是可执行指令</mutation>",
            "inputs":{"obsolete":{"id":"stale-input","parent_id":"disabled-placeholder","type":"future_reporter"}},
            "statements":{"obsolete":{"id":"stale-body","parent_id":"disabled-placeholder","type":"future_command"}}}}]),
    ));
    let issue = items(&report)
        .iter()
        .find(|item| item["block"] == "disabled-placeholder" && item["code"] == "known_limitation")
        .unwrap();
    assert_eq!(issue["category"], "approximate");
    assert_eq!(issue["code"], "known_limitation");
    assert!(issue["impact"].as_str().unwrap().contains("跳过"));
    assert_eq!(report["summary"]["executable"], 1);
    assert_eq!(report["summary"]["unsupported"], 0);
    for id in ["stale-input", "stale-body"] {
        assert!(
            items(&report)
                .iter()
                .any(|item| item["block"] == id && item["category"] == "unverified")
        );
    }
}

#[test]
fn structural_failures_keep_the_owner_and_block_location() {
    let report = health(project(
        json!([{"id":"broken","type":"on_running_group_activated","parent_id":"missing"}]),
    ));
    let issue = items(&report)
        .iter()
        .find(|item| item["code"] == "invalid_structure")
        .unwrap();
    assert_eq!(issue["owner"], "nekoc-default-actor");
    assert_eq!(issue["block"], "broken");
    assert_eq!(issue["block_type"], "on_running_group_activated");
}

#[test]
fn inactive_scenes_and_global_procedures_are_included() {
    let mut p = project(json!([]));
    p["scenes"]["scenesDict"]["inactive"] = json!({"id":"inactive","name":"第二场景","actorIds":[],
        "nekoBlockJsonList":[{"id":"inactive-hat","type":"on_unknown_health_event"}]});
    p["scenes"]["sortList"]
        .as_array_mut()
        .unwrap()
        .push(json!("inactive"));
    p["procedures"]["proceduresDict"]["proc"] = json!({"id":"proc","name":"过程","params":[],
        "nekoBlockJsonList":[{"id":"proc-body","type":"future_reporter","is_output":true}]});
    let report = health(p);
    assert!(
        items(&report)
            .iter()
            .any(|item| item["scene"] == "inactive" && item["block"] == "inactive-hat")
    );
    assert!(
        items(&report)
            .iter()
            .any(|item| item["owner_kind"] == "procedure" && item["block"] == "proc-body")
    );
}

#[test]
fn k4_unknown_blocks_are_retained_and_reported_with_canonical_ids() {
    let source = json!({"version":25,"work_type":"KITTEN",
        "theatre":{"current_scene":"s","scenes_order":["s"],
            "scenes":{"s":{"id":"s","name":"场景","actors":["a"]}},"actors":{"a":{"id":"a","name":"角色"}}},
        "compile_result":[{"id":"a","compiled_block_map":{"root":{"type":"start_on_click","id":"root",
            "next_block":{"type":"future_unsupported","id":"opaque"}}}}]});
    let (canonical, imported) = player::import(Json::new(source.clone())).unwrap();
    assert_eq!(*nekoc::kitten4::from_neko(&canonical).unwrap(), source);
    let report = &imported["health_report"];
    assert_eq!(report["format"], "kitten4");
    assert_eq!(report["summary"]["preserve"], 1);
    assert!(
        items(report)
            .iter()
            .any(|item| item["category"] == "unsupported"
                && item["owner"] == "a"
                && item["block"] == "opaque"
                && item["block_type"] == "kitten4::future_unsupported"),
        "{report}"
    );
}

#[test]
fn cli_report_matches_import_json_and_text_without_writing_a_project() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("health.bcmkn");
    let p = project(json!([{"id":"hat","type":"on_running_group_activated",
        "next":{"id":"bad","type":"future_command"}}]));
    std::fs::write(&input, serde_json::to_vec(&p).unwrap()).unwrap();
    let expected = health(p);
    let output = assert_cmd::Command::cargo_bin("nekoc")
        .unwrap()
        .args(["check", "--report", "--json"])
        .arg(&input)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        expected
    );
    let output = assert_cmd::Command::cargo_bin("nekoc")
        .unwrap()
        .args(["check", "--report"])
        .arg(&input)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        String::from_utf8(output.stdout)
            .unwrap()
            .replace("\r\n", "\n"),
        expected["text"]
    );
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn empty_project_still_reports_unverified_runtime_and_all_five_counts() {
    let report = health(project(json!([])));
    for category in [
        "preserve",
        "executable",
        "approximate",
        "unverified",
        "unsupported",
    ] {
        assert_eq!(
            report["summary"][category].as_u64().unwrap() as usize,
            items(&report)
                .iter()
                .filter(|item| item["category"] == category)
                .count()
        );
    }
    assert!(
        items(&report)
            .iter()
            .any(|item| item["code"] == "runtime_not_exercised")
    );
}

#[test]
fn missing_block_ids_stay_explicit_in_the_report() {
    let report = health(project(
        json!([{"type":"future_reporter","is_output":true}]),
    ));
    let issue = items(&report)
        .iter()
        .find(|item| item["block_type"] == "future_reporter")
        .unwrap();
    assert!(issue["block"].is_null());
    assert_eq!(issue["category"], "unverified");
    assert_eq!(issue["owner"], "nekoc-default-actor");
    assert!(report["text"].as_str().unwrap().contains("积木 ID：—"));
}

#[test]
fn missing_compile_probe_is_unknown_not_a_success_or_a_failure() {
    let report = nekoc::health::build_report(&project(json!([])), &json!({}));
    assert_eq!(report["summary"]["executable"], 0);
    assert_eq!(report["summary"]["unsupported"], 0);
    assert!(
        items(&report)
            .iter()
            .any(|item| item["code"] == "vm_compile_unknown" && item["category"] == "unverified")
    );
}

#[test]
fn cli_health_rejects_source_and_frontend_only_flags() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("source.ts");
    std::fs::write(&input, "console.log(1);").unwrap();
    let output = assert_cmd::Command::cargo_bin("nekoc")
        .unwrap()
        .args(["check", "--report"])
        .arg(&input)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("--report requires"));
    for args in [
        vec!["--no-types"],
        vec!["--target", "kitten4"],
        vec!["--template", "base.bcmkn"],
    ] {
        let output = assert_cmd::Command::cargo_bin("nekoc")
            .unwrap()
            .args(["check", "--report"])
            .arg(&input)
            .args(args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
    }
}

#[test]
fn cli_zero_exit_keeps_unknown_state_explicit() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("loose.bcmkn");
    std::fs::write(
        &input,
        serde_json::to_vec(&project(
            json!([{"id":"loose","type":"future_reporter","is_output":true}]),
        ))
        .unwrap(),
    )
    .unwrap();
    let output = assert_cmd::Command::cargo_bin("nekoc")
        .unwrap()
        .args(["check", "--report", "--json"])
        .arg(&input)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        report.get("ok").is_none(),
        "health must not claim a global pass"
    );
    assert!(report["summary"]["unverified"].as_u64().unwrap() > 0);
}

#[test]
fn k4_device_stubs_are_not_promoted_to_complete_support() {
    let source = json!({"version":25,"work_type":"KITTEN",
        "theatre":{"current_scene":"s","scenes_order":["s"],
            "scenes":{"s":{"id":"s","actors":["a"]}},"actors":{"a":{"id":"a"}}},
        "compile_result":[{"id":"a","compiled_block_map":{"root":{"type":"start_on_click","id":"root",
            "next_block":{"type":"set_camera_status","id":"camera-stub","params":{"camera_status":"on"}}}}}]});
    let report = health(source);
    assert!(
        items(&report)
            .iter()
            .any(|item| item["block"] == "camera-stub" && item["category"] == "approximate"),
        "{report}"
    );
}

#[test]
fn dangling_screen_paths_locate_nested_blocks_with_punctuation_in_owner_and_socket_ids() {
    let mut p = project(json!([]));
    let id = "actor.[0]/~\"\\";
    let mut actor = p["actors"]["actorsDict"]["nekoc-default-actor"].clone();
    actor["nekoBlockJsonList"] = json!([{"id":"move","type":"self_move_to","inputs":{
        "socket.with[0]/~":{"id":"screen-reference","type":"get_screens","is_output":true,"fields":{"screen_id":"deleted-scene"}}
    }}]);
    p["actors"]["actorsDict"].as_object_mut().unwrap().clear();
    p["actors"]["actorsDict"][id] = actor;
    let scene = p["scenes"]["currentSceneId"].as_str().unwrap().to_owned();
    p["scenes"]["scenesDict"][&scene]["actorIds"] = json!([id]);
    let report = health(p);
    let issue = items(&report)
        .iter()
        .find(|item| {
            item["code"] == "invalid_structure"
                && item["impact"]
                    .as_str()
                    .unwrap()
                    .contains("dangling_screen_reference")
        })
        .unwrap();
    assert_eq!(issue["scene"], scene);
    assert_eq!(issue["owner"], id);
    assert_eq!(issue["block"], "screen-reference");
    assert_eq!(issue["block_type"], "get_screens");
}

#[test]
fn field_and_type_text_cannot_forge_a_precise_block_location() {
    for (hat, failing) in [
        (
            "hat",
            json!({"id":"bad-field","type":"self_dialog","fields":{"type":"nonsense at \"hat\""},"inputs":{"text":{"id":"literal","type":"text","fields":{"TEXT":"hi"}}}}),
        ),
        (
            "innocent",
            json!({"id":"actual-failure","type":"future_command (\"innocent\")"}),
        ),
        (
            "hat",
            json!({"id":"stage-dialog-failure","type":"create_stage_dialog","fields":{"type":"invalid"}}),
        ),
        (
            "hat",
            json!({"id":"quote\"\\end","type":"future_command (\"hat\")"}),
        ),
    ] {
        let expected = failing["id"].clone();
        let report = health(project(
            json!([{"id":hat,"type":"on_running_group_activated","next":failing}]),
        ));
        let issue = items(&report)
            .iter()
            .find(|item| item["code"] == "script_compile_failed")
            .unwrap();
        assert_eq!(issue["block"], expected, "{report}");
        assert_eq!(issue["location_precision"], "block");
        assert!(
            items(&report)
                .iter()
                .any(|item| item["block"] == hat && item["category"] == "unverified")
        );
    }
}

#[test]
fn screen_reference_pointers_do_not_alias_unknown_property_names() {
    for (name, root) in [
        (
            "inputs.x",
            json!({"id":"hat","type":"on_running_group_activated","inputs":{"x":{"id":"innocent","type":"math_number","parent_id":"hat","fields":{"NUM":1}}}}),
        ),
        (
            "inputs.x.y",
            json!({"id":"hat","type":"on_running_group_activated","inputs":{"x.y":{"id":"innocent","type":"math_number","parent_id":"hat","fields":{"NUM":1}}}}),
        ),
        (
            "inputs.x[0]",
            json!({"id":"hat","type":"on_running_group_activated","inputs":{"x[0]":{"id":"innocent","type":"math_number","parent_id":"hat","fields":{"NUM":1}}}}),
        ),
        (
            "inputs.x/~",
            json!({"id":"hat","type":"on_running_group_activated","inputs":{"x/~":{"id":"innocent","type":"math_number","parent_id":"hat","fields":{"NUM":1}}}}),
        ),
    ] {
        let mut root = root;
        root[name] = json!({"id":"metadata-reference","type":"get_screens","fields":{"screen_id":"deleted-scene"}});
        let p = project(json!([root]));
        let validation = nekoc::validate::build_report(&p).unwrap();
        let issue = validation["issues"]
            .as_array()
            .unwrap()
            .iter()
            .find(|issue| issue["kind"] == "dangling_screen_reference")
            .unwrap();
        let pointer = issue["json_pointer"].as_str().unwrap();
        assert_eq!(p.pointer(pointer).unwrap()["id"], "metadata-reference");
        let report = health(p);
        let issue = items(&report)
            .iter()
            .find(|issue| {
                issue["code"] == "invalid_structure"
                    && issue["impact"]
                        .as_str()
                        .unwrap()
                        .contains("dangling_screen_reference")
            })
            .unwrap();
        assert!(issue["block"].is_null(), "{name}: {issue}");
        assert!(issue["block_type"].is_null());
        assert!(
            items(&report)
                .iter()
                .any(|issue| issue["block"] == "innocent" && issue["category"] == "unverified")
        );
    }
    // An actual array and an array-looking literal property have distinct pointers.
    let mut p = project(json!([]));
    p["metadata"] = json!([{"type":"get_screens","fields":{"screen_id":"deleted-scene"}}]);
    p["metadata[0]"] = json!({"type":"get_screens","fields":{"screen_id":"deleted-scene"}});
    let validation = nekoc::validate::build_report(&p).unwrap();
    let pointers: std::collections::BTreeSet<_> = validation["issues"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|issue| issue["kind"] == "dangling_screen_reference")
        .map(|issue| issue["json_pointer"].as_str().unwrap())
        .collect();
    assert_eq!(
        pointers,
        std::collections::BTreeSet::from(["/metadata/0", "/metadata[0]"])
    );
}

#[test]
fn arbitrary_message_substrings_and_ambiguous_ids_only_locate_scripts() {
    let p = project(
        json!([{"id":"hat","type":"on_running_group_activated","next":{"id":"bad","type":"future_command"}}]),
    );
    let report = nekoc::health::build_report(
        &p,
        &json!({"script_diagnostics":[{
            "owner":"nekoc-default-actor","block":"hat","message":"unknown error at \"bad\"",
            "root_error":"unknown error at \"bad\""
        }]}),
    );
    let issue = items(&report)
        .iter()
        .find(|item| item["code"] == "script_compile_failed")
        .unwrap();
    assert_eq!(issue["block"], "hat");
    assert_eq!(issue["location_precision"], "script");
    assert!(
        items(&report)
            .iter()
            .any(|item| item["block"] == "bad" && item["category"] == "unverified")
    );

    // Even a known template does not certify duplicated IDs or two matching
    // candidates in different owners (e.g. a shared procedure definition).
    for duplicate_owner in [false, true] {
        let mut p = p.clone();
        if duplicate_owner {
            p["procedures"]["proceduresDict"]["p"] =
                json!({"nekoBlockJsonList":[{"id":"bad","type":"future_command"}]});
        } else {
            p["actors"]["actorsDict"]["nekoc-default-actor"]["nekoBlockJsonList"]
                .as_array_mut()
                .unwrap()
                .push(json!({"id":"bad","type":"text"}));
        }
        let report = nekoc::health::build_report(
            &p,
            &json!({"script_diagnostics":[{
                "owner":"nekoc-default-actor","block":"hat",
                "root_error":"unsupported fast-VM block future_command (\"bad\")"
            }]}),
        );
        let issue = items(&report)
            .iter()
            .find(|item| item["code"] == "script_compile_failed")
            .unwrap();
        assert_eq!(issue["block"], "hat");
        assert_eq!(issue["location_precision"], "script");
    }
}
