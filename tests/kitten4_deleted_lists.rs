use nekoc::{
    engine::{Engine, Program},
    kitten4,
};
use serde_json::{Value, json};
use std::time::Duration;

fn block(id: &str, kind: &str, parent: Option<&str>, fields: Value, output: bool) -> Value {
    json!({"type": kind, "comment": null, "is_shadow": false, "collapsed": false,
        "disabled": false, "deletable": true, "movable": true, "editable": true,
        "visible": "visible", "shadows": {}, "fields": fields, "field_constraints": {},
        "field_extra_attr": {}, "mutation": "", "is_output": output, "id": id,
        "parent_id": parent, "location": [0, 0]})
}

/// A script that still names a list deleted from the variable panel, as published
/// works do. Official 4.11.20: `show_hide_list` only toggles an existing monitor and
/// `lists_get` is `get_var_or_list(id, [])`, which stores a fresh global empty list.
fn project() -> Value {
    let mut source: Value = serde_json::from_str(
        &std::fs::read_to_string("tests/fixtures/kitten4/partial-properties-clone-index-text.bcm")
            .unwrap(),
    )
    .unwrap();
    let blocks = json!({
        "start": block("start", "start_on_click", None, json!({}), false),
        "hide": block("hide", "show_hide_list", Some("start"), json!({"FUNC": "hide", "VAR": "deleted"}), false),
        "show": block("show", "show_hide_list", Some("hide"), json!({"FUNC": "show", "VAR": "deleted"}), false),
        "push": block("push", "lists_append", Some("show"), json!({}), false),
        "push-list": block("push-list", "lists_get", Some("push"), json!({"VAR": "deleted"}), true),
        "push-value": block("push-value", "text", Some("push"), json!({"TEXT": "a"}), true),
        "record": block("record", "lists_append", Some("push"), json!({}), false),
        "record-list": block("record-list", "lists_get", Some("record"), json!({"VAR": "result"}), true),
        "record-value": block("record-value", "lists_length", Some("record"), json!({}), true),
        "record-length": block("record-length", "lists_get", Some("record-value"), json!({"VAR": "deleted"}), true),
    });
    let input = |name: &str| json!({"type": "input", "input_type": "value", "input_name": name});
    let connections = json!({
        "start": {"hide": {"type": "next"}},
        "hide": {"show": {"type": "next"}},
        "show": {"push": {"type": "next"}},
        "push": {"push-list": input("VAR"), "push-value": input("VALUE"), "record": {"type": "next"}},
        "push-list": {}, "push-value": {},
        "record": {"record-list": input("VAR"), "record-value": input("VALUE")},
        "record-list": {}, "record-value": {"record-length": input("VAR")}, "record-length": {},
    });
    for actor in source["theatre"]["actors"]
        .as_object_mut()
        .unwrap()
        .values_mut()
    {
        actor["block_data_json"] =
            json!({"blocks": blocks, "connections": connections, "comments": {}});
    }
    source
}

#[test]
fn deleted_list_reads_as_fresh_empty_list_and_its_monitor_toggle_is_a_noop() {
    let source = project();
    for interpreted in [false, true] {
        let program = Program::compile(&kitten4::to_neko(&source).unwrap()).unwrap();
        let mut vm = Engine::new(program);
        if interpreted {
            vm.disable_jit();
        }
        vm.use_virtual_clock();
        vm.start();
        for _ in 0..3 {
            vm.advance(1.0 / 60.0, 2_000_000, Duration::from_secs(5))
                .unwrap();
        }
        let snapshot = vm.oracle_snapshot(3);
        let result = &snapshot["variables"]["result"];
        assert_eq!(
            result.as_array().map(|items| items.len()),
            Some(1),
            "{interpreted}: {snapshot}"
        );
        assert_eq!(result[0].as_f64(), Some(1.0), "{interpreted}: {result}");
        // The implicit list is internal: it never gains a visible monitor.
        assert!(
            !snapshot
                .to_string()
                .contains("\"deleted\":{\"visible\":true"),
            "{snapshot}"
        );
    }
}
