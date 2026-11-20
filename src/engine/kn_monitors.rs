//! Exact KN list rows for the expandable monitor panel. The legacy Monitor
//! text and all K4 payloads remain unchanged.
use super::{Cell, Engine, RuntimeSemantics};
use std::collections::BTreeMap;

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
            lists.insert(id.clone(), items.borrow().iter().map(Cell::text).collect());
        }
        lists
    }
}
