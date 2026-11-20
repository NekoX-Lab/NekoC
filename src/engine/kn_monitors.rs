//! Exact KN list rows for the expandable monitor panel. The legacy Monitor
//! text and all K4 payloads remain unchanged.
use super::{Cell, Engine, RuntimeSemantics};
use std::collections::BTreeMap;

// Official ListWidget uses module 45578's Qz, not JS array-to-string coercion:
// bracket the row array, abbreviate its child arrays, String() other values.
// See docs/kn-monitor-appearance.md. Keep legacy Monitor.value / K4 unchanged.
fn row_text(value: &Cell) -> String {
    match value {
        Cell::Null => "null".into(),
        Cell::List(items) => {
            let body = items
                .borrow()
                .iter()
                .map(|item| match item {
                    Cell::List(_) => "[...]".into(),
                    _ => row_text(item),
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("[{body}]")
        }
        _ => value.text(),
    }
}

impl Engine {
    pub(super) fn kn_monitor_lists(&self) -> BTreeMap<String, Vec<String>> {
        let mut lists = BTreeMap::new();
        if self.program.semantics != RuntimeSemantics::KnCurrent {
            return lists;
        }
        for (i, visible) in self.monitors.iter().enumerate() {
            if !visible {
                continue;
            }
            let (id, list, target) = &self.program.monitor_targets[i];
            if !list {
                continue;
            }
            let items = if let Some(&(owner, slot)) = self.program.actor_monitors.get(&i) {
                // Match the legacy monitor's declaring original entity, not a
                // clone or a global list slot with the same numeric index.
                let Some(Cell::List(items)) = self.sprites[owner].variables.get(&slot) else {
                    continue;
                };
                items
            } else {
                &self.lists[*target]
            };
            // Preserve empty items and embedded newlines as single rows. The
            // array length is the full live list length, with no 100-item cap.
            lists.insert(id.clone(), items.borrow().iter().map(row_text).collect());
        }
        lists
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc};

    #[test]
    fn row_text_keeps_undefined_null_and_finite_depth_even_for_cycles() {
        assert_eq!(row_text(&Cell::Undefined), "undefined");
        let items = Rc::new(RefCell::new(vec![Cell::Null, Cell::Undefined]));
        assert_eq!(row_text(&Cell::List(items.clone())), "[null,undefined]");
        items.borrow_mut().push(Cell::List(items.clone()));
        assert_eq!(
            row_text(&Cell::List(items.clone())),
            "[null,undefined,[...]]"
        );
        items.borrow_mut().clear();
    }
}
