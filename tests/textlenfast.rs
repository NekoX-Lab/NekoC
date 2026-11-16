//! UTF-16 counts, coercions, reporter effects, and real hot native execution.
use nekoc::engine::{Cell, Engine, Program, Text, encode_frame};
use serde_json::{Value, json};
use std::{cell::RefCell, rc::Rc, time::Duration};

#[test]
fn textlenfast_cells_match_the_previous_conversion_for_every_tag() {
    let cyclic = Rc::new(RefCell::new(vec![Cell::Text("😀".into())]));
    cyclic.borrow_mut().push(Cell::List(cyclic.clone()));
    let mut values = vec![
        Cell::Number(0.0),
        Cell::Number(-0.0),
        Cell::Number(1e21),
        Cell::Number(1e-7),
        Cell::Number(f64::NAN),
        Cell::Number(f64::INFINITY),
        Cell::Number(f64::NEG_INFINITY),
        Cell::Bool(true),
        Cell::Bool(false),
        Cell::Null,
        Cell::Undefined,
        Cell::List(cyclic.clone()),
        Cell::Costume("id".into()),
        Cell::Object(Rc::new(RefCell::new(vec![]))),
        Cell::Midi(Rc::new(Cell::Number(1.0))),
        Cell::from_json(&json!(["😀", [null, true, "e\u{301}"], false, 1e21])).unwrap(),
        Cell::from_json(&json!([])).unwrap(),
    ];
    let corpus: Value = serde_json::from_str(include_str!("fixtures/textlenfast.json")).unwrap();
    for case in corpus.as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        let expected = case["length"].as_u64().unwrap() as usize;
        for leaf in [Text::from(text), Text::from(text.to_owned())] {
            assert_eq!(leaf.utf16_len(), expected);
            values.push(Cell::Text(leaf));
        }
    }
    for value in &values {
        assert_eq!(value.text_length(), value.text().encode_utf16().count());
    }
    // Mutable non-text values must not acquire a stale text-length cache.
    let list = Cell::List(cyclic.clone());
    let before = list.text_length();
    cyclic.borrow_mut().push(Cell::Bool(false));
    assert_eq!(list.text_length(), before + 6);
    cyclic.borrow_mut().clear();
}

fn num(n: usize) -> Value {
    json!({"type":"math_number","fields":{"NUM":n}})
}
fn text(s: &str) -> Value {
    json!({"type":"text","fields":{"TEXT":s}})
}
fn get(id: &str) -> Value {
    json!({"type":"variables_get","fields":{"variable":id}})
}
fn set(id: &str, value: Value) -> Value {
    json!({"type":"variables_set","fields":{"variable":id},"inputs":{"value":value}})
}
fn length(value: Value) -> Value {
    json!({"type":"text_length","inputs":{"text":value}})
}
fn join(a: Value, b: Value) -> Value {
    json!({"type":"text_join","inputs":{"ADD0":a,"ADD1":b}})
}
fn chain(ops: Vec<Value>) -> Value {
    ops.into_iter()
        .rev()
        .reduce(|next, mut op| {
            op["next"] = next;
            op
        })
        .unwrap()
}
fn normalized(bytes: &[u8]) -> (Value, Vec<u8>) {
    let len = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
    let mut meta: Value = serde_json::from_slice(&bytes[4..4 + len]).unwrap();
    for key in ["execute_us", "budget_yield"] {
        meta.as_object_mut().unwrap().remove(key);
    }
    (meta, bytes[4 + len..].to_vec())
}

