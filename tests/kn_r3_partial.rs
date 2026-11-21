//! Original KN list-copy/reference fixtures. Official evidence: docs/kn-r3-partial.md.
use nekoc::{
    engine::{Engine, Program},
    studio::document::Document,
};
use serde_json::{Value, json};
use std::time::Duration;

fn num(n: f64) -> Value {
    json!({"type":"math_number","fields":{"NUM":n}})
}
fn list(name: &str) -> Value {
    json!({"type":"pure_list_get","fields":{"list":name}})
}
fn variable(name: &str) -> Value {
    json!({"type":"variables_get","fields":{"variable":name}})
}
fn item(name: &str, index: f64) -> Value {
    json!({"type":"list_item","fields":{"item":"any"},"inputs":{"list":list(name),"list_index":num(index)}})
}
fn append(target: Value, value: Value) -> Value {
    json!({"type":"list_append","inputs":{"list":target,"list_item_value":value}})
}
fn copy(source: &str, target: &str) -> Value {
    json!({"type":"list_copy","inputs":{"list":list(source),"target_list":list(target)}})
}
fn find(target: &str, value: Value) -> Value {
    json!({"type":"list_index_of","inputs":{"list":list(target),"list_item_value":value}})
}
fn log(value: Value) -> Value {
    json!({"type":"console_log","inputs":{"console_log":value}})
}
fn set(name: &str, value: Value) -> Value {
    json!({"type":"variables_set","fields":{"variable":name},"inputs":{"value":value}})
}
fn length(value: Value) -> Value {
    json!({"type":"list_length","inputs":{"list":value}})
}
fn project(blocks: Vec<Value>) -> Value {
    let mut p = Document::blank().value().clone();
    let chain = blocks.into_iter().rev().reduce(|tail, mut head| {
        head["next"] = tail;
        head
    });
    p["actors"]["actorsDict"]["nekoc-default-actor"]["nekoBlockJsonList"] =
        json!([{"type":"on_running_group_activated","next":chain}]);
    for (name, value) in [
        ("source", json!([])),
        ("copy", json!([99])),
        ("shared", json!([7])),
    ] {
        p["variables"]["variablesDict"][name] = json!({"type":"list","value":value});
    }
    for name in ["object", "nested", "alias"] {
        p["variables"]["variablesDict"][name] = json!({"type":"any","value":0});
    }
    p
}
fn run(p: &Value, expected: &[&str]) {
    for jit in [false, true] {
        let mut vm = Engine::new(Program::compile(p).unwrap());
        if !jit {
            vm.disable_jit();
        }
        // Restart must reconstruct the same independent graph.
        for _ in 0..2 {
            vm.start();
            let mut logs = vec![];
            for _ in 0..200 {
                logs.extend(
                    vm.advance(1.0 / 60.0, 100_000, Duration::from_secs(2))
                        .unwrap()
                        .logs,
                );
                if vm.active_tasks() == 0 {
                    break;
                }
            }
            assert_eq!(vm.active_tasks(), 0);
            assert_eq!(logs, expected, "jit={jit}");
        }
    }
}

#[test]
fn copy_preserves_repeated_list_identity_but_detaches_from_source() {
    run(
        &project(vec![
            append(list("source"), list("shared")),
            append(list("source"), list("shared")),
            set("alias", list("copy")),
            copy("source", "copy"),
            log(find("copy", item("copy", 2.0))),
            log(find("source", item("copy", 1.0))),
            append(item("copy", 1.0), num(9.0)),
            log(length(item("copy", 2.0))),
            log(length(list("shared"))),
            log(length(variable("alias"))),
        ]),
        &["1", "0", "2", "1", "2"],
    );
}

#[test]
fn copy_preserves_aliases_across_lists_and_object_properties() {
    let property = |object| json!({"type":"_object_get","inputs":{"obj":object,"key":{"type":"text","fields":{"TEXT":"shared"}}}});
    run(
        &project(vec![
            set("object", json!({"type":"_object_literal","inputs":{}})),
            json!({"type":"_object_set","inputs":{"obj":variable("object"),"key":{"type":"text","fields":{"TEXT":"shared"}},"value":list("shared")}}),
            append(list("source"), list("shared")),
            append(list("source"), variable("object")),
            append(list("source"), variable("object")),
            copy("source", "copy"),
            log(find("copy", property(item("copy", 2.0)))),
            log(find("copy", item("copy", 3.0))),
            log(find("source", item("copy", 2.0))),
            append(item("copy", 1.0), num(9.0)),
            log(length(property(item("copy", 3.0)))),
            log(length(list("shared"))),
        ]),
        &["1", "2", "0", "2", "1"],
    );
}

