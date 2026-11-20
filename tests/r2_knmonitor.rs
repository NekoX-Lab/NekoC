//! KN list panel payloads use original in-memory projects, not corpus works.
use nekoc::{
    engine::{Engine, Frame, Program, encode_frame},
    kitten4,
    studio::document::Document,
};
use serde_json::{Value, json};
use std::time::Duration;

const ACTOR: &str = "nekoc-default-actor";

fn declaration(id: &str, kind: &str, value: Value, visible: bool) -> Value {
    json!({"id":id,"name":id,"type":kind,"value":value,"visible":visible,"isGlobal":true})
}

fn project() -> Value {
    let mut project = Document::blank().value().clone();
    project["variables"]["variablesDict"] = json!({});
    project["actors"]["actorsDict"][ACTOR]["nekoBlockJsonList"] = json!([]);
    project
}

fn private_list(value: Value) -> Value {
    let mut variable = declaration("private", "list", value, true);
    variable["isGlobal"] = json!(false);
    variable["currentEntityId"] = json!(ACTOR);
    variable
}

fn engine(project: &Value, jit: bool) -> Engine {
    let mut vm = Engine::new(Program::compile(project).unwrap());
    if !jit {
        vm.disable_jit();
    }
    vm.use_virtual_clock();
    vm.start();
    vm
}

fn frame(vm: &mut Engine) -> Frame {
    vm.advance(1.0 / 60.0, 1_000_000, Duration::ZERO).unwrap()
}

fn wire(frame: &Frame) -> Value {
    let bytes = encode_frame(frame).unwrap();
    let length = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
    serde_json::from_slice(&bytes[4..4 + length]).unwrap()
}

fn assert_legacy_monitors(wire: &Value) {
    for monitor in wire["monitors"].as_array().unwrap() {
        let object = monitor.as_object().unwrap();
        assert_eq!(object.len(), 4);
        for field in ["id", "name", "list", "value"] {
            assert!(object.contains_key(field), "missing {field}");
        }
    }
}

#[test]
fn kn_rows_preserve_empty_items_newlines_types_and_full_length() {
    let mut project = project();
    let values = (0..105).map(|i| format!("row-{i}")).collect::<Vec<_>>();
    let mut global = vec![String::new(), "first\nsecond".into(), "\r\n".into()];
    global.extend(values);
    let mut private = global.clone();
    private[0] = "private row".into();
    let vars = &mut project["variables"]["variablesDict"];
    vars["global"] = declaration("global", "list", json!(global), true);
    vars["private"] = private_list(json!(private));
    vars["empty"] = declaration("empty", "list", json!([]), true);
    vars["blank"] = declaration("blank", "list", json!([""]), true);
    vars["local"] = declaration("local", "private_list", json!(["", "x\ny"]), true);
    vars["typed"] = declaration("typed", "list", json!([7, true, null, ["x", "y"]]), true);
    vars["hidden"] = declaration("hidden", "list", json!(["hidden"]), false);
    vars["scalar"] = declaration("scalar", "any", json!(42), true);
    for jit in [false, true] {
        let mut vm = engine(&project, jit);
        assert!(!vm.program.list_names.iter().any(|id| id == "private"));
        let frame = frame(&mut vm);
        assert_eq!(frame.monitor_lists.len(), 6);
        assert_eq!(frame.monitor_lists["global"], global);
        assert_eq!(frame.monitor_lists["private"], private);
        assert_eq!(frame.monitor_lists["global"].len(), 108);
        assert!(frame.monitor_lists["empty"].is_empty());
        assert_eq!(frame.monitor_lists["blank"], [""]);
        assert_eq!(frame.monitor_lists["local"], ["", "x\ny"]);
        assert_eq!(frame.monitor_lists["typed"], ["7", "true", "", "x,y"]);
        assert!(!frame.monitor_lists.contains_key("hidden"));
        assert!(!frame.monitor_lists.contains_key("scalar"));
        let wire = wire(&frame);
        assert_eq!(wire["monitor_lists"]["global"], json!(global));
        assert_eq!(wire["monitor_lists"]["private"], json!(private));
        assert_eq!(wire["monitor_lists"]["empty"], json!([]));
        assert_eq!(wire["monitor_lists"]["blank"], json!([""]));
        assert_legacy_monitors(&wire);
        for (id, items) in [("global", &global), ("private", &private)] {
            let monitor = frame.monitors.iter().find(|m| m.id == id).unwrap();
            assert_eq!(monitor.value, items[..100].join("\n") + "\n…");
        }
    }
}

fn chain(blocks: Vec<Value>) -> Value {
    blocks
        .into_iter()
        .rev()
        .reduce(|next, mut block| {
            block["next"] = next;
            block
        })
        .unwrap()
}

fn list(id: &str) -> Value {
    json!({"type":"pure_list_get","fields":{"list":id}})
}

fn append(id: &str, value: &str) -> Value {
    json!({"type":"list_append","inputs":{"list":list(id),
        "list_item_value":{"type":"text","fields":{"TEXT":value}}}})
}

fn visibility(id: &str, show: bool) -> Value {
    json!({"type":"show_hide_list","fields":{"list":id,"show_hide":if show {"show"} else {"hide"}}})
}

fn on_key(key: &str, blocks: Vec<Value>) -> Value {
    json!({"type":"on_keydown","fields":{"type":"down","key":key},"next":chain(blocks)})
}

fn press(vm: &mut Engine, key: &str) -> Frame {
    vm.key_event(key, true);
    let frame = frame(vm);
    vm.key_event(key, false);
    frame
}

