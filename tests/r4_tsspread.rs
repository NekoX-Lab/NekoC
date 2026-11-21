//! Unsupported TS spread/rest must never assemble a silently incorrect work.
use assert_cmd::Command;
use serde_json::Value;
use std::fs;

#[test]
fn spread_and_rest_fail_check_and_build_at_original_locations() {
    let dir = tempfile::tempdir().unwrap();
    let cases = [
        ("const a = [1, 2]; const b = [...a, 4];", "Array spread"),
        ("const a = {x: 1}; const b = {...a};", "Object spread"),
        (
            "function sum(...a: number[]) { return a.length; } console.log(sum(1, 2));",
            "Rest parameters",
        ),
        (
            "function f(a = 7, b = 8) { return a + b; } console.log(f(...[undefined, 2]));",
            "Spread arguments",
        ),
        (
            "function f(a = 7) { return a; } console.log(f(...[]));",
            "Spread arguments",
        ),
        (
            "function f(a = 7, ...tail: number[]) { return a + tail.length; }",
            "Rest parameters",
        ),
    ];
    for (index, (body, context)) in cases.iter().enumerate() {
        let input = dir.path().join(format!("spread-{index}.ts"));
        fs::write(&input, format!("// original source\n  {body}")).unwrap();
        let column = body.find("...").unwrap() + 3;
        for types in [false, true] {
            let mut command = Command::cargo_bin("nekoc").unwrap();
            command.args(["check", "--json"]);
            if !types {
                command.arg("--no-types");
            }
            let output = command.arg(&input).output().unwrap();
            assert!(!output.status.success());
            let checked: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(checked["ok"], false);
            let diagnostic = checked["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["source"] == "compat")
                .unwrap();
            assert_eq!(diagnostic["code"], "NEKOC");
            assert_eq!(diagnostic["line"], 2);
            assert_eq!(diagnostic["column"], column);
            let message = diagnostic["message"].as_str().unwrap();
            assert!(message.starts_with(context), "{checked}");
            assert!(message.contains("not supported"), "{checked}");
            assert!(diagnostic["suggestion"].as_str().unwrap().len() > 10);
        }
        let artifact = dir.path().join(format!("spread-{index}.bcmkn"));
        let output = Command::cargo_bin("nekoc")
            .unwrap()
            .arg("build")
            .arg(&input)
            .arg("--out")
            .arg(&artifact)
            .output()
            .unwrap();
        assert!(!output.status.success());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains(context), "{stderr}");
        assert!(
            stderr.contains(&format!(":2:{column}: error NEKOC:")),
            "{stderr}"
        );
        assert!(!stderr.contains("Internal compiler error"), "{stderr}");
        assert!(!artifact.exists());
    }
}
