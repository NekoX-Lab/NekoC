//! Kitten N shapes found in published PICKCAT works that used to stop compilation.
//! Each case is a self-authored minimal project, not a copy of a third-party work.
use nekoc::{
    engine::{Engine, Program},
    studio::document::Document,
};
use serde_json::{Value, json};
use std::time::Duration;

const ACTOR: &str = "nekoc-default-actor";

fn num(n: f64) -> Value {
    json!({"type":"math_number","fields":{"NUM":n}})
}
fn set(name: &str, value: Value) -> Value {
    json!({"type":"variables_set","fields":{"variable":name},"inputs":{"value":value}})
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
fn project(roots: Vec<Value>, variables: &[&str]) -> Value {
    let mut project = Document::blank().value().clone();
    project["actors"]["actorsDict"][ACTOR]["nekoBlockJsonList"] = json!(roots);
    for id in variables {
        project["variables"]["variablesDict"][id] =
            json!({"id":id,"name":id,"type":"any","value":0,"isGlobal":true});
    }
    project
}
fn start(body: Value) -> Value {
    json!({"id":"start","type":"on_running_group_activated","next":body})
}
fn run(project: &Value) -> Engine {
    let mut vm = Engine::new(Program::compile(project).unwrap());
    vm.use_virtual_clock();
    vm.start();
    for _ in 0..3 {
        vm.advance(1.0 / 60.0, 1_000_000, Duration::from_secs(2))
            .unwrap();
    }
    vm
}

#[test]
fn any_disconnected_statement_stack_stays_dormant_but_unknown_hats_still_fail() {
    let loose = |id: &str, kind: &str| json!({"id":id,"type":kind,"next":set("loose", num(99.0))});
    let p = project(
        vec![
            start(set("active", num(1.0))),
            loose("wait", "wait"),
            loose("if", "controls_if"),
            loose("stamp", "stamp"),
            loose("glide", "self_glide_to"),
            loose("broadcast", "self_broadcast"),
        ],
        &["active", "loose"],
    );
    let vm = run(&p);
    assert_eq!(vm.variable_value("active").number(), 1.0);
    assert_eq!(vm.variable_value("loose").number(), 0.0);

    for hat in ["on_future_event", "future_when", "start_on_future"] {
        let p = project(vec![loose("hat", hat)], &["loose"]);
        let Err(error) = Program::compile(&p) else {
            panic!("{hat} compiled");
        };
        let error = error.to_string();
        assert!(error.contains("unsupported root"), "{hat}: {error}");
    }
}

#[test]
fn numeric_boundary_options_follow_the_official_dropdown() {
    // 0 all, 1 left, 2 top, 3 bottom, 4 right.
    let edge = |value: &str| json!({"type":"out_of_boundary","fields":{"boundary":value}});
    let names = ["all", "left", "top", "bottom", "right"];
    let mut body = vec![json!({"type":"self_move_to","inputs":{"x":num(0.0),"y":num(5000.0)}})];
    for (value, name) in names.iter().enumerate() {
        body.push(set(name, edge(&value.to_string())));
    }
    let vm = run(&project(vec![start(chain(body))], &names));
    let result: Vec<f64> = names
        .iter()
        .map(|name| vm.variable_value(name).number())
        .collect();
    assert_eq!(result, [1.0, 0.0, 1.0, 0.0, 0.0]);
}

#[test]
fn local_private_list_is_an_ordinary_list() {
    let mut p = project(
        vec![start(set(
            "n",
            json!({"type":"list_length","inputs":{"list":{"type":"pure_list_get","fields":{"list":"memory"}}}}),
        ))],
        &["n"],
    );
    p["variables"]["variablesDict"]["memory"] = json!({"id":"memory","name":"memory",
        "type":"private_list","value":["a","b"],"isGlobal":true});
    assert_eq!(run(&p).variable_value("n").number(), 2.0);
}

#[test]
fn pen_size_slider_shadow_is_a_number() {
    let slider = json!({"type":"color_size_slider","is_shadow":true,"fields":{"NUM":"12"}});
    let p = project(
        vec![start(chain(vec![
            json!({"type":"self_set_pen_size","inputs":{"size":slider.clone()}}),
            set("size", slider),
        ]))],
        &["size"],
    );
    assert_eq!(run(&p).variable_value("size").number(), 12.0);
}

#[test]
fn kn_weekday_options_report_text_and_number() {
    let time = |unit: &str| json!({"type":"get_time","fields":{"time":unit}});
    let p = project(
        vec![start(chain(vec![
            set("text", time("weekday")),
            set("number", time("weekday_num")),
        ]))],
        &["text", "number"],
    );
    // The virtual clock starts on Saturday 2000-01-01 UTC.
    let vm = run(&p);
    assert_eq!(vm.variable_value("text").text(), "星期六");
    assert_eq!(vm.variable_value("number").number(), 6.0);
}

#[test]
fn procedure_boolean_shadow_is_a_boolean_constant() {
    let flag =
        |value: &str| json!({"type":"procedure_boolean","is_shadow":true,"fields":{"VALUE":value}});
    let when = |value: &str, name: &str| json!({"type":"controls_if","inputs":{"IF0":flag(value)},"statements":{"DO0":set(name, num(1.0))}});
    let p = project(
        vec![start(chain(vec![
            set("value", flag("true")),
            when("true", "taken"),
            when("false", "skipped"),
        ]))],
        &["value", "taken", "skipped"],
    );
    let vm = run(&p);
    assert_eq!(vm.variable_value("value").text(), "true");
    assert_eq!(vm.variable_value("taken").number(), 1.0);
    assert_eq!(vm.variable_value("skipped").number(), 0.0);
}

#[test]
fn coordinate_blocks_read_the_official_kn_field_name() {
    let p = project(
        vec![start(chain(vec![
            json!({"type":"self_set_position","fields":{"coordinate":"x"},"inputs":{"value":num(40.0)}}),
            json!({"type":"self_set_position","fields":{"coordinate":"y"},"inputs":{"value":num(-5.0)}}),
            json!({"type":"self_change_coordinate","fields":{"coordinate":"y","increase":"increase"},
                "inputs":{"value":num(15.0)}}),
            set("x", json!({"type":"self_get_position_x"})),
            set("y", json!({"type":"self_get_position_y"})),
        ]))],
        &["x", "y"],
    );
    let vm = run(&p);
    assert_eq!(vm.variable_value("x").number(), 40.0);
    assert_eq!(vm.variable_value("y").number(), 10.0);
}

#[test]
fn unknown_effect_option_is_skipped() {
    // Official setTargetEffects logs "cant find effect type_" and returns.
    let effect = |kind: &str| {
        json!({"type":kind,"fields":{"scope":"?","increase":"increase"},
            "inputs":{"value":num(50.0)}})
    };
    let p = project(
        vec![start(chain(vec![
            effect("self_set_effect"),
            effect("self_change_effect"),
            json!({"type":"change_variables","fields":{"variable":"count","method":"increase"},
                "inputs":{"value":num(1.0)}}),
            set_ghost_probe(),
        ]))],
        &["count", "ghost"],
    );
    let vm = run(&p);
    assert_eq!(vm.variable_value("count").number(), 1.0);
    assert_eq!(vm.variable_value("ghost").number(), 0.0);
}

fn set_ghost_probe() -> Value {
    set(
        "ghost",
        json!({"type":"get_clone_index_property","fields":{"sprite":"--self","attribute":"1"},
            "inputs":{"index":num(0.0)}}),
    )
}

#[test]
fn clone_property_of_a_deleted_actor_is_nan() {
    let deleted = json!({"type":"get_clone_index_property",
        "fields":{"sprite":"deleted-actor-id","attribute":"scale"},"inputs":{"index":num(1.0)}});
    let sensing = |kind: &str, option: &str, value: &str| json!({"type":kind,"fields":{"sprite":"deleted-actor-id",option:value}});
    let p = project(
        vec![start(chain(vec![
            set("value", deleted),
            set("x", sensing("coordinate_of_sprite", "coordinate", "x")),
            set(
                "width",
                sensing("appearance_of_sprite", "appearance", "width"),
            ),
            set("effect", sensing("effect_of_sprite", "effect", "1")),
            set(
                "style",
                json!({"type":"style_of_sprite","fields":{"sprite":"deleted-actor-id"}}),
            ),
            set("after", num(1.0)),
        ]))],
        &["value", "x", "width", "effect", "style", "after"],
    );
    let vm = run(&p);
    for name in ["value", "x", "width", "effect", "style"] {
        assert!(vm.variable_value(name).number().is_nan(), "{name}");
    }
    assert_eq!(vm.variable_value("after").number(), 1.0);
}
