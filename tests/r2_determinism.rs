use assert_cmd::Command;
use serde_json::Value;
use std::fs;
use std::path::Path;

fn build(cwd: &Path, input: &Path, output: &Path, optimized: bool) -> Vec<u8> {
    let mut command = Command::cargo_bin("nekoc").unwrap();
    command
        .current_dir(cwd)
        .arg("build")
        .arg(input)
        .arg("-o")
        .arg(output);
    if optimized {
        command.arg("--optimize");
    }
    command.assert().success();
    let bytes = fs::read(output).unwrap();
    let project = nekoc::json::from_slice(&bytes).unwrap();
    assert_eq!(nekoc::validate::build_report(&project).unwrap()["ok"], true);
    bytes
}

fn assert_same(first: &[u8], second: &[u8]) {
    let a = nekoc::json::from_slice(first).unwrap();
    let b = nekoc::json::from_slice(second).unwrap();
    assert!(a == b, "compiled project structures differ");
    assert!(
        first == second,
        "equal structures must serialize to identical bytes"
    );
}

#[test]
fn examples_build_to_identical_bytes_across_processes_and_directories() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("alice/project");
    let second = dir.path().join("机器 B/deeper/project");
    fs::create_dir_all(&first).unwrap();
    fs::create_dir_all(&second).unwrap();
    for relative in [
        "samples/block_let.ts",
        "samples/custom_procedures.ts",
        "samples/multi_screen.ts",
        "tests/fixtures/r2-determinism.ts",
    ] {
        let sample = Path::new(relative).file_name().unwrap();
        let source = fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)).unwrap();
        fs::write(first.join(sample), &source).unwrap();
        fs::write(second.join(sample), &source).unwrap();
        for optimized in [false, true] {
            let a = build(
                &first,
                Path::new(sample),
                &first.join("first.bcmkn"),
                optimized,
            );
            let repeat = build(
                &first,
                Path::new(sample),
                &first.join("repeat.bcmkn"),
                optimized,
            );
            let moved = build(
                &second,
                &second.join(sample),
                &second.join("elsewhere.bcmkn"),
                optimized,
            );
            assert_same(&a, &repeat);
            assert_same(&a, &moved);
        }
    }
}

#[test]
fn imported_same_basename_modules_remain_distinct_after_relocation() {
    let dir = tempfile::tempdir().unwrap();
    let mut artifacts = Vec::new();
    for directory in ["first", "another/deeper"] {
        let root = dir.path().join(directory);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("left")).unwrap();
        fs::create_dir_all(root.join("right")).unwrap();
        fs::write(
            root.join("src/main.ts"),
            r#"import { left } from "../left/util";
import { right } from "../right/util";
onStart(() => { console.log(left(2), right(4)); });
"#,
        )
        .unwrap();
        fs::write(root.join("left/util.ts"), "export function left(n: number) { const {value} = {value: n}; let bound = 0, saved = value; [bound, saved] = [saved, bound]; let total = 0; for (let i = 0; i < bound; i++) total += i; return total; }").unwrap();
        fs::write(root.join("right/util.ts"), "export function right(n: number) { const {value} = {value: n}; let bound = 0, saved = value; [bound, saved] = [saved, bound]; let total = 1; for (let i = 0; i < bound; i++) total *= 3; return total; }").unwrap();
        let output = root.join("result.bcmkn");
        artifacts.push(build(&root, Path::new("src/main.ts"), &output, false));
        let run = Command::cargo_bin("nekoc")
            .unwrap()
            .args(["run", "--ticks", "10"])
            .arg(&output)
            .output()
            .unwrap();
        assert!(
            run.status.success(),
            "{}",
            String::from_utf8_lossy(&run.stderr)
        );
        let run: Value = serde_json::from_slice(&run.stdout).unwrap();
        assert_eq!(run["logs"], serde_json::json!(["1 81"]));
    }
    assert_same(&artifacts[0], &artifacts[1]);
}

#[test]
fn runtime_source_maps_are_portable_and_keep_distinct_import_origins() {
    let dir = tempfile::tempdir().unwrap();
    let mut artifacts = Vec::new();
    for directory in ["alice/project", "机器 B/deeper/project"] {
        let root = dir.path().join(directory);
        for child in ["src", "left", "right"] {
            fs::create_dir_all(root.join(child)).unwrap();
        }
        fs::write(root.join("src/main.ts"), "import { left } from '../left/util';\nimport { right } from '../right/util';\nonStart(() => { left(); right(); setStyle(99); });").unwrap();
        fs::write(
            root.join("left/util.ts"),
            "export function left() {\n  setStyle(97);\n}",
        )
        .unwrap();
        fs::write(
            root.join("right/util.ts"),
            "export function right() {\n\n  setStyle(98);\n}",
        )
        .unwrap();
        for optimized in [false, true] {
            let output = root.join("result.bcmkn");
            let bytes = build(&root, &root.join("src/main.ts"), &output, optimized);
            let project: Value = serde_json::from_slice(&bytes).unwrap();
            let locations = project["sourceMap"].as_object().unwrap();
            let files: std::collections::BTreeSet<_> = locations
                .values()
                .map(|l| l["file"].as_str().unwrap())
                .collect();
            assert_eq!(
                files,
                ["../left/util.ts", "../right/util.ts", "main.ts"].into()
            );
            assert!(
                locations.values().any(
                    |l| l == &serde_json::json!({"file":"../left/util.ts","line":2,"column":3})
                )
            );
            assert!(
                locations
                    .values()
                    .any(|l| l
                        == &serde_json::json!({"file":"../right/util.ts","line":3,"column":3}))
            );
            let run = Command::cargo_bin("nekoc")
                .unwrap()
                .args(["run", "--ticks", "2"])
                .arg(&output)
                .output()
                .unwrap();
            assert!(!run.status.success());
            let error = String::from_utf8(run.stderr).unwrap();
            assert!(error.contains("../left/util.ts:2:3] at block "), "{error}");
            assert!(!error.contains(root.to_str().unwrap()), "{error}");
            artifacts.push(bytes);
        }
    }
    assert_same(&artifacts[0], &artifacts[2]);
    assert_same(&artifacts[1], &artifacts[3]);
}
