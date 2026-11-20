//! Boundary expectations come from unchanged official domain calls, archived
//! with bundle hashes in docs/kn-r3-text-evidence.json; not a JS-only oracle.
use nekoc::{
    engine::{Cell, Engine, Program},
    studio::document::Document,
};
use serde_json::{Value, json};
use std::time::Duration;

fn text(value: &str) -> Value {
    json!({"type":"text","fields":{"TEXT":value}})
}

fn literal(value: &Value) -> Value {
    match value {
        Value::String(s) => text(s),
        Value::Number(n) => json!({"type":"math_number","fields":{"NUM":n.to_string()}}),
        Value::Bool(b) => {
            json!({"type":"logic_boolean","fields":{"BOOL":if *b {"true"} else {"false"}}})
        }
        Value::Null => json!({"type":"JSON.parse","inputs":{"text":text("null")}}),
        Value::Array(values) => {
            let inputs: serde_json::Map<String, Value> = values
                .iter()
                .enumerate()
                .map(|(i, v)| (format!("items{i}"), literal(v)))
                .collect();
            json!({"type":"_array_literal","inputs":inputs})
        }
        Value::Object(_) if value["$undefined"] == true => {
            json!({"type":"_object_get","inputs":{"obj":{"type":"_object_literal"},"key":text("missing")}})
        }
        Value::Object(_) => {
            let number = value["$number"].as_str().expect("number tag");
            json!({"type":"convert_type","fields":{"type":"number"},"inputs":{"text":text(number)}})
        }
    }
}

