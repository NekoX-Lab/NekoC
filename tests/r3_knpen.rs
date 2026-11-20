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
    let mut observed = vec![];
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
                "double-origin-move"
                | "double-x-axis-move"
                | "double-y-axis-move"
                | "double-up-redown-move" => 4,
                "triple-origin-move" | "double-two-moves" => 6,
                _ => 2,
            };
            assert_eq!(frame.lines.len() / 9, count, "{} jit={jit}", c["name"]);
            if jit {
                frames.push(json!({"name":c["name"],"lines":frame.lines}));
            }
            observed.push((c, jit, frame));
        }
    }
    // Export before comparing evidence so an explicit first capture can be
    // inspected even when newly authored cases have not been frozen yet.
    println!(
        "R3_KNPEN_FRAMES={}",
        serde_json::to_string(&frames).unwrap()
    );
    for (c, jit, frame) in observed {
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
    }
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

#[test]
fn colour_sensor_includes_each_extra_endpoint_callback() {
    for (downs, color) in [(2, "#3f3f3f"), (3, "#1f1f1f")] {
        let mut actions = vec![
            json!(["color", "#000000"]),
            json!(["size", 20]),
            json!(["alpha", 50]),
            json!(["move", 0, 0]),
        ];
        actions.extend((0..downs).map(|_| json!(["down"])));
        actions.extend([json!(["move", 100, 60]), json!(["up"])]);
        let mut p = project(&actions);
        let mut tail = &mut p["actors"]["actorsDict"][ACTOR]["nekoBlockJsonList"][0];
        while tail.get("next").is_some() {
            tail = &mut tail["next"];
        }
        let sense = |id, color| {
            json!({"type":"variables_set","fields":{"variable":id},
            "inputs":{"value":{"type":"bump_into_color","fields":{"sprite":"--self","color":color}}}})
        };
        let mut expected = sense("expected", color);
        expected["next"] = sense("missing_layer", "#7f7f7f");
        tail["next"] = expected;
        for id in ["expected", "missing_layer"] {
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
            assert_eq!(
                engine.variable_value("expected").number(),
                1.0,
                "downs={downs} jit={jit}"
            );
            assert_eq!(
                engine.variable_value("missing_layer").number(),
                0.0,
                "downs={downs} jit={jit}"
            );
        }
    }
}

#[test]
fn clone_and_full_restart_do_not_inherit_repeated_pen_listeners() {
    let mut p = project(
        json!([["move", 0, 0], ["down"], ["down"]])
            .as_array()
            .unwrap(),
    );
    let mut tail = &mut p["actors"]["actorsDict"][ACTOR]["nekoBlockJsonList"][0];
    while tail.get("next").is_some() {
        tail = &mut tail["next"];
    }
    tail["next"] = json!({"type":"mirror","fields":{"sprite":"--self"}});
    let mut cloned = project(
        json!([["move", 50, 60], ["down"], ["move", 100, 60], ["up"]])
            .as_array()
            .unwrap(),
    )["actors"]["actorsDict"][ACTOR]["nekoBlockJsonList"][0]
        .clone();
    cloned["type"] = json!("start_as_a_mirror");
    p["actors"]["actorsDict"][ACTOR]["nekoBlockJsonList"]
        .as_array_mut()
        .unwrap()
        .push(cloned);
    for jit in [false, true] {
        let mut engine = Engine::new(Program::compile(&p).unwrap());
        if !jit {
            engine.disable_jit();
        }
        engine.use_virtual_clock();
        // First run leaves the source down with two listeners. Full restart
        // must create a fresh source brush, and every clone starts pen-up.
        for run in 0..2 {
            engine.start();
            let mut lines = vec![];
            for _ in 0..3 {
                lines.extend(
                    engine
                        .advance(1.0 / 60.0, 100_000, Duration::from_secs(1))
                        .unwrap()
                        .lines,
                );
            }
            let points: Vec<_> = lines
                .as_chunks::<9>()
                .0
                .iter()
                .map(|l| l[..4].to_vec())
                .collect();
            assert_eq!(
                points,
                vec![
                    vec![0.0, 0.0, 0.0, 0.0],
                    vec![0.0, 0.0, 0.0, 0.0],
                    vec![50.0, 60.0, 50.0, 60.0],
                    vec![50.0, 60.0, 100.0, 60.0]
                ],
                "run={run} jit={jit}"
            );
        }
    }
}
