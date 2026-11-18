//! Published KN works save `visible: true` on variables whose monitor is on the
//! stage. The official player (kn.codemao.cn/player) shows those monitors from
//! the first frame, before any show/hide block runs; NekoC used to show none.
use nekoc::{
    engine::{Engine, Program},
    studio::document::Document,
};
use serde_json::{Value, json};
use std::time::Duration;

fn variable(id: &str, kind: &str, value: Value, visible: bool) -> Value {
    json!({"id":id,"name":id,"type":kind,"value":value,"visible":visible,"isGlobal":true})
}

#[test]
fn saved_visible_variables_and_lists_show_from_the_first_frame() {
    let mut project = Document::blank().value().clone();
    let vars = &mut project["variables"]["variablesDict"];
    vars["score"] = variable("score", "any", json!(0), true);
    vars["hidden"] = variable("hidden", "any", json!(5), false);
    vars["items"] = variable("items", "list", json!(["a", "b"]), true);
    vars["memory"] = variable("memory", "private_list", json!(["m"]), true);
    project["actors"]["actorsDict"]["nekoc-default-actor"]["nekoBlockJsonList"] = json!([
        {"type":"on_running_group_activated","next":{"type":"variables_set",
            "fields":{"variable":"score"},"inputs":{"value":{"type":"math_number","fields":{"NUM":7}}},
            "next":{"type":"show_hide_list","fields":{"show_hide":"hide","list":"items"}}}},
    ]);
    let mut vm = Engine::new(Program::compile(&project).unwrap());
    vm.start();
    let frame = vm
        .advance(1.0 / 60.0, 1_000_000, Duration::from_secs(2))
        .unwrap();
    let shown: Vec<_> = frame
        .monitors
        .iter()
        .map(|m| (m.id.as_str(), m.list, m.value.as_str()))
        .collect();
    // The script hid "items" through the saved monitor instead of a duplicate.
    assert_eq!(shown, [("memory", true, "m"), ("score", false, "7")]);
}
