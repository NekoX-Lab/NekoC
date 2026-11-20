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
    duration: f64,
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
            duration: distance / 200.0,
            distance: distance * sign,
            origin,
            horizontal,
        };
        if motion.duration <= 0.0 {
            self.apply_kn_kids_motion(actor, &motion, motion.distance, false);
        } else {
            self.tasks[task].anim = Some(Anim::KidsMotion(motion));
        }
    }

    fn apply_kn_kids_motion(&mut self, actor: usize, motion: &Motion, delta: f64, done: bool) {
        // changeTargetPosition adds each task delta to the CURRENT coordinate;
        // its on_end snaps only the selected axis to the captured final value.
        let sprite = &mut self.sprites[actor];
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
    }

    pub(super) fn step_kn_kids_motion(
        &mut self,
        task: usize,
        actor: usize,
        mut motion: Motion,
    ) -> bool {
        let elapsed = (self.time - motion.start).max(0.0);
        let done = elapsed >= motion.duration;
        let dt = (self.time - motion.last).max(0.0);
        self.apply_kn_kids_motion(actor, &motion, dt / motion.duration * motion.distance, done);
        motion.last = self.time;
        self.tasks[task].anim = if done {
            None
        } else {
            Some(Anim::KidsMotion(motion))
        };
        done
    }
}
