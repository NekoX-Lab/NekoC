//! K4 edge reflection against the pinned offline player's original probes.
use nekoc::{
    engine::{Costume, Engine, Program},
    kitten4,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, time::Duration};

#[test]
fn edge_reflection_matches_official_points_corners_pivots_and_physics_speed() {
    let text = fs::read_to_string("tests/fixtures/kitten4/r3-physics.json")
        .unwrap()
        .replace("\r\n", "\n");
    let probes: Value = serde_json::from_str(&text).unwrap();
    let evidence: Value =
        serde_json::from_slice(&fs::read("docs/kitten4-r3-physics-evidence.json").unwrap())
            .unwrap();
    assert_eq!(evidence["sha256"], format!("{:x}", Sha256::digest(&text)));
    assert!(
        evidence["assets"].as_array().unwrap().iter().any(|asset| {
            asset["sha256"] == "6ed56cf80a197b1dad00403ef2d55f9f4c357cb000cc52b5b0ba32c3989730d6"
        }),
        "the evidence must load the real official physics module"
    );
    assert_eq!(
        probes["cases"].as_object().unwrap().len(),
        evidence["cases"].as_object().unwrap().len()
    );
    let actor_id = probes["actorId"].as_str().unwrap();
    for (name, spec) in probes["cases"].as_object().unwrap() {
        let mut source = probes["template"].clone();
        let actor = source["theatre"]["actors"][actor_id]
            .as_object_mut()
            .unwrap();
        actor.extend(spec["actor"].as_object().unwrap().clone());
        if let Some(workspace) = spec.get("workspace") {
            actor.insert("block_data_json".into(), workspace.clone());
        }
        source["theatre"]["styles"]["probe-style"] = spec["style"].clone();
        let canonical = kitten4::to_neko(&source).unwrap();
        let texture: Vec<usize> = spec["texture"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_u64().unwrap() as usize)
            .collect();
        let (width, height) = (texture[0], texture[1]);
        let mut bits = vec![0u8; (width * height).div_ceil(8)];
        for y in texture[3]..texture[3] + texture[5] {
            for x in texture[2]..texture[2] + texture[4] {
                let bit = y * width + x;
                bits[bit / 8] |= 1 << (bit % 8);
            }
        }
        let case = &evidence["cases"][name];
        assert_eq!(case["errors"], serde_json::json!([]), "{name}");
        assert_eq!(case["pageErrors"], serde_json::json!([]), "{name}");
        for interpreted in [false, true] {
            let mut engine = Engine::new(Program::compile(&canonical).unwrap());
            engine.set_costume(
                "probe-style",
                Costume {
                    width: width as f64,
                    height: height as f64,
                    center_point: Costume::center_point_from_json(&spec["style"]["pivot"]),
                    mask: Some((width, height, bits.clone())),
                    ..Default::default()
                },
            );
            if interpreted {
                engine.disable_jit();
            }
            engine.use_virtual_clock();
            engine.start();
            for expected in case["frames"].as_array().unwrap() {
                let frame = expected["frame"].as_u64().unwrap() as u32;
                engine
                    .advance(1.0 / 60.0, 100_000, Duration::from_secs(2))
                    .unwrap();
                let actual = engine.oracle_snapshot(frame);
                for key in ["x", "y", "rotation"] {
                    let got = actual["actors"][actor_id][key].as_f64().unwrap();
                    let want = expected["actor"][key].as_f64().unwrap();
                    assert!(
                        (got - want).abs() < 1e-8,
                        "{name} interpreted={interpreted} frame={frame} {key}: {got} != {want}"
                    );
                }
                for key in ["speed", "speed_dir"] {
                    assert_eq!(
                        actual["variables"][key].as_f64(),
                        expected["variables"][key].as_f64(),
                        "{name}/{key}"
                    );
                }
            }
        }
    }
}

