use assert_cmd::Command;
use predicates::prelude::PredicateBooleanExt;
use predicates::str::contains;
use serde_json::Value;
use std::fs;

fn json_report(output: std::process::Output, code: i32) -> Value {
    assert_eq!(output.status.code(), Some(code), "{output:?}");
    assert!(output.stderr.is_empty(), "{output:?}");
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["ok"], code == 0, "{report}");
    assert_eq!(report["command"], "export-player");
    report
}

#[test]
fn export_player_help_explains_offline_outputs() {
    Command::cargo_bin("nekoc")
        .unwrap()
        .args(["export-player", "--help"])
        .assert()
        .success()
        .stdout(contains("无需服务器").and(contains("--wasm-dir")));
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

#[test]
fn export_player_json_wraps_real_directory_and_zip_exports_and_packager_failures() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("有 空格.json");
    fs::write(&input, nekoc::bcmkn_compiler::DEFAULT_TEMPLATE).unwrap();
    let wasm = dir.path().join("wasm");
    fs::create_dir(&wasm).unwrap();
    fs::write(
        wasm.join("nekoc_wasm_bg.wasm"),
        [0, 97, 115, 109, 1, 0, 0, 0],
    )
    .unwrap();
    fs::write(wasm.join("nekoc_wasm.js"), "export default async function init(){}; export const importProject=text=>JSON.stringify({project:JSON.parse(text),report:{fast_runtime_ready:true}}); export function checkExtensions(){}; export class Player{ready(){return JSON.stringify({ready:true});}free(){}}").unwrap();
    for (name, json_first) in [("新 目录/player", true), ("player.zip", false)] {
        let out = dir.path().join(name);
        let mut command = Command::cargo_bin("nekoc").unwrap();
        if json_first {
            command.arg("--json");
        }
        command
            .arg("export-player")
            .arg(&input)
            .arg("--out")
            .arg(&out)
            .arg("--wasm-dir")
            .arg(&wasm);
        if !json_first {
            command.arg("--json");
        }
        let report = json_report(command.output().unwrap(), 0);
        assert_eq!(report["result"]["out"], out.to_str().unwrap());
        assert!(
            report["result"]["stdout"]
                .as_str()
                .unwrap()
                .contains("播放器已导出")
        );
        if name.ends_with(".zip") {
            assert!(fs::read(&out).unwrap().starts_with(b"PK"));
        } else {
            assert!(out.join("index.html").is_file());
            let manifest: Value =
                serde_json::from_slice(&fs::read(out.join("manifest.json")).unwrap()).unwrap();
            assert_eq!(manifest["format"], "nekoc-player-export-v1");
        }
        let report = json_report(
            Command::cargo_bin("nekoc")
                .unwrap()
                .arg("export-player")
                .arg(&input)
                .arg("--out")
                .arg(&out)
                .arg("--json")
                .output()
                .unwrap(),
            1,
        );
        assert!(
            report["error"]["message"]
                .as_str()
                .unwrap()
                .contains("output already exists")
        );
        assert!(report["error"]["hint"].as_str().unwrap().contains("--out"));
    }
    let out = dir.path().join("bad-player");
    let report = json_report(
        Command::cargo_bin("nekoc")
            .unwrap()
            .arg("export-player")
            .arg(&input)
            .arg("--out")
            .arg(&out)
            .arg("--wasm-dir")
            .arg(dir.path().join("missing wasm"))
            .arg("--json")
            .output()
            .unwrap(),
        1,
    );
    assert!(
        report["result"]["stderr"]
            .as_str()
            .unwrap()
            .contains("导出失败")
    );
    assert!(
        report["error"]["hint"]
            .as_str()
            .unwrap()
            .contains("--wasm-dir")
    );
    assert!(!out.exists());
}

#[test]
fn export_player_json_preserves_stdin_and_captures_both_child_streams() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("project.json");
    let packager = dir.path().join("packager.cjs");
    fs::write(&input, nekoc::bcmkn_compiler::DEFAULT_TEMPLATE).unwrap();
    fs::write(&packager, "const fs=require('node:fs'); const input=process.argv[process.argv.indexOf('--input')+1]; JSON.parse(fs.readFileSync(input,'utf8')); console.log('input:'+fs.readFileSync(0,'utf8')); console.error('packager diagnostic'); process.exitCode=1;").unwrap();
    let report = json_report(
        Command::cargo_bin("nekoc")
            .unwrap()
            .env("NEKOC_PLAYER_EXPORT", &packager)
            .arg("export-player")
            .arg(&input)
            .arg("--out")
            .arg(dir.path().join("player"))
            .arg("--json")
            .write_stdin("stdin token")
            .output()
            .unwrap(),
        1,
    );
    assert_eq!(report["result"]["stdout"], "input:stdin token\n");
    assert_eq!(report["result"]["stderr"], "packager diagnostic\n");
    let report = json_report(
        Command::cargo_bin("nekoc")
            .unwrap()
            .env("PATH", dir.path())
            .env("NEKOC_PLAYER_EXPORT", &packager)
            .arg("export-player")
            .arg(&input)
            .arg("--out")
            .arg(dir.path().join("player"))
            .arg("--json")
            .output()
            .unwrap(),
        1,
    );
    assert_eq!(report["error"]["kind"], "node_unavailable");
    assert!(
        report["error"]["hint"]
            .as_str()
            .unwrap()
            .contains("Node.js 22")
    );
}
