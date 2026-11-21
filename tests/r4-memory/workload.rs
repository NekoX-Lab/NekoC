//! Repository-owned stress work, never derived from a third-party project.
use serde_json::{Value, json};

pub const ACTOR: &str = "nekoc-default-actor";
pub const PRIVATE: &str = "40000000-0000-4000-8000-000000000004";
pub const BATCH: usize = 12;
pub const POINTS: usize = 128;

pub fn num(n: usize) -> Value {
    json!({"type":"math_number","fields":{"NUM":n}})
}
pub fn chain(blocks: Vec<Value>) -> Value {
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
pub fn work() -> Value {
    let mut p: Value =
        serde_json::from_str(include_str!("../../samples/kitten-n-0.27.4.bcmkn")).unwrap();
    p["projectName"] = json!("NekoC r4-memory original stress");
    p["stageSize"] = json!({"width":160,"height":100});
    p["variables"]["variablesDict"] = json!({
        PRIVATE:{"id":PRIVATE,"name":"clone items","type":"list","value":[],
            "isGlobal":false,"currentEntityId":ACTOR,"visible":false},
        "items":{"id":"items","name":"items","type":"list","value":[],"isGlobal":true,"visible":false}
    });
    let turn = json!({"type":"self_rotate","inputs":{"degrees":num(17)}});
    let append = |id| {
        json!({"type":"list_append","inputs":{"list":list(id),"list_item_value":{
            "type":"temporary_list","mutation":"<mutation items=\"2\"/>","inputs":{"ITEM0":num(1),"ITEM1":num(2)}
        }}})
    };
    let contour = chain(vec![
        turn,
        json!({"type":"self_go_forward","inputs":{"steps":num(1)}}),
        append(PRIVATE),
        append("items"),
        json!({"type":"delete_list_item","fields":{"item":"last"},"inputs":{"list":list("items")}}),
    ]);
    p["actors"]["actorsDict"][ACTOR]["nekoBlockJsonList"] = json!([
        {"type":"on_running_group_activated","next":{"type":"repeat_forever","statements":{"DO":chain(vec![
            json!({"type":"warp","statements":{"DO":{"type":"repeat_n_times","inputs":{"times":num(BATCH)},
                "statements":{"DO":{"type":"mirror","fields":{"sprite":"--self"}}}}}}),
        ])}}},
        {"type":"start_as_a_mirror","statements":{"DO":chain(vec![
            json!({"type":"self_pen_down"}),
            json!({"type":"warp","statements":{"DO":{"type":"repeat_n_times","inputs":{"times":num(POINTS)},"statements":{"DO":contour}}}}),
            json!({"type":"self_text_effect_text","inputs":{"text":{"type":"text","fields":{"TEXT":"clone payload"}}}}),
            json!({"type":"self_dialog_wait","fields":{"type":"talk"},"inputs":{"text":{"type":"text","fields":{"TEXT":"delete this bubble"}}}}),
            json!({"type":"wait","inputs":{"time":num(0)}}),
            json!({"type":"dispose_clone"}),
        ])}}
    ]);
    fn ids(value: &mut Value, serial: &mut usize) {
        match value {
            Value::Array(items) => items.iter_mut().for_each(|v| ids(v, serial)),
            Value::Object(map) => {
                if map.get("type").is_some_and(Value::is_string) {
                    *serial += 1;
                    map.insert("id".into(), json!(format!("r4-memory-{serial}")));
                }
                map.values_mut().for_each(|v| ids(v, serial));
            }
            _ => {}
        }
    }
    ids(
        &mut p["actors"]["actorsDict"][ACTOR]["nekoBlockJsonList"],
        &mut 0,
    );
    p
}