#[test]
fn actor_collisions_match_official_sample_threshold_stage_and_scene_rules() {
    let text = fs::read_to_string("tests/fixtures/kitten4/r3-collision.json")
        .unwrap()
        .replace("\r\n", "\n");
    let probes: Value = serde_json::from_str(&text).unwrap();
    let evidence: Value =
        serde_json::from_slice(&fs::read("docs/kitten4-r3-collision-evidence.json").unwrap())
            .unwrap();
    assert_eq!(evidence["sha256"], format!("{:x}", Sha256::digest(&text)));
    assert_eq!(evidence["errors"], serde_json::json!([]));
    assert_eq!(evidence["pageErrors"], serde_json::json!([]));
    assert_eq!(
        probes["cases"].as_object().unwrap().len(),
        evidence["cases"].as_object().unwrap().len()
    );
    let actor_id = probes["actorId"].as_str().unwrap();
    let other_id = probes["floorId"].as_str().unwrap();
    for (name, spec) in probes["cases"].as_object().unwrap() {
        let mut source = probes["template"].clone();
        let mut other = source["theatre"]["actors"][actor_id].clone();
        source["theatre"]["actors"][actor_id]
            .as_object_mut()
            .unwrap()
            .extend(spec["a"].as_object().unwrap().clone());
        other["id"] = other_id.into();
        other["block_data_json"] =
            serde_json::json!({ "blocks": {}, "connections": {}, "comments": {} });
        other
            .as_object_mut()
            .unwrap()
            .extend(spec["other"].as_object().unwrap().clone());
        let scene = source["theatre"]["actors"][actor_id]["scene"]
            .as_str()
            .unwrap()
            .to_owned();
        if other["scene"] != scene {
            let id = other["scene"].as_str().unwrap().to_owned();
            source["theatre"]["scenes"][&id] = source["theatre"]["scenes"][&scene].clone();
            source["theatre"]["scenes"][&id]["id"] = id.clone().into();
            source["theatre"]["scenes"][&id]["actors"] = serde_json::json!([other_id]);
            source["theatre"]["scenes"][&id]["group_order"] = serde_json::json!(["other-group"]);
            source["theatre"]["groups"]["other-group"] =
                source["theatre"]["groups"]["group"].clone();
            source["theatre"]["groups"]["other-group"]["id"] = "other-group".into();
            source["theatre"]["groups"]["other-group"]["scene"] = id.clone().into();
            source["theatre"]["groups"]["other-group"]["actors"] = serde_json::json!([other_id]);
            source["theatre"]["scenes_order"]
                .as_array_mut()
                .unwrap()
                .push(id.into());
        } else {
            source["theatre"]["scenes"][&scene]["actors"]
                .as_array_mut()
                .unwrap()
                .push(other_id.into());
            source["theatre"]["groups"]["group"]["actors"]
                .as_array_mut()
                .unwrap()
                .push(other_id.into());
        }
        source["theatre"]["actors"][other_id] = other;
        let width = spec["texture"][0].as_u64().unwrap() as usize;
        let height = spec["texture"][1].as_u64().unwrap() as usize;
        source["theatre"]["styles"]["probe-style"]["width"] = width.into();
        source["theatre"]["styles"]["probe-style"]["height"] = height.into();
        let canonical = kitten4::to_neko(&source).unwrap();
        for interpreted in [false, true] {
            let mut engine = Engine::new(Program::compile(&canonical).unwrap());
            engine.set_costume(
                "probe-style",
                Costume {
                    width: width as f64,
                    height: height as f64,
                    mask: Some((width, height, vec![255; (width * height).div_ceil(8)])),
                    ..Default::default()
                },
            );
            if interpreted {
                engine.disable_jit();
            }
            engine.use_virtual_clock();
            engine.start();
            engine
                .advance(1.0 / 60.0, 100_000, Duration::from_secs(2))
                .unwrap();
            let actual = engine.oracle_snapshot(1);
            for key in ["before", "after"] {
                let got = actual["variables"][key]
                    .as_bool()
                    .or_else(|| actual["variables"][key].as_f64().map(|n| n != 0.0));
                assert_eq!(
                    got,
                    evidence["cases"][name][key].as_bool(),
                    "{name} interpreted={interpreted} {key}: {} != {}",
                    actual["variables"][key],
                    evidence["cases"][name][key]
                );
            }
        }
    }
}
