//! A published PICKCAT work broadcasts every frame from actors that also clone
//! themselves; KN keeps up to 300 clones per actor, so one frame of broadcasts fans
//! out to thousands of listener tasks. The official runtime runs it; NekoC used to
//! stop with "broadcast task limit exceeded" once 4096 tasks were live.
use nekoc::{
    engine::{Engine, Program},
    studio::document::Document,
};
use serde_json::{Value, json};
use std::time::Duration;

fn num(n: f64) -> Value {
    json!({"type":"math_number","fields":{"NUM":n}})
}
fn text(t: &str) -> Value {
    json!({"type":"text","fields":{"TEXT":t}})
}

#[test]
fn broadcasts_to_hundreds_of_clones_in_one_frame_all_run() {
    const CLONES: usize = 299;
    const BROADCASTS: usize = 15;
    let mut project = Document::blank().value().clone();
    project["variables"]["variablesDict"]["count"] =
        json!({"id":"count","name":"count","type":"any","value":0,"isGlobal":true});
    let clone = json!({"type":"repeat_n_times","inputs":{"times":num(CLONES as f64)},
        "statements":{"DO":{"type":"mirror","fields":{"sprite":"--self"}}}});
    let broadcast = json!({"type":"warp","statements":{"DO":{"type":"repeat_n_times",
        "inputs":{"times":num(BROADCASTS as f64)},
        "statements":{"DO":{"type":"self_broadcast","inputs":{"message":text("m")}}}}}});
    let mut start = json!({"id":"start","type":"on_running_group_activated","next":clone});
    start["next"]["next"] = broadcast;
    project["actors"]["actorsDict"]["nekoc-default-actor"]["nekoBlockJsonList"] = json!([
        start,
        {"id":"listen","type":"self_listen",
            "inputs":{"message":{"type":"broadcast_input","fields":{"message":"m"}}},
            "statements":{"DO":{"type":"change_variables",
                "fields":{"variable":"count","method":"increase"},"inputs":{"value":num(1.0)}}}},
    ]);
    let mut vm = Engine::new(Program::compile(&project).unwrap());
    vm.start();
    for _ in 0..600 {
        vm.advance(1.0 / 60.0, 10_000_000, Duration::from_secs(5))
            .unwrap();
    }
    // Every broadcast reaches the original and each clone.
    assert_eq!(
        vm.variable_value("count").number(),
        ((CLONES + 1) * BROADCASTS) as f64
    );
}
