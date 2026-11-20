//! Brush rules shared by native KN and K4 (official evidence: docs/r3-knpen.md
//! and docs/kitten4-partial-pen-3.md). No third-party runtime code is embedded.
use super::Engine;

impl Engine {
    /// Both official brushes test stored coordinates for JS truthiness. With
    /// either coordinate zero a repeated pen-down draws another dot; away from
    /// the axes it is idempotent. A down brush's stored origin is its position.
    pub(super) fn canvas_pen_down_draws(&self, actor: usize) -> bool {
        let a = &self.sprites[actor];
        !a.pen || a.x == 0.0 || a.y == 0.0 || a.x.is_nan() || a.y.is_nan()
    }

    /// Origin disk, then closed two-point stroke; each composites independently.
    /// A zero-length Canvas stroke is empty. The sensing raster remains
    /// pixel-centre (not AA) based, matching its existing sampling policy.
    pub(super) fn raster_canvas_line(
        &mut self,
        from: (f64, f64),
        to: (f64, f64),
        size: f64,
        color: [f32; 4],
    ) {
        self.raster_line(from, from, size, color);
        if from != to {
            self.raster_line(from, to, size, color);
        }
    }
}
