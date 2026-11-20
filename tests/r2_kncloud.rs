//! Anonymous KN is a writable session, not K4's cloud transport.
//! Official source and browser evidence: docs/kitten-n-cloud.md.
//! Projects here are original minimal probes, not third-party corpus copies.
use nekoc::{
    cloud::{CloudBackend, CloudKey, MemoryCloudBackend},
    engine::{Engine, Program},
    studio::document::Document,
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

fn num(value: f64) -> Value {
    json!({"type":"math_number","fields":{"NUM":value}})
}

fn text(value: &str) -> Value {
    json!({"type":"text","fields":{"TEXT":value}})
}

fn get(id: &str) -> Value {
    json!({"type":"variables_get","fields":{"variable":id}})
}

fn set(id: &str, value: Value) -> Value {
    json!({"type":"variables_set","fields":{"variable":id},"inputs":{"value":value}})
}

fn change(id: &str, method: &str, value: f64) -> Value {
    json!({"type":"change_variables","fields":{"variable":id,"method":method},
        "inputs":{"value":num(value)}})
}

fn list(id: &str) -> Value {
    json!({"type":"pure_list_get","fields":{"list":id}})
}

fn project(blocks: Vec<Value>, variables: Value) -> Value {
    let mut project = Document::blank().value().clone();
    let body = blocks.into_iter().rev().reduce(|next, mut block| {
        block["next"] = next;
        block
    });
    project["actors"]["actorsDict"]["nekoc-default-actor"]["nekoBlockJsonList"] =
        json!([{"id":"kncloud-start","type":"on_running_group_activated","next":body}]);
    project["variables"]["variablesDict"] = variables;
    project
}

fn engine(project: &Value, interpreter: bool) -> Engine {
    let mut vm = Engine::new(Program::compile(project).unwrap());
    if interpreter {
        vm.disable_jit();
    }
    vm.use_virtual_clock();
    vm.start();
    vm
}

fn advance(vm: &mut Engine) {
    for _ in 0..3 {
        vm.advance(1.0 / 60.0, 1_000_000, Duration::from_secs(2))
            .unwrap();
    }
    assert_eq!(
        vm.active_tasks(),
        0,
        "anonymous data must not wait for login"
    );
}

fn value(vm: &Engine, id: &str) -> Value {
    serde_json::to_value(vm.variable_value(id)).unwrap()
}

#[test]
fn anonymous_scalars_keep_saved_values_and_allow_immediate_read_after_write() {
    // PublicCV with/without cvId and LocalVariable all take the ordinary
    // variables domain branch when the anonymous player has no cloud socket.
    for kind in ["public", "private"] {
        for cv_id in [None, Some(""), Some("kncloud-remote-id")] {
            let mut vars = json!({
                "data":{"id":"data","type":kind,"value":17,"isGlobal":true},
                "initial":{"id":"initial","type":"any","value":0,"isGlobal":true},
                "changed":{"id":"changed","type":"any","value":0,"isGlobal":true},
                "written":{"id":"written","type":"any","value":0,"isGlobal":true}
            });
            if let Some(cv_id) = cv_id {
                vars["data"]["cvId"] = json!(cv_id);
            }
            let p = project(
                vec![
                    set("initial", get("data")),
                    change("data", "increase", 5.0),
                    change("data", "decrease", 2.0),
                    set("changed", get("data")),
                    set("data", text("anonymous session")),
                    set("written", get("data")),
                ],
                vars,
            );
            for interpreter in [false, true] {
                let mut vm = engine(&p, interpreter);
                assert_eq!(value(&vm, "data"), json!(17.0));
                advance(&mut vm);
                assert_eq!(value(&vm, "initial"), json!(17.0));
                assert_eq!(value(&vm, "changed"), json!(20.0));
                assert_eq!(value(&vm, "data"), json!("anonymous session"));
                assert_eq!(value(&vm, "written"), json!("anonymous session"));
                vm.start();
                assert_eq!(value(&vm, "data"), json!(17.0));
                advance(&mut vm);
                assert_eq!(value(&vm, "changed"), json!(20.0));
                assert_eq!(value(&engine(&p, interpreter), "data"), json!(17.0));
            }
        }
    }
}

#[test]
fn anonymous_public_fallback_does_not_apply_connected_cloud_value_restrictions() {
    // The official scalar/string length checks belong to the connected socket
    // branch, not to an anonymous public variable. Lists retain their identity.
    let long_text = "猫".repeat(2048);
    let p = project(
        vec![
            set("public", text(&long_text)),
            set("saved", get("public")),
            set("public", list("items")),
            json!({"type":"list_append","inputs":{"list":list("items"),
                "list_item_value":text("live")}}),
            set("alias", get("public")),
        ],
        json!({
            "public":{"id":"public","type":"public","cvId":"remote","value":"seed","isGlobal":true},
            "saved":{"id":"saved","type":"any","value":0,"isGlobal":true},
            "alias":{"id":"alias","type":"any","value":0,"isGlobal":true},
            "items":{"id":"items","type":"list","value":["seed"],"isGlobal":true}
        }),
    );
    for interpreter in [false, true] {
        let mut vm = engine(&p, interpreter);
        assert_eq!(value(&vm, "public"), json!("seed"));
        advance(&mut vm);
        assert_eq!(value(&vm, "saved"), json!(long_text));
        assert_eq!(value(&vm, "public"), json!(["seed", "live"]));
        assert_eq!(value(&vm, "alias"), json!(["seed", "live"]));
    }
}

#[test]
fn anonymous_private_list_mutations_are_visible_and_restart_from_saved_items() {
    // private_list means LocalList. Anonymous init skips device storage loading,
    // and a missing user ID prevents persistence without rejecting list writes.
    let p = project(
        vec![
            json!({"type":"list_append","inputs":{"list":list("memory"),"list_item_value":text("tail")}}),
            json!({"type":"list_insert_value","inputs":{"list":list("memory"),"list_index":num(2.0),"list_item_value":text("middle")}}),
            json!({"type":"replace_list_item","fields":{"item":"any"},"inputs":{"list":list("memory"),"list_index":num(1.0),"list_item_value":text("head")}}),
            json!({"type":"delete_list_item","fields":{"item":"last"},"inputs":{"list":list("memory")}}),
            json!({"type":"list_copy","inputs":{"list":list("memory"),"target_list":list("copy")}}),
            set(
                "length",
                json!({"type":"list_length","inputs":{"list":list("memory")}}),
            ),
            set(
                "first",
                json!({"type":"list_item","fields":{"item":"any"},"inputs":{"list":list("memory"),"list_index":num(1.0)}}),
            ),
            json!({"type":"delete_list_item","fields":{"item":"all"},"inputs":{"list":list("memory")}}),
        ],
        json!({
            "memory":{"id":"memory","type":"private_list","value":["seed",true],"isGlobal":true},
            "copy":{"id":"copy","type":"private_list","value":[],"isGlobal":true},
            "length":{"id":"length","type":"any","value":0,"isGlobal":true},
            "first":{"id":"first","type":"any","value":0,"isGlobal":true}
        }),
    );
    for interpreter in [false, true] {
        let mut vm = engine(&p, interpreter);
        assert_eq!(value(&vm, "memory"), json!(["seed", true]));
        advance(&mut vm);
        assert_eq!(value(&vm, "copy"), json!(["head", "middle", true]));
        assert_eq!(value(&vm, "length"), json!(3.0));
        assert_eq!(value(&vm, "first"), json!("head"));
        assert_eq!(value(&vm, "memory"), json!([]));
        vm.start();
        assert_eq!(value(&vm, "memory"), json!(["seed", true]));
        assert_eq!(value(&vm, "copy"), json!([]));
        advance(&mut vm);
        assert_eq!(value(&vm, "copy"), json!(["head", "middle", true]));
        assert_eq!(
            value(&engine(&p, interpreter), "memory"),
            json!(["seed", true])
        );
    }
}

#[test]
fn k4_local_cloud_backend_does_not_authenticate_or_override_kn_session_data() {
    let p = project(
        vec![set("public", num(42.0)), set("private", num(43.0))],
        json!({
            "public":{"id":"public","type":"public","cvId":"remote","value":7,"isGlobal":true},
            "private":{"id":"private","type":"private","value":8,"isGlobal":true}
        }),
    );
    let backend = Arc::new(MemoryCloudBackend::default());
    let key = CloudKey {
        project: "kncloud".into(),
        variable: "remote".into(),
        user: None,
    };
    backend.store(&key, &json!(999)).unwrap();
    let mut vm = engine(&p, false);
    vm.set_cloud_backend(backend.clone(), "kncloud".into(), "local-user".into())
        .unwrap();
    vm.start();
    assert_eq!(value(&vm, "public"), json!(7.0));
    advance(&mut vm);
    assert_eq!(value(&vm, "public"), json!(42.0));
    assert_eq!(value(&vm, "private"), json!(43.0));
    assert_eq!(backend.load(&key).unwrap(), Some(json!(999)));
    vm.start();
    assert_eq!(value(&vm, "public"), json!(7.0));
    assert_eq!(value(&vm, "private"), json!(8.0));
}
