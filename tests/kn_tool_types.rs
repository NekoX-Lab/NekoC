//! Published KN works carry the edition in `toolType`. Two PICKCAT works use
//! TANYUE_KN; the official editor enum also has GUYU_KN and EXAM_KN, and the
//! official player at kn.codemao.cn/player opens all of them.
use nekoc::{bcmkn, player, studio::document::Document};
use serde_json::Value;

fn project(tool: &str) -> Value {
    let mut project = Document::blank().value().clone();
    project["toolType"] = tool.into();
    project
}

#[test]
fn every_official_kn_edition_opens_in_the_player_and_importer() {
    for tool in ["KN", "TANYUE_KN", "GUYU_KN", "EXAM_KN"] {
        let project = project(tool);
        player::check_project_shape(&project).unwrap_or_else(|e| panic!("{tool}: {e}"));
        bcmkn::import(project).unwrap_or_else(|e| panic!("{tool}: {e}"));
    }
}

#[test]
fn other_tool_types_are_still_rejected() {
    for tool in ["KITTEN4", "KN2", "kn", ""] {
        assert!(
            player::check_project_shape(&project(tool)).is_err(),
            "{tool}"
        );
        assert!(bcmkn::import(project(tool)).is_err(), "{tool}");
    }
}