#[test]
fn self_copy_snapshots_before_replacing_contents_and_keeps_target_identity() {
    run(
        &project(vec![
            append(list("source"), list("shared")),
            append(list("source"), list("shared")),
            set("alias", list("source")),
            copy("source", "source"),
            log(find("source", item("source", 2.0))),
            log(find("source", list("shared"))),
            append(item("source", 1.0), num(9.0)),
            log(length(item("source", 2.0))),
            log(length(list("shared"))),
            log(length(variable("alias"))),
        ]),
        &["1", "0", "2", "1", "2"],
    );
}

#[test]
fn repeated_copies_use_fresh_graphs_and_empty_copy_clears_existing_alias() {
    run(
        &project(vec![
            append(list("source"), list("shared")),
            append(list("source"), list("shared")),
            copy("source", "copy"),
            set("nested", item("copy", 1.0)),
            copy("source", "copy"),
            log(find("copy", variable("nested"))),
            log(find("copy", item("copy", 2.0))),
            set("alias", list("copy")),
            json!({"type":"delete_list_item","fields":{"item":"all"},"inputs":{"list":list("source")}}),
            copy("source", "copy"),
            log(length(variable("alias"))),
            log(length(variable("nested"))),
        ]),
        &["0", "1", "0", "1"],
    );
}

#[test]
fn copy_preserves_object_back_reference_to_snapshot_root() {
    let back = |object| json!({"type":"_object_get","inputs":{"obj":object,"key":{"type":"text","fields":{"TEXT":"back"}}}});
    let set_back = |object, value| json!({"type":"_object_set","inputs":{"obj":object,"key":{"type":"text","fields":{"TEXT":"back"}},"value":value}});
    run(
        &project(vec![
            set("object", json!({"type":"_object_literal","inputs":{}})),
            append(list("source"), variable("object")),
            set_back(variable("object"), list("source")),
            copy("source", "copy"),
            set("nested", length(back(item("copy", 1.0)))),
            set(
                "alias",
                json!({"type":"list_index_of","inputs":{"list":back(item("copy", 1.0)),"list_item_value":item("copy", 1.0)}}),
            ),
            // Break both cycles before logging or restarting the VM.
            set_back(variable("object"), num(0.0)),
            set_back(item("copy", 1.0), num(0.0)),
            json!({"type":"delete_list_item","fields":{"item":"all"},"inputs":{"list":list("source")}}),
            json!({"type":"delete_list_item","fields":{"item":"all"},"inputs":{"list":list("copy")}}),
            log(variable("nested")),
            log(variable("alias")),
            log(length(list("source"))),
            log(length(list("copy"))),
        ]),
        &["1", "1", "0", "0"],
    );
}

#[test]
fn list_search_uses_strict_equality_and_first_reference_match() {
    let nan = json!({"type":"math_arithmetic","fields":{"type":"divide"},"inputs":{"A":num(0.0),"B":num(0.0)}});
    let text = json!({"type":"text","fields":{"TEXT":"1"}});
    run(
        &project(vec![
            append(list("source"), text.clone()),
            append(list("source"), num(1.0)),
            append(list("source"), num(1.0)),
            append(list("source"), nan.clone()),
            append(list("source"), list("shared")),
            log(find("source", num(1.0))),
            log(find("source", text)),
            log(find("source", nan.clone())),
            log(
                json!({"type":"list_is_exist","inputs":{"list":list("source"),"list_item_value":nan}}),
            ),
            log(find("source", list("shared"))),
            log(find(
                "source",
                json!({"type":"temporary_list","inputs":{"ITEM0":num(7.0)}}),
            )),
        ]),
        &["2", "1", "0", "false", "5", "0"],
    );
}
