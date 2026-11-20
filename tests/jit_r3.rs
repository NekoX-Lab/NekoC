//! Original in-memory probes. These compare local tiers, not an official oracle.
use nekoc::{
    engine::{Engine, Program, encode_frame},
    studio::document::Document,
};
use serde_json::{Value, json};
use std::time::Duration;

const ACTOR: &str = "nekoc-default-actor";

fn num(n: f64) -> Value {
    json!({"type":"math_number","fields":{"NUM":n}})
}
fn get(id: &str) -> Value {
    json!({"type":"variables_get","fields":{"variable":id}})
}
fn set(id: &str, value: Value) -> Value {
    json!({"type":"variables_set","fields":{"variable":id},"inputs":{"value":value}})
}
fn pos(x: f64, y: f64) -> Value {
    json!({"type":"self_move_to","inputs":{"x":num(x),"y":num(y)}})
}
fn begin() -> Value {
    json!({"id":"path-begin","type":"pen_begin_path"})
}
fn close() -> Value {
    json!({"id":"path-close","type":"pen_close_path"})
}
fn fill() -> Value {
    json!({"id":"fill-color","type":"set_fill_style","fields":{"color":"#336699"}})
}
fn chain(blocks: Vec<Value>) -> Value {
    blocks
        .into_iter()
        .rev()
        .reduce(|tail, mut head| {
            head["next"] = tail;
            head
        })
        .unwrap()
}
fn project(body: Vec<Value>, count: usize, k4: bool) -> Value {
    let mut p = Document::blank().value().clone();
    p["sourceMap"] = json!({
        "path-begin":{"file":"jit-path.ts","line":3,"column":5},
        "path-close":{"file":"jit-path.ts","line":4,"column":5},
        "fill-color":{"file":"jit-path.ts","line":5,"column":5},
        "invalid-move":{"file":"jit-path.ts","line":7,"column":9}
    });
    if k4 {
        let source: Value =
            serde_json::from_str(include_str!("fixtures/kitten4/actor-variables.bcm")).unwrap();
        let imported = nekoc::kitten4::to_neko(&source).unwrap();
        p["_nekocKitten4"] = imported["_nekocKitten4"].clone();
    }
    for id in ["tick", "after"] {
        p["variables"]["variablesDict"][id] = json!({"id":id,"isGlobal":true,"value":0});
    }
    let mut ops = vec![
        json!({"type":"change_variables","fields":{"variable":"tick"},
        "inputs":{"value":num(1.0)}}),
    ];
    ops.extend(body);
    ops.push(set("after", get("tick")));
    p["actors"]["actorsDict"][ACTOR]["nekoBlockJsonList"] = json!([{
        "type":"on_running_group_activated","next":{"type":"warp","statements":{"DO":{
            "type":"repeat_n_times","inputs":{"times":num(count as f64)},
            "statements":{"DO":chain(ops)}
        }}}
    }]);
    p
}
fn normalized(bytes: &[u8]) -> (Value, Vec<u8>) {
    let size = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
    let mut meta: Value = serde_json::from_slice(&bytes[4..4 + size]).unwrap();
    meta.as_object_mut().unwrap().remove("execute_us");
    // Keep budget_yield, instructions, ticks and every drawing command.
    (meta, bytes[4 + size..].to_vec())
}

#[derive(Default)]
struct Drawing {
    fills: usize,
    max_fills: usize,
    max_points: usize,
    ordered: bool,
}

fn compare(p: &Value, budget: usize, profile: bool, error: Option<&str>) -> (Engine, Drawing) {
    compare_with_raster(p, budget, profile, error, false)
}

