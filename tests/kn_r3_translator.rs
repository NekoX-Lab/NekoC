//! Original fixtures for legacy KN conversion placeholders, not translation APIs.
use nekoc::{
    engine::{Engine, Program},
    studio::document::Document,
};
use serde_json::{Value, json};
use std::time::Duration;

const ACTOR: &str = "nekoc-default-actor";
const EXECUTION: &str = "bcm_translator_text_execution_block";
const EVENT: &str = "bcm_translator_text_event_block";
const BOOLEAN: &str = "bcm_translator_text_return_boolean_block";
const VALUE: &str = "bcm_translator_text_return_value_block";

fn num(n: f64) -> Value {
    json!({"type":"math_number","fields":{"NUM":n}})
}

fn log(value: Value) -> Value {
    json!({"type":"console_log","inputs":{"console_log":value}})
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

fn project(roots: Vec<Value>) -> Value {
    let mut project = Document::blank().value().clone();
    project["actors"]["actorsDict"][ACTOR]["nekoBlockJsonList"] = json!(roots);
    project
}

fn start(body: Value) -> Value {
    json!({"id":"start","type":"on_running_group_activated","next":body})
}

fn logs(project: &Value, jit: bool) -> Vec<String> {
    let mut vm = Engine::new(Program::compile(project).unwrap());
    if !jit {
        vm.disable_jit();
    }
    vm.start();
    let mut logs = Vec::new();
    for _ in 0..400 {
        logs.extend(
            vm.advance(1.0 / 60.0, 100_000, Duration::from_secs(2))
                .unwrap()
                .logs,
        );
    }
    logs
}

#[test]
fn disabled_conversion_placeholders_keep_the_next_statement() {
    // Same shape as 303456318/319183075, authored without corpus contents.
    let body = chain(vec![
        log(num(1.0)),
        json!({"id":"legacy-a","type":EXECUTION,"disabled":true,
            "mutation":"<mutation items=\"0\">legacy operation</mutation>"}),
        json!({"id":"legacy-b","type":EXECUTION,"disabled":true}),
        log(num(2.0)),
    ]);
    let p = project(vec![start(json!({"type":"repeat_n_times",
        "inputs":{"times":num(80.0)},"statements":{"DO":body}}))]);
    for jit in [false, true] {
        assert_eq!(logs(&p, jit), ["1", "2"].repeat(80));
    }
}

#[test]
fn disabled_placeholder_does_not_compile_stale_inputs_or_nested_bodies() {
    let p = project(vec![start(chain(vec![
        json!({"id":"legacy","type":EXECUTION,"disabled":true,
            "inputs":{"old_socket":{"type":"unknown-converted-input"}},
            "statements":{"DO":{"type":"unknown-converted-body"}}}),
        log(num(3.0)),
    ]))]);
    for jit in [false, true] {
        assert_eq!(logs(&p, jit), ["3"]);
    }
}

#[test]
fn unknown_disabled_commands_are_not_blanket_noops() {
    let p = project(vec![start(json!({"id":"unsupported",
        "type":"unknown-disabled-command","disabled":true,"next":log(num(9.0))}))]);
    let Err(error) = Program::compile(&p) else {
        panic!("unknown command must fail");
    };
    assert!(format!("{error:#}").contains("unknown-disabled-command"));
}

#[test]
fn all_disabled_placeholder_statement_shapes_skip_obsolete_children() {
    for kind in [EXECUTION, EVENT, BOOLEAN, VALUE] {
        let p = project(vec![start(chain(vec![
            json!({"type":kind,"disabled":true,
                "inputs":{"old":{"type":"unknown-input"}},
                "statements":{"DO":{"type":"unknown-body"}}}),
            log(num(4.0)),
        ]))]);
        assert_eq!(logs(&p, false), ["4"], "{kind}");
    }
}

#[test]
fn enabled_execution_and_event_placeholders_still_fail() {
    for kind in [EXECUTION, EVENT] {
        for disabled in [Value::Null, json!(false)] {
            let mut block = json!({"type":kind,"id":"unsupported-conversion"});
            if !disabled.is_null() {
                block["disabled"] = disabled;
            }
            let p = project(vec![start(block)]);
            let Err(error) = Program::compile(&p) else {
                panic!("missing official domain");
            };
            assert!(format!("{error:#}").contains(kind));
        }
    }
    let p = project(vec![
        json!({"type":EVENT,"disabled":true,
        "inputs":{"old":{"type":"unknown-input"}},"next":log(num(99.0))}),
        start(log(num(5.0))),
    ]);
    assert_eq!(logs(&p, false), ["5"], "disabled event is not a start hat");
    // Despite its suffix this placeholder is not a registered event hat. An
    // unattached root remains dormant, regardless of the disabled flag.
    let p = project(vec![
        json!({"type":EVENT,"disabled":false,"next":log(num(99.0))}),
        start(log(num(5.0))),
    ]);
    assert_eq!(logs(&p, false), ["5"]);
}

#[test]
fn reporters_preserve_official_types_in_typed_numeric_and_boolean_contexts() {
    let reporter = |kind| json!({"type":kind});
    let body = chain(vec![
        log(reporter(VALUE)),
        log(reporter(BOOLEAN)),
        log(json!({"type":"math_arithmetic","fields":{"type":"add"},
            "inputs":{"A":reporter(VALUE),"B":num(1.0)}})),
        log(json!({"type":"logic_compare","fields":{"OP":"EQ"},
            "inputs":{"A":reporter(BOOLEAN),"B":num(0.0)}})),
        json!({"type":"controls_if","inputs":{"IF0":reporter(BOOLEAN)},
            "statements":{"DO0":log(num(99.0))}}),
        log(num(6.0)),
    ]);
    let p = project(vec![start(json!({"type":"repeat_n_times",
        "inputs":{"times":num(80.0)},"statements":{"DO":body}}))]);
    for jit in [false, true] {
        assert_eq!(
            logs(&p, jit),
            ["NaN", "false", "NaN", "false", "6"].repeat(80)
        );
    }
}

#[test]
fn disabled_reporters_are_errors_not_invented_results() {
    for kind in [BOOLEAN, VALUE] {
        let p = project(vec![start(log(json!({"type":kind,"disabled":true})))]);
        let Err(error) = Program::compile(&p) else {
            panic!("disabled_param");
        };
        assert!(format!("{error:#}").contains("disabled_param"));
        let p = project(vec![start(log(json!({"type":kind,
            "inputs":{"stale":{"type":"unknown-input"}}})))]);
        assert!(Program::compile(&p).is_err(), "enabled inputs are compiled");
    }
}

#[test]
fn disabled_reporter_error_precedes_stale_inputs_in_async_and_deep_lowering() {
    for kind in [BOOLEAN, VALUE] {
        for asynchronous in [false, true] {
            for depth in [0, 40] {
                let mut reporter = json!({"id":"disabled-conversion","type":kind,"disabled":true,
                    "inputs":{"ADD0":{"type":"does_not_exist"}}});
                if asynchronous {
                    reporter["inputs"]["ADD1"] = json!({"type":"microbit_accelerometer"});
                }
                for _ in 0..depth {
                    reporter = json!({"type":"_array_literal","inputs":{"items0":reporter}});
                }
                // Typed and numeric consumers enter different compiler paths.
                for numeric in [false, true] {
                    let value = if numeric {
                        json!({"type":"math_arithmetic","fields":{"type":"add"},
                            "inputs":{"A":reporter.clone(),"B":num(1.0)}})
                    } else {
                        reporter.clone()
                    };
                    let p = project(vec![start(log(value))]);
                    let Err(error) = Program::compile(&p) else {
                        panic!("disabled reporter compiled");
                    };
                    let error = format!("{error:#}");
                    assert!(
                        error.contains("disabled_param"),
                        "{kind} async={asynchronous} depth={depth} numeric={numeric}: {error}"
                    );
                    assert!(error.contains("disabled-conversion"), "{error}");
                    assert!(!error.contains("does_not_exist"), "{error}");
                }
            }
        }
    }
}

#[test]
fn reporter_inputs_run_once_in_object_order_including_async_children() {
    for asynchronous in [false, true] {
        for kind in [BOOLEAN, VALUE] {
            let put = |value: &str| {
                json!({"type":"_object_set","inputs":{
                    "obj":{"type":"variables_get","fields":{"variable":"obj"}},
                    "key":{"type":"text","fields":{"TEXT":"trace"}},
                    "value":{"type":"text_join","inputs":{
                        "ADD0":{"type":"_object_get","inputs":{
                            "obj":{"type":"variables_get","fields":{"variable":"obj"}},
                            "key":{"type":"text","fields":{"TEXT":"trace"}}}},
                        "ADD1":{"type":"text","fields":{"TEXT":value}}
                    }}
                }})
            };
            // ADD1 precedes ADD0 deliberately: these are dynamic sockets, not a
            // temporary_list. Numeric ADD suffix sorting would produce "BA".
            let mut reporter = json!({"type":kind,"inputs":{"ADD1":put("A")}});
            if asynchronous {
                reporter["inputs"]["sensor"] = json!({"type":"microbit_accelerometer"});
            }
            reporter["inputs"]["ADD0"] = put("B");
            let body = chain(vec![
                log(reporter),
                log(json!({"type":"_object_get","inputs":{
                    "obj":{"type":"variables_get","fields":{"variable":"obj"}},
                    "key":{"type":"text","fields":{"TEXT":"trace"}}
                }})),
            ]);
            let mut p = project(vec![start(json!({"type":"repeat_n_times",
                "inputs":{"times":num(80.0)},"statements":{"DO":body}}))]);
            p["variables"]["variablesDict"]["obj"] =
                json!({"id":"obj","name":"obj","type":"variable","value":{"trace":""}});
            for jit in [false, true] {
                let expected = if kind == BOOLEAN { "false" } else { "NaN" };
                let expected = (1..=80)
                    .flat_map(|n| [expected.to_owned(), "AB".repeat(n)])
                    .collect::<Vec<_>>();
                assert_eq!(
                    logs(&p, jit),
                    expected,
                    "{kind} async={asynchronous} jit={jit}"
                );
            }
        }
    }
}
