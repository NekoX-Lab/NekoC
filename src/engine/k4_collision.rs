//! K4 pixel collisions and edge reflection. Independent implementation;
//! source locations, original probes and limits: docs/kitten4-r3-physics.md.
use super::{CostumeGeometry, Engine};

fn alpha_at(geometry: &CostumeGeometry<'_>, x: f64, y: f64) -> bool {
    let Some((u, v)) = geometry.uv(x, y) else {
        return false;
    };
    let costume = geometry.costume;
    // Actor.is_touching rounds the original texture coordinate before JfQ3/u
    // floors it onto the reduced alpha buffer. JS Math.round ties toward +inf.
    let px = ((u * costume.width + 0.5).floor() * 0.7).floor();
    let py = ((v * costume.height + 0.5).floor() * 0.7).floor();
    let (w, h) = (
        (costume.width * 0.7).floor(),
        (costume.height * 0.7).floor(),
    );
    if ![px, py, w, h].iter().all(|n| n.is_finite()) || px < 0.0 || py < 0.0 || px >= w || py >= h {
        return false;
    }
    let Some((mw, mh, bits)) = &costume.mask else {
        return true;
    };
    let mx = ((px + 0.5) * *mw as f64 / w) as usize;
    let my = ((py + 0.5) * *mh as f64 / h) as usize;
    let bit = my.saturating_mul(*mw).saturating_add(mx);
    bits.get(bit / 8)
        .is_some_and(|byte| byte & (1 << (bit % 8)) != 0)
}

impl Engine {
    pub(super) fn k4_overlap(&self, a: usize, b: usize) -> bool {
        let (left, right) = (&self.sprites[a], &self.sprites[b]);
        if !left.alive
            || !right.alive
            || !left.visible
            || !right.visible
            || left.scene != right.scene
        {
            return false;
        }
        let (Some(a), Some(b)) = (self.k4_collision_geometry(a), self.k4_collision_geometry(b))
        else {
            return false;
        };
        let (al, ar, ab, at) = a.bounds();
        let (bl, br, bb, bt) = b.bounds();
        let (hw, hh) = (self.program.width / 2.0, self.program.height / 2.0);
        let offstage =
            |l: f64, r: f64, bottom: f64, t: f64| r <= -hw || l >= hw || t <= -hh || bottom >= hh;
        if offstage(al, ar, ab, at) || offstage(bl, br, bb, bt) {
            return false;
        }
        let (l, r, bottom, t) = (al.max(bl), ar.min(br), ab.max(bb), at.min(bt));
        if ![l, r, bottom, t].iter().all(|n| n.is_finite()) || l >= r || bottom >= t {
            return false;
        }
        // As with other VM pixel queries, bound hostile giant transparent
        // textures. Such inputs are outside the verified collision profile.
        if ((r - l) / 2.0).ceil() * ((t - bottom) / 2.0).ceil() > 1_000_000.0 {
            return false;
        }
        let tiny = (a.width * a.height).abs() < 10.0 || (b.width * b.height).abs() < 10.0;
        let mut hits = 0;
        let mut x = (l + 0.5).floor();
        while x < (r + 0.5).floor() {
            let mut y = (t + 0.5).floor();
            while y > (bottom + 0.5).floor() {
                if alpha_at(&a, x, y) && alpha_at(&b, x, y) {
                    hits += 1;
                    if tiny || hits == 5 {
                        return true;
                    }
                }
                y -= 2.0;
            }
            x += 2.0;
        }
        false
    }