fn compare_with_raster(
    p: &Value,
    budget: usize,
    profile: bool,
    error: Option<&str>,
    raster: bool,
) -> (Engine, Drawing) {
    let compile = || {
        let mut program = Program::compile(p).unwrap();
        program.uses_color |= raster;
        program
    };
    let mut a = Engine::new(compile());
    a.disable_jit();
    let mut b = Engine::new(compile());
    if profile {
        b.enable_jit_profile();
    }
    let mut drawing = Drawing::default();
    // Reuse compiled regions after restarting; paths/fill colours must reset.
    for restart in 0..2 {
        for vm in [&mut a, &mut b] {
            vm.use_virtual_clock();
            vm.set_random_seed(42);
            vm.start();
        }
        let mut done = false;
        for frame in 0..20_000 {
            let previous_helpers = b.jit_profile()["helper_reasons"].clone();
            let left = a.advance(1.0 / 60.0, budget, Duration::from_secs(5));
            let right = b.advance(1.0 / 60.0, budget, Duration::from_secs(5));
            assert_eq!(a.debug_snapshot(), b.debug_snapshot(), "{restart}/{frame}");
            assert_eq!(
                a.jit_debug_snapshot(),
                b.jit_debug_snapshot(),
                "{restart}/{frame}"
            );
            match (left, right) {
                (Ok(x), Ok(y)) => {
                    assert_eq!(
                        normalized(&encode_frame(&x).unwrap()),
                        normalized(&encode_frame(&y).unwrap()),
                        "{restart}/{frame}"
                    );
                    drawing.fills += y.pen_fills.len();
                    drawing.max_fills = drawing.max_fills.max(y.pen_fills.len());
                    drawing.max_points = drawing
                        .max_points
                        .max(y.pen_fills.iter().map(|f| f.points.len()).sum());
                    drawing.ordered |= y
                        .pen_fills
                        .iter()
                        .any(|f| f.before_line > 0 && f.before_text > 0 && f.before_image > 0);
                    for f in &y.pen_fills {
                        assert!(f.points.len() >= 3);
                        assert_eq!(f.color, [0.2, 0.4, 0.6, 1.0]);
                    }
                    a.recycle_lines(x.lines);
                    b.recycle_lines(y.lines);
                    if a.active_tasks() == 0 {
                        assert!(error.is_none(), "expected error {error:?}");
                        done = true;
                        break;
                    }
                }
                (Err(x), Err(y)) => {
                    assert_eq!(x.to_string(), y.to_string());
                    assert!(
                        x.to_string().contains(error.expect("unexpected failure")),
                        "{x:#}"
                    );
                    assert!(x.to_string().contains("jit-path.ts:"), "{x:#}");
                    if error == Some("invalid pen path start") {
                        assert!(
                            x.to_string()
                                .ends_with("jit-path.ts:3:5] at block path-begin"),
                            "{x:#}"
                        );
                    }
                    if error == Some("invalid pen path position") {
                        assert!(
                            x.to_string()
                                .ends_with("jit-path.ts:7:9] at block invalid-move"),
                            "{x:#}"
                        );
                    }
                    if error.is_some_and(|e| {
                        e.contains("requires an actor") || e == "use_pen_blocks_in_scene"
                    }) {
                        // The stage sleeps before the call so this frame has no
                        // actor drawing. The failing instruction must itself
                        // have passed through the native delegation gateway.
                        let helpers = b.jit_profile()["helper_reasons"].clone();
                        let count = |h: &Value| {
                            ["op/PenPath", "op/FillColor"]
                                .iter()
                                .map(|name| h[name].as_u64().unwrap_or(0))
                                .sum::<u64>()
                        };
                        assert_eq!(
                            count(&helpers) - count(&previous_helpers),
                            1,
                            "stage error must execute one native drawing delegate"
                        );
                    }
                    done = true;
                    break;
                }
                (x, y) => panic!("different results: {:?} <> {:?}", x.err(), y.err()),
            }
        }
        assert!(done, "probe must terminate on restart {restart}");
    }
    if profile {
        let stats = b.jit_profile();
        assert!(stats["regions"].as_u64().unwrap() > 0, "{stats}");
        assert!(
            stats["helper_reasons"]["op/PenPath"].as_u64().unwrap_or(0) > 0,
            "path must actually run inside a region: {stats}"
        );
        assert_eq!(
            stats["fallback_reasons"]["unsupported-or-impure/PenPath"]
                .as_u64()
                .unwrap_or(0),
            0,
            "{stats}"
        );
        assert!(stats["delegated_ops"].as_u64().unwrap() <= stats["native_ops"].as_u64().unwrap());
    }
    (b, drawing)
}

