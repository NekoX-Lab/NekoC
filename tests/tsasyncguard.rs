//! Async syntax must fail before any project/report output, with or without types.
use assert_cmd::Command;
use serde_json::Value;
use std::fs;

#[test]
fn check_and_build_reject_async_syntax_at_original_locations() {
    let dir = tempfile::tempdir().unwrap();
    let cases = [
        "async function f(): Promise<number> { return 7; }\nconsole.log(f());",
        "async function f(): Promise<number> { const x = await 7; return x; }\nconsole.log(f());",
        "const f = async function () { return 7; };",
        "const f = async () => 7;",
        "onStart(async () => { console.log(7); });",
        "setTimeout(async () => { console.log(7); }, 10);",
        "[1].forEach(async x => { console.log(x); });",
        "function outer() { async function unused() { return 7; } return 1; }",
        "const x = await 7; console.log(x);",
    ];
    for (index, body) in cases.iter().enumerate() {
        let source = format!("// original source\n  {body}");
        let column = body.find("async").or_else(|| body.find("await")).unwrap() + 3;
        let input = dir.path().join(format!("case-{index}.ts"));
        fs::write(&input, &source).unwrap();
        for imported in [false, true] {
            let entry = if imported {
                let main = dir.path().join("main.ts");
                fs::write(
                    &main,
                    format!("import {{ value }} from './case-{index}'; console.log(value());"),
                )
                .unwrap();
                fs::write(
                    &input,
                    format!("{source}\nexport function value() {{ return 1; }}"),
                )
                .unwrap();
                main
            } else {
                input.clone()
            };
            for types in [false, true] {
                let mut command = Command::cargo_bin("nekoc").unwrap();
                command.args(["check", "--json"]);
                if !types {
                    command.arg("--no-types");
                }
                let output = command.arg(&entry).output().unwrap();
                assert!(!output.status.success());
                let checked: Value = serde_json::from_slice(&output.stdout).unwrap();
                assert_eq!(checked["ok"], false);
                let diagnostic = checked["diagnostics"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|d| d["source"] == "compat")
                    .unwrap();
                assert_eq!(diagnostic["code"], "NEKOC");
                assert_eq!(diagnostic["line"], 2);
                assert_eq!(diagnostic["column"], column);
                assert_eq!(
                    diagnostic["file"].as_str().unwrap().replace('\\', "/"),
                    input.to_string_lossy().replace('\\', "/")
                );
                let message = diagnostic["message"].as_str().unwrap();
                for text in [
                    "not supported",
                    "remove async/await",
                    "wait(seconds)",
                    "event state machine",
                ] {
                    assert!(message.contains(text), "{checked}");
                }
            }
            let artifact = dir.path().join(format!("case-{index}.bcmkn"));
            let output = Command::cargo_bin("nekoc")
                .unwrap()
                .arg("build")
                .arg(&entry)
                .arg("--out")
                .arg(&artifact)
                .output()
                .unwrap();
            assert!(!output.status.success());
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(
                stderr.contains(&format!(":2:{column}: error NEKOC:")),
                "{stderr}"
            );
            assert!(stderr.contains("remove async/await"), "{stderr}");
            assert!(!stderr.contains("Internal compiler error"), "{stderr}");
            assert!(!artifact.exists());
        }
    }
}
