//! Original KN pen probes, paired with official observations in docs/r3-knpen.md.
use nekoc::{
    engine::{Costume, Engine, Program},
    studio::document::Document,
};
use serde_json::{Value, json};
use std::time::Duration;

const ACTOR: &str = "nekoc-default-actor";

fn number(n: &Value) -> Value {
    json!({"type":"math_number","fields":{"NUM":n}})
}

fn project(actions: &[Value]) -> Value {
    let mut p = Document::blank().value().clone();
    let mut blocks = vec![json!({"type":"on_running_group_activated"})];
    for a in actions {
        blocks.push(match a[0].as_str().unwrap() {
            "move" => json!({"type":"self_move_to","inputs":{"x":number(&a[1]),"y":number(&a[2])}}),
            "size" => json!({"type":"self_set_pen_size","inputs":{"size":number(&a[1])}}),
            "alpha" => json!({"type":"self_set_pen_color_property","fields":{"scope":"alpha"},"inputs":{"val":number(&a[1])}}),
            "color" => json!({"type":"self_set_pen_color","fields":{"color":a[1]}}),
            "down" => json!({"type":"self_pen_down"}),
            "up" => json!({"type":"self_pen_up"}),
            "clear" => json!({"type":"clear_drawing"}),
            other => panic!("unknown action {other}"),
        });
    }
    let root = blocks
        .into_iter()
        .rev()
        .reduce(|next, mut b| {
            b["next"] = next;
            b
        })
        .unwrap();
    p["actors"]["actorsDict"][ACTOR]["nekoBlockJsonList"] = json!([root]);
    p
}

#[test]
fn kn_pen_deltas_include_axis_redowns_and_keep_clear_origin() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/r3-knpen-cases.json")).unwrap();
    let evidence: Value =
        serde_json::from_str(include_str!("../docs/r3-knpen-evidence.json")).unwrap();
    let mut frames = vec![];
    for c in &cases {
        let p = project(c["actions"].as_array().unwrap());
        for jit in [false, true] {
            let mut engine = Engine::new(Program::compile(&p).unwrap());
            if !jit {
                engine.disable_jit();
            }
            engine.use_virtual_clock();
            engine.start();
            let frame = engine
                .advance(1.0 / 60.0, 100_000, Duration::from_secs(1))
                .unwrap();
            let count = match c["name"].as_str().unwrap() {
                "alpha-corner" | "colours-crossing" => 3,
                "repeated-down-nonzero" | "clear-while-down" => 1,
                _ => 2,
            };
            assert_eq!(frame.lines.len() / 9, count, "{} jit={jit}", c["name"]);
            let official = evidence["cases"]
                .as_array()
                .unwrap()
                .iter()
                .find(|e| e["name"] == c["name"])
                .unwrap()["lines"]
                .as_array()
                .unwrap();
            assert_eq!(frame.lines.len(), official.len());
            for (actual, expected) in frame.lines.iter().zip(official) {
                assert!(
                    (f64::from(*actual) - expected.as_f64().unwrap()).abs() < 1e-6,
                    "{} jit={jit}: {actual} vs {expected}",
                    c["name"]
                );
            }
            if c["name"] == "clear-while-down" {
                assert!(frame.clear);
                assert_eq!(&frame.lines[..5], &[-20.0, 30.0, -20.0, 100.0, 20.0]);
            }
            if jit {
                frames.push(json!({"name":c["name"],"lines":frame.lines}));
            }
        }
    }
    // --nocapture exports real VM deltas for the browser comparison.
    println!(
        "R3_KNPEN_FRAMES={}",
        serde_json::to_string(&frames).unwrap()
    );
}

#[test]
fn colour_sensor_sees_three_alpha_layers_at_the_origin_and_none_after_clear() {
    let actions = json!([
        ["color", "#000000"],
        ["size", 20],
        ["alpha", 50],
        ["move", -120, 30],
        ["down"],
        ["move", -20, 30],
        ["up"],
        ["move", -120, 30]
    ]);
    let mut p = project(actions.as_array().unwrap());
    let mut tail = &mut p["actors"]["actorsDict"][ACTOR]["nekoBlockJsonList"][0];
    while tail.get("next").is_some() {
        tail = &mut tail["next"];
    }
    let sense = |id| {
        json!({"type":"variables_set","fields":{"variable":id},
        "inputs":{"value":{"type":"bump_into_color","fields":{"sprite":"--self","color":"#1f1f1f"}}}})
    };
    let mut before = sense("before");
    before["next"] = json!({"type":"clear_drawing","next":sense("after")});
    tail["next"] = before;
    for id in ["before", "after"] {
        p["variables"]["variablesDict"][id] =
            json!({"id":id,"name":id,"type":"any","value":-1,"isGlobal":true});
    }
    for jit in [false, true] {
        let mut engine = Engine::new(Program::compile(&p).unwrap());
        if !jit {
            engine.disable_jit();
        }
        engine.set_costume(
            "nekoc-costume",
            Costume {
                width: 1.0,
                height: 1.0,
                center_point: [0.0; 2],
                mask: Some((1, 1, vec![1])),
                rgb: Some(vec![0, 0, 0]),
            },
        );
        engine.use_virtual_clock();
        engine.start();
        engine
            .advance(1.0 / 60.0, 100_000, Duration::from_secs(1))
            .unwrap();
        assert_eq!(engine.variable_value("before").number(), 1.0, "jit={jit}");
        assert_eq!(engine.variable_value("after").number(), 0.0, "jit={jit}");
    }
}
