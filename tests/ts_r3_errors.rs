//! The native CLI must preserve the frontend diagnostic JSON and text.
use assert_cmd::Command;
use serde_json::Value;
use std::fs;

#[test]
fn native_check_preserves_frontend_diagnostics_and_text() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("main.ts");
    let frontend = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("ts/compile-ts.mjs");
    for source in [
        "// heading\nonStart(() => {\n  let n: number = \"bad\";\n  new WeakMap();\n});\n",
        "// heading\r\nlet a = ;\r\nlet b = ;\r\n",
        "onStart(() => {\n\tconsole.log(\"猫😀\"); missingApi();\n});",
    ] {
        fs::write(&input, source).unwrap();
        for types in [true, false] {
            let flags = if types { vec![] } else { vec!["--no-types"] };
            let js_json = std::process::Command::new("node")
                .arg(&frontend)
                .args(["--check", "--json"])
                .args(&flags)
                .arg(&input)
                .output()
                .unwrap();
            let native_json = Command::cargo_bin("nekoc")
                .unwrap()
                .args(["check", "--json"])
                .args(&flags)
                .arg(&input)
                .output()
                .unwrap();
            assert_eq!(js_json.status.code(), Some(1));
            assert_eq!(native_json.status.code(), Some(1));
            assert!(native_json.stderr.is_empty());
            let expected: Value = serde_json::from_slice(&js_json.stdout).unwrap();
            let actual: Value = serde_json::from_slice(&native_json.stdout).unwrap();
            assert_eq!(actual, expected);
            for d in actual["diagnostics"].as_array().unwrap() {
                assert!(d["snippet"].is_string(), "{d}");
                assert!(!d["suggestion"].as_str().unwrap().is_empty());
            }
            let js_text = std::process::Command::new("node")
                .arg(&frontend)
                .arg("--check")
                .args(&flags)
                .arg(&input)
                .output()
                .unwrap();
            let native_text = Command::cargo_bin("nekoc")
                .unwrap()
                .arg("check")
                .args(&flags)
                .arg(&input)
                .output()
                .unwrap();
            assert_eq!(native_text.status.code(), Some(1));
            assert_eq!(js_text.status.code(), Some(1));
            assert!(native_text.stdout.is_empty());
            assert_eq!(native_text.stderr, js_text.stderr);
        }
    }
}

#[test]
fn assembly_diagnostics_include_source_and_guidance() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("main.ts");
    let source = "onStart(() => {\n  rotateAround(\"missing\", 45);\n});";
    fs::write(&input, source).unwrap();
    let report = nekoc::check::check_file(&input, &Default::default()).unwrap();
    assert!(!report.ok);
    let diagnostic = report
        .diagnostics
        .iter()
        .find(|d| d.code == "invalid_actor_menu_target")
        .unwrap();
    assert_eq!(diagnostic.line, Some(2));
    assert_eq!(diagnostic.column, Some(3));
    assert_eq!(diagnostic.snippet.as_deref(), source.lines().nth(1));
    assert!(diagnostic.suggestion.contains("sprite"));
    assert!(diagnostic.to_string().contains("help:"));
    for optimize in [false, true] {
        let output = dir.path().join("out.bcmkn");
        let mut command = Command::cargo_bin("nekoc").unwrap();
        command.arg("build").arg(&input).arg("--out").arg(&output);
        if optimize {
            command.arg("--optimize");
        }
        let result = command.output().unwrap();
        assert_eq!(result.status.code(), Some(1));
        assert!(result.stdout.is_empty());
        let stderr = String::from_utf8(result.stderr).unwrap();
        assert!(stderr.contains(&diagnostic.to_string()), "{stderr}");
        assert!(stderr.contains("[compat]"), "{stderr}");
        assert!(
            stderr.contains("  2 |   rotateAround(\"missing\", 45);\n    |   ^"),
            "{stderr}"
        );
        assert!(stderr.contains("\n  help: "), "{stderr}");
        assert!(!output.exists());
    }
}