fn triangle() -> Vec<Value> {
    vec![
        pos(0.0, 0.0),
        begin(),
        pos(2.0, 0.0),
        pos(0.0, 2.0),
        fill(),
        close(),
    ]
}

#[test]
fn hot_paths_keep_reset_degenerate_close_and_mixed_drawing_order() {
    for k4 in [false, true] {
        let p = project(
            vec![
                json!({"type":"clear_drawing"}),
                json!({"type":"self_pen_up"}),
                pos(0.0, 0.0),
                begin(),
                close(),
                close(),
                begin(),
                pos(1.0, 0.0),
                close(),
                begin(),
                pos(-10.0, -10.0),
                begin(),
                json!({"type":"self_pen_down"}),
                pos(10.0, -10.0),
                pos(0.0, 10.0),
                json!({"type":"stamp","fields":{"align":"left"},"inputs":{"text":{"type":"text","fields":{"TEXT":"r3"}},"size":num(10.0)}}),
                json!({"type":"image_stamp"}),
                json!({"type":"self_set_pen_color_property","fields":{"scope":"alpha"},"inputs":{"val":num(0.0)}}),
                fill(),
                close(),
                close(),
            ],
            900,
            k4,
        );
        let (vm, drawing) = compare(&p, 997, true, None);
        assert_eq!(vm.variable_text("after"), "900");
        assert!(drawing.fills > 0 && drawing.ordered);
        assert!(
            vm.jit_profile()["helper_reasons"]["op/FillColor"]
                .as_u64()
                .unwrap_or(0)
                > 0
        );
    }
}

#[test]
fn hot_paths_survive_small_instruction_slices_and_restart() {
    for k4 in [false, true] {
        let p = project(triangle(), 700, k4);
        // Enough fuel to enter a native chunk, with repeated frame boundaries
        // inside open paths. One-op slices only exercise chunk-entry rejection.
        let (vm, drawing) = compare(&p, 17, true, None);
        assert_eq!(vm.variable_text("after"), "700");
        assert_eq!(drawing.fills, 1400);
    }
}

#[test]
fn closing_hot_paths_honours_fill_count_output_limit_without_profile() {
    for profile in [false, true] {
        let p = project(triangle(), 1400, false);
        let (vm, drawing) = compare(&p, 1_000_000, profile, None);
        assert_eq!(drawing.max_fills, 1024);
        assert_eq!(drawing.fills, 2800);
        assert_eq!(vm.variable_text("after"), "1400");
    }
}

#[test]
fn closing_hot_paths_honours_total_point_output_limit() {
    let mut body = vec![pos(0.0, 0.0), begin()];
    // Fewer than 1024 fills hit the independent 65536-point output limit.
    // Unroll the point appends: a nested loop would reach KN's warp iteration
    // boundary before accumulating enough output to exercise this limit.
    for i in 1..=80 {
        body.push(pos(i as f64, (i % 2) as f64));
    }
    body.extend([fill(), close()]);
    let (vm, drawing) = compare(&project(body, 1100, false), 1_000_000, true, None);
    assert!(drawing.max_points >= 65536);
    assert!(drawing.max_fills < 1024);
    assert_eq!(drawing.fills, 2200);
    assert_eq!(vm.variable_text("after"), "1100");
}

