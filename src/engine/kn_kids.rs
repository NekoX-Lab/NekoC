//! KN kids movement, traced through main.0f3db563.js and its 42.3dd2ca05 chunk.
//! Source anchors and timing limits: docs/kn-r2-blocks.md.
use super::*;

#[derive(Clone, Copy, Debug)]
pub(super) enum Direction {
    Right,
    Left,
    Up,
    Down,
}

#[derive(Clone, Debug)]
pub(super) struct Motion {
    start: f64,
    last: f64,
    lifetime_ms: f64,
    distance: f64,
    origin: f64,
    horizontal: bool,
}

impl Engine {
    pub(super) fn start_kn_kids_motion(
        &mut self,
        task: usize,
        actor: usize,
        direction: Direction,
        value: usize,
    ) {
        let value = self.eval_value(value, actor);
        if self.value_error.is_some() {
            return;
        }
        // The official u helper reports IGNORED_EXECUTION but falls through to
        // JS multiplication. Numeric text/bools/arrays still move.
        if !matches!(value, Cell::Number(n) if n.is_finite()) {
            self.push_kn_panel_notice(PanelNotice::IgnoredKidsSteps);
        }
        let steps = match &value {
            Cell::List(_) => crate::js_number::parse(&value.text()),
            _ => value.number(),
        };
        let distance = steps * 25.0;
        if !distance.is_finite() || distance == 0.0 {
            return;
        }
        let horizontal = matches!(direction, Direction::Right | Direction::Left);
        let sign = if matches!(direction, Direction::Right | Direction::Up) {
            1.0
        } else {
            -1.0
        };
        let origin = if horizontal {
            self.sprites[actor].x
        } else {
            self.sprites[actor].y
        };
        let motion = Motion {
            start: self.time,
            last: self.time,
            // Preserve both JS operations, including underflow in seconds and
            // overflow when TaskManager converts the lifetime to milliseconds.
            lifetime_ms: (distance / 200.0) * 1000.0,
            distance: distance * sign,
            origin,
            horizontal,
        };
        if motion.lifetime_ms <= 0.0 {
            self.apply_kn_kids_motion(actor, &motion, motion.distance, false);
        } else {
            self.tasks[task].anim = Some(Anim::KidsMotion(motion));
        }
    }

    fn apply_kn_kids_motion(&mut self, actor: usize, motion: &Motion, delta: f64, done: bool) {
        // changeTargetPosition adds each task delta to the CURRENT coordinate;
        // its on_end snaps only the selected axis to the captured final value.
        let sprite = &mut self.sprites[actor];
        let old = (sprite.x, sprite.y);
        let coordinate = if motion.horizontal {
            &mut sprite.x
        } else {
            &mut sprite.y
        };
        *coordinate = if done {
            motion.origin + motion.distance
        } else {
            *coordinate + delta
        };
        self.dirty[actor] = true;
        self.line(actor, old);
    }

    /// Official step_code precedes TaskManager.update. Expiry queues disposal:
    /// removing the animation here releases AnimStep only on the NEXT update.
    pub(super) fn tick_kn_kids_motion(&mut self) -> Result<()> {
        for index in 0..self.tasks.len() {
            if self.tasks[index].done
                || !matches!(self.tasks[index].anim, Some(Anim::KidsMotion(_)))
            {
                continue;
            }
            let Some(Anim::KidsMotion(mut motion)) = self.tasks[index].anim.take() else {
                unreachable!();
            };
            let actor = self.tasks[index].actor;
            if !self.sprites[actor].alive {
                continue;
            }
            let elapsed_ms = (self.time - motion.start).max(0.0) * 1000.0;
            let dt_ms = (self.time - motion.last).max(0.0) * 1000.0;
            if elapsed_ms >= motion.lifetime_ms {
                // TaskManager calls on_end INSTEAD OF on_tick at expiry.
                self.apply_kn_kids_motion(actor, &motion, 0.0, true);
            } else {
                if dt_ms != 0.0 {
                    let delta = dt_ms / motion.lifetime_ms * motion.distance;
                    self.apply_kn_kids_motion(actor, &motion, delta, false);
                }
                motion.last = self.time;
                self.tasks[index].anim = Some(Anim::KidsMotion(motion));
            }
            if let Some(error) = self.value_error.take() {
                let pc = self.tasks[index].pc.saturating_sub(1);
                bail!(error_location::at_block(&error, &self.program.sources[pc]));
            }
        }
        Ok(())
    }
}
