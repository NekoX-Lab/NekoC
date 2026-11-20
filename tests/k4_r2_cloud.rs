//! Account 401 does not imply read-only local cloud state in the fixed K4 player.
use nekoc::{
    cloud::{CloudBackend, CloudKey, MemoryCloudBackend},
    engine::{Engine, Program},
    kitten4,
};
use serde_json::Value;
use std::{sync::Arc, time::Duration};

fn engine(fixture: &str, interpreter: bool) -> Engine {
    let text = std::fs::read_to_string(format!("tests/fixtures/kitten4/{fixture}")).unwrap();
    let source = nekoc::json::from_str(&text).unwrap();
    let mut vm = Engine::new(Program::compile(&kitten4::to_neko(&source).unwrap()).unwrap());
    vm.use_virtual_clock();
    if interpreter {
        vm.disable_jit();
    }
    vm
}

fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
        }
        _ => a == b,
    }
}

#[test]
fn anonymous_replace_matches_account_401_official_observations() {
    let evidence: Value =
        serde_json::from_str(include_str!("../docs/kitten4-r2-cloud-evidence.json")).unwrap();
    for case in evidence["cases"].as_array().unwrap() {
        if !case["id"]
            .as_str()
            .unwrap()
            .starts_with("anonymous-401-list")
        {
            continue;
        }
        assert_eq!(case["account401Observed"], true);
        assert_eq!(case["anonymousThroughout"], true);
        for interpreter in [false, true] {
            let mut vm = engine(case["fixture"].as_str().unwrap(), interpreter);
            vm.start();
            for frame in 1..=case["frames"].as_u64().unwrap() {
                vm.advance(1.0 / 60.0, 100_000, Duration::from_secs(5))
                    .unwrap();
                for replacement in case["replacements"].as_array().unwrap() {
                    if replacement["frame"].as_u64() == Some(frame) {
                        assert_eq!(replacement["socketConnectedAfterFrame"], false);
                        let actual = vm.oracle_snapshot(frame as u32);
                        assert!(
                            same(&actual["variables"]["items"], &replacement["after"]),
                            "{} frame={frame} interpreter={interpreter}",
                            case["id"]
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn local_cloud_backend_stays_an_explicit_persistent_option() {
    for interpreter in [false, true] {
        let backend = Arc::new(MemoryCloudBackend::default());
        let key = CloudKey {
            project: "r2".into(),
            variable: "local-shared".into(),
            user: None,
        };
        let mut anonymous = engine("cloud-writes.bcm", interpreter);
        anonymous.start();
        anonymous
            .advance(1.0 / 60.0, 100_000, Duration::from_secs(5))
            .unwrap();
        assert_eq!(anonymous.variable_text("shared"), "room/message");
        assert!(backend.load(&key).unwrap().is_none());
        let mut attached = engine("cloud-writes.bcm", interpreter);
        attached
            .set_cloud_backend(backend.clone(), "r2".into(), "local-user".into())
            .unwrap();
        attached.start();
        attached
            .advance(1.0 / 60.0, 100_000, Duration::from_secs(5))
            .unwrap();
        assert_eq!(backend.load(&key).unwrap(), Some("room/message".into()));
        let fresh = engine("cloud-defaults.bcm", interpreter);
        assert_eq!(fresh.variable_text("shared"), "0");
    }
}
