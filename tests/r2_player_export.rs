use assert_cmd::Command;
use predicates::prelude::PredicateBooleanExt;
use predicates::str::contains;
use std::fs;

#[test]
fn export_player_help_explains_offline_outputs() {
    Command::cargo_bin("nekoc")
        .unwrap()
        .args(["export-player", "--help"])
        .assert()
        .success()
        .stdout(contains("no server needed").and(contains("--wasm-dir")));
}

#[test]
fn export_player_rejects_existing_output_without_touching_it() {
    let dir = tempfile::tempdir().unwrap();
    let output = dir.path().join("keep.zip");
    fs::write(&output, b"keep me").unwrap();
    Command::cargo_bin("nekoc")
        .unwrap()
        .args(["export-player", "missing.bcmkn", "--out"])
        .arg(&output)
        .assert()
        .failure()
        .stderr(contains("output already exists"));
    assert_eq!(fs::read(output).unwrap(), b"keep me");
}

#[test]
fn export_player_rejects_invalid_work_before_starting_packager() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("invalid.bcmkn");
    let output = dir.path().join("player");
    fs::write(&input, b"{}").unwrap();
    Command::cargo_bin("nekoc")
        .unwrap()
        .arg("export-player")
        .arg(&input)
        .arg("--out")
        .arg(&output)
        .assert()
        .failure()
        .stderr(contains("project requires object"));
    assert!(!output.exists());
}

#[test]
fn export_player_keeps_edits_to_canonical_kitten4_projects() {
    let dir = tempfile::tempdir().unwrap();
    let source = nekoc::project::load_project("tests/fixtures/kitten4/visual-stamp.bcm").unwrap();
    let (mut canonical, _) = nekoc::player::import(source.value).unwrap();
    canonical["projectName"] = serde_json::json!("Edited offline title");
    let input = dir.path().join("edited.json");
    fs::write(&input, nekoc::json::to_vec(&canonical).unwrap()).unwrap();
    let wasm = dir.path().join("wasm");
    fs::create_dir(&wasm).unwrap();
    fs::write(
        wasm.join("nekoc_wasm_bg.wasm"),
        [0, 97, 115, 109, 1, 0, 0, 0],
    )
    .unwrap();
    fs::write(wasm.join("nekoc_wasm.js"), "export default async function init(){}; export const importProject=text=>JSON.stringify({project:JSON.parse(text),report:{fast_runtime_ready:true}}); export function checkExtensions(){}; export class Player{ready(){return JSON.stringify({ready:true});}free(){}}").unwrap();
    let output = dir.path().join("player");
    Command::cargo_bin("nekoc")
        .unwrap()
        .arg("export-player")
        .arg(&input)
        .arg("--out")
        .arg(&output)
        .arg("--wasm-dir")
        .arg(&wasm)
        .assert()
        .success();
    let script = fs::read_to_string(output.join("project.js")).unwrap();
    let text: String = serde_json::from_str(
        script
            .strip_prefix("globalThis.nekoExportProject=JSON.parse(")
            .unwrap()
            .trim_end()
            .trim_end_matches(");"),
    )
    .unwrap();
    let project: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(project["project_name"], "Edited offline title");
    assert!(
        project["theatre"]["styles"]["background"]["url"]
            .as_str()
            .unwrap()
            .starts_with("data:")
    );
}
