use nekoc::{engine::Engine, engine::Program, kitten4};
use serde_json::{Value, json};
use std::time::Duration;

const ACTOR: &str = "20000000-0000-4000-8000-000000000001";

fn engine(case: &str, interpreter: bool) -> Engine {
    let text =
        std::fs::read_to_string(format!("tests/fixtures/kitten4/r2-gaps-{case}.bcm")).unwrap();
    let source = nekoc::json::from_str(&text).unwrap();
    let mut engine = Engine::new(Program::compile(&kitten4::to_neko(&source).unwrap()).unwrap());
    engine.use_virtual_clock();
    if interpreter {
        engine.disable_jit();
    }
    engine.start();
    engine
}

fn tick(engine: &mut Engine) {
    engine
        .advance(1.0 / 60.0, 100_000, Duration::from_secs(5))
        .unwrap();
}

fn same(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => {
            (a.as_f64().unwrap() - b.as_f64().unwrap()).abs() < 1e-9
        }
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|other| same(value, other)))
        }
        _ => actual == expected,
    }
}

#[test]
fn anonymous_identity_pointer_and_scene_order_match_official_frames() {
    let evidence: Value =
        serde_json::from_str(include_str!("../docs/kitten4-r2-gaps-evidence.json")).unwrap();
    for (case, observed) in evidence["cases"].as_object().unwrap() {
        for interpreter in [false, true] {
            let mut engine = engine(case, interpreter);
            for (i, expected) in observed["frames"].as_array().unwrap().iter().enumerate() {
                tick(&mut engine);
                let actual = engine.oracle_snapshot((i + 1) as u32);
                for section in ["current_scene_id", "actors", "variables"] {
                    assert!(
                        same(&actual[section], &expected[section]),
                        "{case} interpreter={interpreter} frame={} {section}: {} != {}",
                        i + 1,
                        actual[section],
                        expected[section]
                    );
                }
            }
        }
    }
}

#[test]
fn pointer_can_arrive_after_ignored_motion_without_poisoning_sprite_or_stopping_script() {
    for interpreter in [false, true] {
        for case in ["face-pointer", "move-pointer"] {
            let mut engine = engine(case, interpreter);
            for _ in 0..3 {
                tick(&mut engine);
            }
            assert_eq!(engine.variable_text("log"), "3");
            let initial = engine.oracle_snapshot(3);
            assert!(same(&initial["actors"][ACTOR]["rotation"], &json!(30)));
            assert!(same(&initial["actors"][ACTOR]["x"], &json!(12)));
            assert!(same(&initial["actors"][ACTOR]["y"], &json!(-7)));
            engine.set_mouse(22.0, 3.0);
            tick(&mut engine);
            let actual = engine.oracle_snapshot(4);
            let actor = &actual["actors"][ACTOR];
            assert_eq!(engine.variable_text("log"), "4");
            if case == "face-pointer" {
                assert!(same(&actor["rotation"], &json!(45)));
                assert!(same(&actor["x"], &json!(12)));
                assert!(same(&actor["y"], &json!(-7)));
            } else {
                assert!(same(&actor["rotation"], &json!(30)));
                assert!(same(&actor["x"], &json!(22)));
                assert!(same(&actor["y"], &json!(3)));
            }
        }
    }
}