fn reporter(call: &Value) -> Value {
    let mut inputs = serde_json::Map::new();
    let mut fields = serde_json::Map::new();
    for (key, value) in call["args"].as_object().unwrap() {
        if key == "OP" || key == "type" {
            fields.insert(key.clone(), value.clone());
        } else {
            inputs.insert(key.clone(), literal(value));
        }
    }
    json!({"type":call["type"],"fields":fields,"inputs":inputs})
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

fn set(name: &str, value: Value) -> Value {
    json!({"type":"variables_set","fields":{"variable":name},"inputs":{"value":value}})
}

fn get(name: &str) -> Value {
    json!({"type":"variables_get","fields":{"variable":name}})
}

fn project(body: Value, names: &[String]) -> Value {
    let mut p = Document::blank().value().clone();
    for name in names {
        p["variables"]["variablesDict"][name] =
            json!({"id":name,"name":name,"type":"any","value":0,"isGlobal":true});
    }
    p["actors"]["actorsDict"]["nekoc-default-actor"]["nekoBlockJsonList"] = json!([
        {"type":"on_running_group_activated","next":body}
    ]);
    p
}

fn run(p: &Value, jit: bool) -> Engine {
    let mut vm = Engine::new(Program::compile(p).unwrap());
    if !jit {
        vm.disable_jit();
    }
    vm.use_virtual_clock();
    vm.start();
    for _ in 0..90 {
        vm.advance(1.0 / 60.0, 1_000_000, Duration::from_secs(5))
            .unwrap();
    }
    vm
}

fn evidence() -> Value {
    let evidence: Value =
        serde_json::from_str(include_str!("../docs/kn-r3-text-evidence.json")).unwrap();
    assert_eq!(evidence["ok"], true);
    assert_eq!(
        evidence["observation"]["calls"].as_array().unwrap().len(),
        718
    );
    evidence
}

fn check_calls(kind: &str) {
    let evidence = evidence();
    let calls = evidence["observation"]["calls"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["type"] == kind)
        // Domain calls see raw null, but the KN block compiler normalizes a
        // null reporter parameter to undefined before text_join. Preserve the
        // existing full-project observations in tests/kn_value_types.rs.
        .filter(|c| !matches!(c["label"].as_str(), Some("join-15" | "join-16")))
        .collect::<Vec<_>>();
    assert!(!calls.is_empty());
    let names = (0..calls.len())
        .map(|i| format!("r{i}"))
        .collect::<Vec<_>>();
    let body = chain(
        calls
            .iter()
            .zip(&names)
            .map(|(c, name)| set(name, reporter(c)))
            .collect(),
    );
    let p = project(
        json!({"type":"repeat_n_times","inputs":{"times":literal(&json!(80))},"statements":{"DO":body}}),
        &names,
    );
    for jit in [false, true] {
        let vm = run(&p, jit);
        for (call, name) in calls.iter().zip(&names) {
            let actual = vm.variable_value(name);
            let expected = &call["result"];
            let equal = match (&actual, expected) {
                (Cell::Text(a), Value::String(b)) => a.as_ref() == b,
                (Cell::Bool(a), Value::Bool(b)) => a == b,
                (Cell::Number(a), Value::Number(b)) => Some(*a) == b.as_f64(),
                _ => false,
            };
            assert!(
                equal,
                "{} jit={jit}: {actual:?} != {expected}",
                call["label"]
            );
        }
    }
}

#[test]
fn decimal_exponent_signed_zero_and_nonfinite_conversion() {
    check_calls("convert_type");
}

#[test]
fn numeric_text_length_uses_the_same_number_format() {
    check_calls("text_length");
}

#[test]
fn concatenation_preserves_spelling_case_and_numeric_format() {
    check_calls("text_join");
}

#[test]
fn text_and_mixed_comparisons_match_official_for_all_six_operators() {
    check_calls("logic_compare");
}

#[test]
fn contains_is_case_sensitive_and_rejects_nullish_or_nan_inputs() {
    check_calls("text_contain");
}

#[test]
fn unicode_case_code_apis_coerce_scalars_lists_and_nullish() {
    check_calls("String.toLowerCase");
    check_calls("String.toUpperCase");
    for kind in ["String.toLowerCase", "String.toUpperCase"] {
        let p = project(set("result", json!({"type":kind})), &["result".into()]);
        for jit in [false, true] {
            assert_eq!(run(&p, jit).variable_value("result").text(), "");
        }
    }
}

#[test]
fn hot_numeric_nan_comparisons_and_joined_unicode_text_keep_their_semantics() {
    let compare =
        |op, a, b| json!({"type":"logic_compare","fields":{"OP":op},"inputs":{"A":a,"B":b}});
    let join = |a, b| json!({"type":"text_join","inputs":{"ADD0":a,"ADD1":b}});
    let p = project(
        chain(vec![
            set("a", literal(&json!({"$number":"NaN"}))),
            set("b", literal(&json!({"$number":"NaN"}))),
            set("prefix", text("")),
            json!({"type":"repeat_n_times","inputs":{"times":literal(&json!(80))},"statements":{"DO":chain(vec![
                set("eq", compare("EQ", get("a"), get("b"))),
                set("ne", compare("NEQ", get("a"), get("b"))),
                set("prefix", join(get("prefix"), text("x"))),
                set("less", compare("LT", join(get("prefix"), text("😀")), join(get("prefix"), text("\u{e000}")))),
                set("same", compare("EQ", join(get("prefix"), text("😀")), join(join(get("prefix"), text("")), text("😀")))),
            ])}}),
        ]),
        &["a", "b", "prefix", "eq", "ne", "less", "same"].map(String::from),
    );
    for jit in [false, true] {
        let vm = run(&p, jit);
        for (name, expected) in [("eq", true), ("ne", false), ("less", true), ("same", true)] {
            assert!(
                matches!(vm.variable_value(name), Cell::Bool(v) if v == expected),
                "{name} jit={jit}"
            );
        }
        assert_eq!(vm.variable_value("prefix").text(), "x".repeat(80));
    }
}

#[test]
fn nested_join_in_console_obeys_undefined_termination_per_join() {
    let undefined = || literal(&json!({"$undefined":true}));
    let join = |values: Vec<Value>| {
        let inputs: serde_json::Map<String, Value> = values
            .into_iter()
            .enumerate()
            .map(|(i, v)| (format!("ADD{i}"), v))
            .collect();
        json!({"type":"text_join","inputs":inputs})
    };
    let cases = [
        (join(vec![text("a"), literal(&Value::Null), text("b")]), "a"),
        (join(vec![text("a"), undefined(), text("b")]), "a"),
        (
            join(vec![
                text("a"),
                join(vec![text("b"), undefined()]),
                text("c"),
            ]),
            "abc",
        ),
        (
            join(vec![undefined(), join(vec![text("b"), text("c")])]),
            "",
        ),
    ];
    for (value, expected) in cases {
        let p = project(
            json!({"type":"console_log","inputs":{"console_log":value}}),
            &[],
        );
        for jit in [false, true] {
            let mut vm = Engine::new(Program::compile(&p).unwrap());
            if !jit {
                vm.disable_jit();
            }
            vm.start();
            let step = vm
                .advance(1.0 / 60.0, 100_000, Duration::from_secs(1))
                .unwrap();
            assert_eq!(step.logs, [expected], "jit={jit}");
        }
    }
}
