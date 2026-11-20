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