    fn k4_collision_geometry(&self, actor: usize) -> Option<CostumeGeometry<'_>> {
        let mut geometry = self.geometry(actor)?;
        let sprite = &self.sprites[actor];
        if sprite.rotation_type == 1 {
            let heading = (90.0 - sprite.direction + 180.0).rem_euclid(360.0) - 180.0;
            // K4's LEFT_RIGHT switches at +90/-90, not KN's zero heading.
            let k4_flip = !(-90.0..90.0).contains(&heading) && heading != -90.0;
            let old_flip =
                (sprite.direction - self.program.costume_turn + 540.0) % 360.0 - 180.0 < 0.0;
            if k4_flip != old_flip {
                geometry.x += 2.0 * geometry.costume.center_point[0] * geometry.width
                    / geometry.costume.width;
                geometry.width = -geometry.width;
            }
        }
        Some(geometry)
    }

    fn k4_internal_bounds(&self, actor: usize) -> Option<(f64, f64, f64, f64)> {
        let geometry = self.k4_collision_geometry(actor)?;
        let costume = geometry.costume;
        let (width, height) = (costume.width, costume.height);
        if ![
            width,
            height,
            geometry.width,
            geometry.height,
            geometry.x,
            geometry.y,
        ]
        .iter()
        .all(|n| n.is_finite())
            || width <= 0.0
            || height <= 0.0
        {
            return None;
        }
        // JfQ3 f/c: alpha is sampled at floor(texture_size * .7), then each
        // internal sample maps back through floor(coordinate / .7). The player
        // accepts a grid point only when all four adjacent alpha pixels exist.
        let (w, h) = (
            (width * 0.7).floor() as usize,
            (height * 0.7).floor() as usize,
        );
        if w <= 12 || h <= 12 || w.saturating_mul(h) > 1_000_000 {
            return None;
        }
        let solid = |x: usize, y: usize| {
            if x >= w || y >= h {
                return false;
            }
            let Some((mw, mh, bits)) = &costume.mask else {
                return true;
            };
            let mx = ((x as f64 + 0.5) * *mw as f64 / w as f64) as usize;
            let my = ((y as f64 + 0.5) * *mh as f64 / h as f64) as usize;
            let bit = my.saturating_mul(*mw).saturating_add(mx);
            bits.get(bit / 8)
                .is_some_and(|byte| byte & (1 << (bit % 8)) != 0)
        };
        let mut bounds: Option<(f64, f64, f64, f64)> = None;
        for y in (12..h).step_by(12) {
            for x in (12..w).step_by(12) {
                if ![(x - 1, y - 1), (x, y - 1), (x - 1, y), (x, y)]
                    .iter()
                    .all(|&(px, py)| solid(px, py))
                {
                    continue;
                }
                let (px, py) = geometry.point(
                    (x as f64 / 0.7).floor() / width,
                    (y as f64 / 0.7).floor() / height,
                );
                bounds = Some(match bounds {
                    None => (px, px, py, py),
                    Some((l, r, b, t)) => (l.min(px), r.max(px), b.min(py), t.max(py)),
                });
            }
        }
        bounds
    }

    pub(super) fn k4_bounce(&mut self, actor: usize) {
        let sprite = &self.sprites[actor];
        if ![
            sprite.x,
            sprite.y,
            sprite.direction,
            sprite.scale,
            sprite.size_x,
            sprite.size_y,
        ]
        .iter()
        .all(|n| n.is_finite())
        {
            return;
        }
        let Some((l, r, b, t)) = self.k4_internal_bounds(actor) else {
            return;
        };
        let (hw, hh) = (self.program.width / 2.0, self.program.height / 2.0);
        // The order is observable when a large sprite meets opposite edges.
        let edges = [r >= hw, l <= -hw, t >= hh, b <= -hh];
        if !edges.iter().any(|&hit| hit) {
            return;
        }
        let old = (90.0 - sprite.direction).to_radians();
        let (mut dy, mut dx) = old.sin_cos();
        if edges[0] {
            dx = -dx.abs();
        }
        if edges[1] {
            dx = dx.abs();
        }
        if edges[2] {
            dy = -dy.abs();
        }
        if edges[3] {
            dy = dy.abs();
        }
        let mut heading = dy.atan2(dx);
        if heading <= -std::f64::consts::PI {
            heading = std::f64::consts::PI;
        }
        if (old - heading) % std::f64::consts::TAU != 0.0 {
            let geometry = self.k4_collision_geometry(actor).unwrap();
            if geometry.costume.center_point.iter().all(|&n| n != 0.0) {
                // The official actor keeps its texture centre when BOTH pivot
                // components are nonzero. A one-axis pivot deliberately differs.
                let (cx, cy) = (geometry.x, geometry.y);
                let (x, y) = (sprite.x - cx, sprite.y - cy);
                let (s, c) = (old - heading).sin_cos();
                self.sprites[actor].x = cx + c * x + s * y;
                self.sprites[actor].y = cy - s * x + c * y;
            }
            self.sprites[actor].direction = 90.0 - heading.to_degrees();
        }
        let Some((l, r, b, t)) = self.k4_internal_bounds(actor) else {
            return;
        };
        let (mut x, mut y) = (0.0, 0.0);
        if edges[0] {
            x = hw - r - 10.0;
        }
        if edges[1] {
            x = -hw - l + 10.0;
        }
        if edges[2] {
            y = hh - t - 10.0;
        }
        if edges[3] {
            y = -hh - b + 10.0;
        }
        self.sprites[actor].x += x;
        self.sprites[actor].y += y;
        self.dirty[actor] = true;
    }
}
