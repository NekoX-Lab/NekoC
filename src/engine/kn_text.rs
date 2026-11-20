//! Official KN String.toLowerCase / String.toUpperCase code APIs.
//! main.bfc86683.js:2972283 / 2972394: String(CONSTRUCTOR ?? "").
use super::{Cell, Engine, kn_conversion};

impl Engine {
    pub(super) fn eval_kn_text_case(&mut self, value: Cell, upper: bool) -> Cell {
        let text = if matches!(value, Cell::Null | Cell::Undefined) {
            String::new()
        } else {
            match kn_conversion::js_string(&value) {
                Ok(text) => text,
                Err(error) => {
                    self.value_error.get_or_insert_with(|| error.into());
                    return Cell::Undefined;
                }
            }
        };
        // Full Unicode mapping, including expansions (ß -> SS / İ -> i̇)
        // and context-sensitive final sigma; never ASCII-only or locale-aware.
        Cell::Text(
            if upper {
                text.to_uppercase()
            } else {
                text.to_lowercase()
            }
            .into(),
        )
    }
}
