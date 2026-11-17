use nekoc::{
    engine::{Engine, Program},
    kitten4,
};
use serde_json::Value;
use std::time::Duration;

fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len() && a.iter().all(|(k, a)| b.get(k).is_some_and(|b| same(a, b)))
        }
        _ => a == b,
    }
}

#[test]
fn official_decimal_values_and_hot_typed_control_state() {
    let evidence: Value =
        serde_json::from_str(include_str!("../docs/k4decimal-evidence.json")).unwrap();
    for (name, case) in evidence["cases"].as_object().unwrap() {
        let source = nekoc::json::from_str(
            &std::fs::read_to_string(format!("tests/fixtures/kitten4/k4decimal-{name}.bcm"))
                .unwrap(),
        )
        .unwrap();
        let project = kitten4::to_neko(&source).unwrap();
        let mut modes = vec![];
        for (interpreter, budget) in [
            (false, 2_000_000),
            (true, 2_000_000),
            (false, 37),
            (true, 37),
        ] {
            let mut vm = Engine::new(Program::compile(&project).unwrap());
            vm.use_virtual_clock();
            vm.set_random_seed(1);
            vm.enable_jit_profile();
            if interpreter {
                vm.disable_jit();
            }
            vm.start();
            let mut states = vec![];
            // Low-budget runs are compared to each other, not official timing.
            for frame in 0..if budget == 37 { 8 } else { 2 } {
                let result = vm.advance(1.0 / 60.0, budget, Duration::ZERO);
                if name == "error" {
                    if let Err(error) = result {
                        let error = error.to_string();
                        assert!(error.contains("lists_get_value_bad_index"), "{error}");
                        assert!(
                            matches!(vm.variable_value("count"), nekoc::engine::Cell::Number(n) if n == 1200.0)
                        );
                        assert!(
                            matches!(vm.variable_value("unwritten"), nekoc::engine::Cell::Number(n) if n == 0.0)
                        );
                        states.push(serde_json::json!([error, vm.jit_debug_snapshot()]));
                        break;
                    }
                    assert_eq!(budget, 37, "full budget must reach the error");
                }
                let result = result.unwrap();
                if budget != 37 {
                    assert!(!result.budget_yield, "{name}");
                    let snapshot = vm.oracle_snapshot(frame + 1);
                    assert!(
                        same(&snapshot["variables"], &case["variables"][frame as usize]),
                        "{name}: {} != {}",
                        snapshot["variables"],
                        case["variables"][frame as usize]
                    );
                }
                states.push(serde_json::json!([
                    result.instructions,
                    result.budget_yield,
                    vm.jit_debug_snapshot()
                ]));
            }
            if budget != 37 && !interpreter && ["hot", "error"].contains(&name.as_str()) {
                assert!(
                    vm.jit_profile()["native_ops"].as_u64().unwrap() > 0,
                    "{name}: {}",
                    vm.jit_profile()
                );
            }
            modes.push(states);
        }
        assert_eq!(modes[0], modes[1], "{name}: typed cells/PC/budget/errors");
        assert_eq!(
            modes[2], modes[3],
            "{name}: low-budget typed cells/PC/errors"
        );
    }
}

#[test]
fn kn_numeric_arithmetic_keeps_binary_number_results() {
    let source = nekoc::json::from_str(include_str!("fixtures/kitten4/k4decimal-hot.bcm")).unwrap();
    let mut project = kitten4::to_neko(&source).unwrap();
    project.as_object_mut().unwrap().remove("_nekocKitten4");
    for interpreter in [false, true] {
        let mut vm = Engine::new(Program::compile(&project).unwrap());
        vm.use_virtual_clock();
        if interpreter {
            vm.disable_jit();
        }
        vm.start();
        for _ in 0..1200 {
            vm.advance(1.0 / 60.0, 2_000_000, Duration::ZERO).unwrap();
        }
        let state = vm.oracle_snapshot(1200);
        for (name, expected) in [
            ("add", 0.1 + 0.2),
            ("sub", 0.3 - 0.1),
            ("mul", 0.1 * 0.2),
            ("div", 0.3 / 0.1),
        ] {
            assert_eq!(state["variables"][name].as_f64(), Some(expected), "{name}");
        }
    }
}

#[test]
fn deep_decimal_arithmetic_keeps_heap_evaluation_and_native_state_equal() {
    use serde_json::json;
    let source = nekoc::json::from_str(include_str!("fixtures/kitten4/k4decimal-hot.bcm")).unwrap();
    let imported = kitten4::to_neko(&source).unwrap();
    let mut project = nekoc::studio::document::Document::blank().value().clone();
    project["_nekocKitten4"] = imported["_nekocKitten4"].clone();
    project["variables"]["variablesDict"] = json!({
        "out":{"id":"out","value":0,"isGlobal":true},
        "input":{"id":"input","value":0.1,"isGlobal":true}
    });
    let mut value = json!({"type":"math_number","fields":{"NUM":0}});
    for _ in 0..80 {
        value = json!({"type":"math_arithmetic","fields":{"type":"add"},"inputs":{
            "A":value,"B":{"type":"variables_get","fields":{"variable":"input"}}
        }});
    }
    // Also descend through the new typed non-ADD variant in the heap walker.
    value = json!({"type":"math_arithmetic","fields":{"type":"multiply"},"inputs":{
        "A":value,"B":{"type":"math_number","fields":{"NUM":0.1}}
    }});
    project["actors"]["actorsDict"]["nekoc-default-actor"]["nekoBlockJsonList"] = json!([{
        "type":"on_running_group_activated","next":{"type":"warp","statements":{"DO":{
            "type":"repeat_n_times","inputs":{"times":{"type":"math_number","fields":{"NUM":1200}}},
            "statements":{"DO":{"type":"variables_set","fields":{"variable":"out"},"inputs":{"value":value}}}
        }}}
    }]);
    let mut states = vec![];
    for interpreter in [false, true] {
        let mut vm = Engine::new(Program::compile(&project).unwrap());
        vm.use_virtual_clock();
        vm.set_random_seed(1);
        vm.enable_jit_profile();
        if interpreter {
            vm.disable_jit();
        }
        vm.start();
        vm.advance(1.0 / 60.0, 2_000_000, Duration::ZERO).unwrap();
        assert!(matches!(vm.variable_value("out"), nekoc::engine::Cell::Number(n) if n == 0.8));
        if !interpreter {
            assert!(vm.jit_profile()["native_ops"].as_u64().unwrap() > 0);
        }
        states.push(vm.jit_debug_snapshot());
    }
    assert_eq!(states[0], states[1]);
}
