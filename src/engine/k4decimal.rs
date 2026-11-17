//! K4 Tn6a numeric arithmetic: decimal.js-light, precision 20, truncated
//! after each operation, then converted back to a JS Number. Not display rounding.
use num_bigint::BigInt;
use num_traits::{Signed, Zero};

pub(super) fn cells(op: super::Binary, a: &super::Cell, b: &super::Cell) -> f64 {
    // Decimal rejects booleans/null/objects instead of applying Number coercion
    // first. Preserve the JS fallback for those operands (not decimal(1) for true).
    if let (super::Cell::Number(a), super::Cell::Number(b)) = (a, b) {
        op.apply(*a, *b)
    } else if let (Some(decimal_a), Some(decimal_b)) = (cell_decimal(a), cell_decimal(b)) {
        if matches!(op, super::Binary::K4Div) {
            // Tn6a intercepts only Number zero and the exact string "0".
            // Other decimal zero strings enter haXk, whose division checks
            // the zero numerator before rejecting the zero denominator.
            if matches!(b, super::Cell::Number(n) if *n == 0.0)
                || matches!(b, super::Cell::Text(s) if &**s == "0")
            {
                return a.number() / b.number();
            }
            if decimal_a.0.is_zero() {
                return 0.0;
            }
            if decimal_b.0.is_zero() {
                return a.number() / b.number();
            }
        }
        calculate(operation(op), decimal_a, decimal_b)
    } else {
        let (a, b) = (a.number(), b.number());
        match op {
            super::Binary::K4Sub => a - b,
            super::Binary::K4Mul => a * b,
            super::Binary::K4Div => a / b,
            _ => unreachable!(),
        }
    }
}

pub(super) fn change(
    previous: &super::Cell,
    value: &super::Cell,
    decrease: bool,
) -> Option<super::Cell> {
    use super::Cell;
    if matches!(
        previous,
        Cell::List(_) | Cell::Costume(_) | Cell::Midi(_) | Cell::Null
    ) {
        return None;
    }
    Some(
        if !decrease
            && (matches!(previous, Cell::Text(_))
                || matches!(
                    value,
                    Cell::Text(_) | Cell::List(_) | Cell::Costume(_) | Cell::Midi(_)
                ))
        {
            Cell::concat(previous, value)
        } else {
            Cell::Number(if decrease {
                cells(super::Binary::K4Sub, previous, value)
            } else if let (Cell::Number(a), Cell::Number(b)) = (previous, value) {
                apply(Operation::Add, *a, *b)
            } else {
                previous.number() + value.number()
            })
        },
    )
}

fn operation(op: super::Binary) -> Operation {
    match op {
        super::Binary::K4Sub => Operation::Sub,
        super::Binary::K4Mul => Operation::Mul,
        super::Binary::K4Div => Operation::Div,
        _ => unreachable!(),
    }
}

fn cell_decimal(value: &super::Cell) -> Option<(BigInt, i32)> {
    match value {
        super::Cell::Number(n) if n.is_finite() => Some(decimal(*n)),
        super::Cell::Text(text) => parse_decimal(text.as_ref()),
        _ => None,
    }
}

fn parse_decimal(text: &str) -> Option<(BigInt, i32)> {
    let (mantissa, exponent) = text.split_once(['e', 'E']).unwrap_or((text, "0"));
    // The official constructor strips '-' only; leading '+' falls back to JS.
    let unsigned = mantissa.strip_prefix('-').unwrap_or(mantissa);
    let (whole, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    if whole.is_empty() && fraction.is_empty()
        || !whole
            .bytes()
            .chain(fraction.bytes())
            .all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let exponent = exponent
        .parse::<i32>()
        .ok()?
        .checked_sub(fraction.len().try_into().ok()?)?;
    // This adapter's Number operands span -324..308. Keep unrelated, arbitrarily
    // large numeric-string exponent support on its previous Number fallback.
    if !(-2048..=2048).contains(&exponent) {
        return None;
    }
    Some((mantissa.replace('.', "").parse().ok()?, exponent))
}

#[derive(Clone, Copy)]
pub(super) enum Operation {
    Add,
    Sub,
    Mul,
    Div,
}

fn decimal(n: f64) -> (BigInt, i32) {
    let mut buffer = ryu_js::Buffer::new();
    let text = buffer.format(n);
    let (mantissa, exponent) = text.split_once('e').unwrap_or((text, "0"));
    let fractional = mantissa.split_once('.').map_or(0, |(_, s)| s.len());
    let digits = mantissa.replace('.', "");
    (
        digits.parse().unwrap(),
        exponent.parse::<i32>().unwrap() - fractional as i32,
    )
}

fn ten(n: i32) -> BigInt {
    BigInt::from(10).pow(n as u32)
}

pub(super) fn apply(op: Operation, a: f64, b: f64) -> f64 {
    // Decimal's constructor rejects nonfinite operands; Tn6a catches that
    // error and uses the JS operator. Division by zero takes that path too.
    if !a.is_finite() || !b.is_finite() || matches!(op, Operation::Div) && b == 0.0 {
        return match op {
            Operation::Add => a + b,
            Operation::Sub => a - b,
            Operation::Mul => a * b,
            Operation::Div => a / b,
        };
    }
    // Exact small-integer operations are also exact in decimal. This covers
    // loop counters without imposing a fixed decimal-place cutoff on fractions.
    const SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
    if !matches!(op, Operation::Div)
        && a.fract() == 0.0
        && b.fract() == 0.0
        && a.abs() <= SAFE_INTEGER
        && b.abs() <= SAFE_INTEGER
    {
        let result = match op {
            Operation::Add => a + b,
            Operation::Sub => a - b,
            Operation::Mul => a * b,
            Operation::Div => unreachable!(),
        };
        if result.abs() <= SAFE_INTEGER {
            return if result == 0.0 { 0.0 } else { result };
        }
    }
    calculate(op, decimal(a), decimal(b))
}

fn calculate(op: Operation, (a, ae): (BigInt, i32), (b, be): (BigInt, i32)) -> f64 {
    let (mut coefficient, mut exponent) = match op {
        Operation::Add | Operation::Sub => {
            let exponent = ae.min(be);
            let a = a * ten(ae - exponent);
            let b = b * ten(be - exponent);
            (
                if matches!(op, Operation::Add) {
                    a + b
                } else {
                    a - b
                },
                exponent,
            )
        }
        Operation::Mul => (a * b, ae + be),
        Operation::Div => {
            // Scale before integer division so at least 40 significant digits
            // survive even when the denominator has more digits than the numerator.
            let guard = 40 + b.abs().to_str_radix(10).len() as i32;
            (a * ten(guard) / b, ae - be - guard)
        }
    };
    if coefficient.is_zero() {
        // Decimal.js-light has no negative zero.
        return 0.0;
    }
    let digits = coefficient.abs().to_str_radix(10).len();
    if digits > 20 {
        let drop = (digits - 20) as i32;
        coefficient /= ten(drop);
        exponent += drop;
    }
    format!("{coefficient}e{exponent}").parse().unwrap()
}