#[test]
fn failing_hot_path_start_keeps_error_pc_fuel_and_successors() {
    for k4 in [false, true] {
        let x = json!({"type":"logic_ternary","inputs":{
            "condition":{"type":"logic_compare","fields":{"OP":"GT"},"inputs":{"A":get("tick"),"B":num(850.0)}},
            "ifTrue":num(1e10),"ifFalse":num(0.0)
        }});
        let p = project(
            vec![
                json!({"type":"self_move_to","inputs":{"x":x,"y":num(0.0)}}),
                begin(),
                pos(1.0, 0.0),
                pos(0.0, 1.0),
                fill(),
                close(),
            ],
            900,
            k4,
        );
        let (vm, _) = compare(&p, 997, true, Some("invalid pen path start"));
        assert_eq!(vm.variable_text("tick"), "851");
        assert_eq!(vm.variable_text("after"), "850");
    }
}

#[test]
fn hot_drawing_procedure_still_rejects_stage_context() {
    for k4 in [false, true] {
        for (operation, expected) in [
            (begin(), "pen path requires an actor"),
            (close(), "pen path requires an actor"),
            (fill(), "fill color requires an actor"),
        ] {
            let call = json!({"type":"procedures_2_callnoreturn",
                "mutation":"<mutation def_id=\"draw\"/>"});
            let mut p = project(vec![call.clone()], 900, k4);
            // The same bytecode is first heated as an actor, then called by a
            // stage task. A region must not bypass exec's actor-only checks.
            p["procedures"]["proceduresDict"]["draw"] = json!({
                "params":[],"nekoBlockJsonList":[{"type":"procedures_2_defnoreturn",
                    "statements":{"STACK":chain(vec![operation, begin(), close()])}}]
            });
            let hot = p["actors"]["actorsDict"][ACTOR]["nekoBlockJsonList"][0]["next"].clone();
            p["actors"]["actorsDict"][ACTOR]["nekoBlockJsonList"][0]["next"] = chain(vec![
                hot,
                json!({"type":"sync_tell","fields":{"sprite":"nekoc-scene-main"},
                "statements":{"DO":{"type":"warp","statements":{"DO":chain(vec![
                    json!({"type":"wait","inputs":{"time":num(0.1)}}), call
                ])}}}}),
                set("after", num(-1.0)),
            ]);
            let (vm, _) = compare(
                &p,
                997,
                true,
                Some(if k4 {
                    "use_pen_blocks_in_scene"
                } else {
                    expected
                }),
            );
            assert_eq!(vm.variable_text("after"), "900");
        }
    }
}

#[test]
fn hot_raster_paths_clear_and_invalid_moves_preserve_tier_boundaries() {
    for k4 in [false, true] {
        for bad_position in [false, true] {
            for budget in [17, 997, 1_000_000] {
                let mut body = triangle();
                // Unlike the invalid-start probe, fail while an open path is
                // recording, after its PC and both drawing helpers became hot.
                if bad_position {
                    let x = json!({"type":"logic_ternary","inputs":{
                        "condition":{"type":"logic_compare","fields":{"OP":"GT"},
                            "inputs":{"A":get("tick"),"B":num(800.0)}},
                        "ifTrue":num(1e10),"ifFalse":num(1.0)
                    }});
                    body.insert(
                        body.len() - 1,
                        json!({"id":"invalid-move","type":"self_move_to","inputs":{"x":x,"y":num(0.0)}}),
                    );
                }
                body.extend([json!({"type":"clear_drawing"}), pos(0.0, 0.0)]);
                let (vm, _) = compare_with_raster(
                    &project(body, 900, k4),
                    budget,
                    true,
                    bad_position.then_some("invalid pen path position"),
                    true,
                );
                assert_eq!(
                    vm.variable_text("after"),
                    if bad_position { "800" } else { "900" }
                );
                assert!(
                    vm.jit_profile()["helper_reasons"]["op/FillColor"]
                        .as_u64()
                        .unwrap_or(0)
                        > 0
                );
            }
        }
    }
}