#[test]
fn kn_rows_follow_live_global_and_private_mutations_visibility_and_restart() {
    let mut project = project();
    let vars = &mut project["variables"]["variablesDict"];
    vars["global"] = declaration("global", "list", json!(["global seed"]), true);
    vars["private"] = private_list(json!(["private seed"]));
    let one = json!({"type":"math_number","fields":{"NUM":1}});
    project["actors"]["actorsDict"][ACTOR]["nekoBlockJsonList"] = json!([
        on_key(
            "65",
            vec![append("global", "live\nrow"), append("private", "")]
        ),
        on_key(
            "66",
            vec![
                visibility("global", false),
                visibility("private", false),
                append("global", "hidden update"),
                append("private", "hidden\nupdate"),
            ]
        ),
        on_key(
            "67",
            vec![
                json!({"type":"replace_list_item","fields":{"item":"any"},"inputs":{
                "list":list("global"),"list_index":one,
                "list_item_value":{"type":"text","fields":{"TEXT":"replacement\nrow"}}}}),
                json!({"type":"delete_list_item","fields":{"item":"any"},"inputs":{
                "list":list("private"),"list_index":one}}),
                visibility("global", true),
                visibility("private", true),
            ]
        ),
    ]);
    for jit in [false, true] {
        let mut vm = engine(&project, jit);
        for _ in 0..2 {
            vm.start();
            let initial = frame(&mut vm);
            assert_eq!(initial.monitor_lists["global"], ["global seed"]);
            assert_eq!(initial.monitor_lists["private"], ["private seed"]);
            let updated = press(&mut vm, "65");
            assert_eq!(
                updated.monitor_lists["global"],
                ["global seed", "live\nrow"]
            );
            assert_eq!(updated.monitor_lists["private"], ["private seed", ""]);
            assert_eq!(initial.monitor_lists["private"], ["private seed"]);
            let hidden = press(&mut vm, "66");
            assert!(hidden.monitor_lists.is_empty());
            assert!(hidden.monitors.is_empty());
            assert!(wire(&hidden).get("monitor_lists").is_none());
            let shown = press(&mut vm, "67");
            assert_eq!(
                shown.monitor_lists["global"],
                ["replacement\nrow", "live\nrow", "hidden update"]
            );
            assert_eq!(shown.monitor_lists["private"], ["", "hidden\nupdate"]);
            assert_eq!(
                wire(&shown)["monitor_lists"]["private"],
                json!(["", "hidden\nupdate"])
            );
        }
    }
}

#[test]
fn kn_updates_after_item_100_are_transmitted_when_legacy_text_is_unchanged() {
    let mut project = project();
    let values = (0..105).map(Value::from).collect::<Vec<_>>();
    project["variables"]["variablesDict"]["global"] =
        declaration("global", "list", json!(values), true);
    project["variables"]["variablesDict"]["private"] = private_list(json!(values));
    let blocks = ["global", "private"]
        .into_iter()
        .map(|id| {
            json!({"type":"replace_list_item","fields":{"item":"any"},"inputs":{
                "list":list(id),"list_index":{"type":"math_number","fields":{"NUM":105}},
                "list_item_value":{"type":"text","fields":{"TEXT":"tail\nchanged"}}}})
        })
        .collect();
    project["actors"]["actorsDict"][ACTOR]["nekoBlockJsonList"] = json!([on_key("65", blocks)]);
    for jit in [false, true] {
        let mut vm = engine(&project, jit);
        let before = frame(&mut vm);
        let after = press(&mut vm, "65");
        let before_wire = wire(&before);
        let after_wire = wire(&after);
        assert_eq!(before_wire["monitors"], after_wire["monitors"]);
        assert_ne!(before_wire["monitor_lists"], after_wire["monitor_lists"]);
        for id in ["global", "private"] {
            assert_eq!(before.monitor_lists[id][104], "104");
            assert_eq!(after.monitor_lists[id][104], "tail\nchanged");
            assert_eq!(after.monitor_lists[id].len(), 105);
            assert_eq!(
                before.monitor_lists[id][..104],
                after.monitor_lists[id][..104]
            );
        }
    }
}

#[test]
fn kn_frames_without_visible_lists_omit_the_additive_field() {
    let mut project = project();
    let vars = &mut project["variables"]["variablesDict"];
    vars["hidden"] = declaration("hidden", "list", json!(["secret"]), false);
    vars["scalar"] = declaration("scalar", "any", json!(7), true);
    let mut vm = engine(&project, false);
    let frame = frame(&mut vm);
    assert!(frame.monitor_lists.is_empty());
    let wire = wire(&frame);
    assert!(wire.get("monitor_lists").is_none());
    assert_eq!(wire["monitors"].as_array().unwrap().len(), 1);
    assert_legacy_monitors(&wire);
}

#[test]
fn k4_keeps_four_field_monitors_and_capped_list_text_without_kn_rows() {
    let mut native: Value =
        serde_json::from_str(include_str!("fixtures/kitten4/monitors-idle.bcm")).unwrap();
    let values = (0..105).map(Value::from).collect::<Vec<_>>();
    for id in ["m-items", "private-items"] {
        native["variables"][id]["value"] = json!(values);
    }
    let project = kitten4::to_neko(&native).unwrap();
    let expected = (0..100)
        .map(|i| i.to_string())
        .chain(["…".into()])
        .collect::<Vec<_>>()
        .join("\n");
    for jit in [false, true] {
        let mut vm = engine(&project, jit);
        let frame = frame(&mut vm);
        assert!(frame.monitor_lists.is_empty());
        let wire = wire(&frame);
        assert!(wire.get("monitor_lists").is_none());
        assert_legacy_monitors(&wire);
        for id in ["m-items", "private-items"] {
            assert_eq!(
                frame.monitors.iter().find(|m| m.id == id).unwrap().value,
                expected
            );
        }
    }
}