#[test]
fn textlenfast_hot_tiers_keep_typed_state_logs_and_single_reporter_evaluation() {
    for k4 in [false, true] {
        for prepend in [false, true] {
            let piece = text("x😀e\u{301}");
            let growing = if prepend {
                join(piece, get("s"))
            } else {
                join(get("s"), piece)
            };
            let reporter =
                json!({"type":"procedures_2_callreturn","mutation":"<mutation def_id=\"side\"/>"});
            let body = chain(vec![
                set("s", growing),
                set("out", length(get("s"))),
                set("list_length", length(get("items"))),
                set("bool_length", length(get("flag"))),
                set("number_length", length(get("negative_zero"))),
                set("side_length", length(reporter)),
                json!({"type":"console_log","inputs":{"console_log":get("out")}}),
            ]);
            let mut p = nekoc::studio::document::Document::blank().value().clone();
            if k4 {
                let source: Value =
                    serde_json::from_str(include_str!("fixtures/kitten4/actor-variables.bcm"))
                        .unwrap();
                let imported = nekoc::kitten4::to_neko(&source).unwrap();
                p["_nekocKitten4"] = imported["_nekocKitten4"].clone();
            }
            for (id, value) in [
                ("s", json!("")),
                ("out", json!(0)),
                ("side_length", json!(0)),
                ("effects", json!(0)),
                ("items", json!(["😀", true, [null, "e\u{301}"]])),
                ("flag", json!(false)),
                ("negative_zero", json!(-0.0)),
                ("list_length", json!(0)),
                ("bool_length", json!(0)),
                ("number_length", json!(0)),
            ] {
                p["variables"]["variablesDict"][id] =
                    json!({"id":id,"name":id,"value":value,"isGlobal":true});
            }
            p["procedures"]["proceduresDict"]["side"] = json!({"params":[],"nekoBlockJsonList":[{
                "type":"procedures_2_defreturn","statements":{"STACK":chain(vec![
                    json!({"type":"change_variables","fields":{"variable":"effects"},"inputs":{"value":num(1)}}),
                    json!({"type":"procedures_2_return_value","mutation":"<mutation items=\"1\"/>","inputs":{"VALUE":get("s")},"shadows":{"VALUE":num(0)}}),
                ])}
            }]});
            p["actors"]["actorsDict"]["nekoc-default-actor"]["nekoBlockJsonList"] = json!([{
                "type":"on_running_group_activated","next":{"type":"warp","statements":{"DO":{
                    "type":"repeat_n_times","inputs":{"times":num(1200)},"statements":{"DO":body}
                }}}
            }]);
            let build = || Engine::new(Program::compile(&p).unwrap());
            let mut a = build();
            let mut b = build();
            a.disable_jit();
            b.enable_jit_profile();
            for _ in 0..2 {
                for vm in [&mut a, &mut b] {
                    vm.set_random_seed(42);
                    vm.use_virtual_clock();
                    vm.start();
                }
                let mut finished = false;
                let mut logs = Vec::new();
                for frame in 0..2000 {
                    let x = a.advance(1.0 / 60.0, 73, Duration::from_secs(5)).unwrap();
                    let y = b.advance(1.0 / 60.0, 73, Duration::from_secs(5)).unwrap();
                    assert_eq!(
                        a.jit_debug_snapshot(),
                        b.jit_debug_snapshot(),
                        "frame {frame}"
                    );
                    assert_eq!(a.debug_snapshot(), b.debug_snapshot());
                    assert_eq!(
                        normalized(&encode_frame(&x).unwrap()),
                        normalized(&encode_frame(&y).unwrap())
                    );
                    logs.extend(x.logs.iter().cloned());
                    a.recycle_lines(x.lines);
                    b.recycle_lines(y.lines);
                    if a.active_tasks() == 0 {
                        finished = true;
                        break;
                    }
                }
                assert!(finished);
                assert_eq!(
                    logs,
                    (1..=1200).map(|n| (n * 5).to_string()).collect::<Vec<_>>()
                );
                assert!(matches!(b.variable_value("s"), Cell::Text(_)));
                assert!(matches!(b.variable_value("out"), Cell::Number(6000.0)));
                assert_eq!(b.variable_text("side_length"), "6000");
                assert_eq!(b.variable_text("effects"), "1200");
                assert_eq!(b.variable_text("list_length"), "11");
                assert_eq!(b.variable_text("bool_length"), "5");
                assert_eq!(b.variable_text("number_length"), "1");
                assert_eq!(b.variable_text("s"), "x😀e\u{301}".repeat(1200));
                let profile = b.jit_profile();
                assert!(profile["regions"].as_u64().unwrap() > 0, "{profile}");
                assert!(profile["native_ops"].as_u64().unwrap() > 0, "{profile}");
                // The pure Global operand belongs to the TextLength expression
                // helper, not just a native region somewhere else in the loop.
                assert!(profile["node_calls"].as_u64().unwrap() > 0, "{profile}");
                assert!(
                    profile["helper_reasons"]["reporter/Global"]
                        .as_u64()
                        .unwrap_or(0)
                        > 0,
                    "{profile}"
                );
            }
        }
    }
}
