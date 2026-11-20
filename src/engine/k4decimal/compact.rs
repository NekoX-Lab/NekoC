//! Exact bounded coefficients for finite Number add/subtract/multiply.
//! Overflow declines the fast path; the caller retains the BigInt algorithm.
use super::Operation;

const POWERS: [i128; 39] = {
    let mut powers = [1; 39];
    let mut i = 1;
    while i < powers.len() {
        powers[i] = powers[i - 1] * 10;
        i += 1;
    }
    powers
};

// Only accepts ryu_js's spelling of a finite Number, not arbitrary source text.
// A direct f64 -> integer cast would use the binary value instead of JS's
// shortest decimal (for example 1000000000000000100). Strip decimal trailing
// zeros so every coefficient has at most the Number's 17 significant digits.
fn decimal(n: f64) -> (i128, i32) {
    let mut buffer = ryu_js::Buffer::new();
    let text = buffer.format(n);
    let (mantissa, exponent) = text.split_once('e').unwrap_or((text, "0"));
    let mut exponent = exponent.parse::<i32>().unwrap();
    let mut coefficient = 0i128;
    let mut fractional = false;
    for byte in mantissa.bytes() {
        match byte {
            b'-' => {}
            b'.' => fractional = true,
            _ => {
                coefficient = coefficient * 10 + i128::from(byte - b'0');
                exponent -= i32::from(fractional);
            }
        }
    }
    if coefficient == 0 {
        return (0, 0);
    }
    while coefficient % 10 == 0 {
        coefficient /= 10;
        exponent += 1;
    }
    if n.is_sign_negative() {
        coefficient = -coefficient;
    }
    (coefficient, exponent)
}

fn scale(coefficient: i128, places: i32) -> Option<i128> {
    if coefficient == 0 {
        Some(0)
    } else {
        coefficient.checked_mul(*POWERS.get(places as usize)?)
    }
}

pub(super) fn apply(op: Operation, a: f64, b: f64) -> Option<f64> {
    debug_assert!(a.is_finite() && b.is_finite());
    if matches!(op, Operation::Div) {
        return None;
    }
    let (a, ae) = decimal(a);
    let (b, be) = decimal(b);
    let (mut coefficient, mut exponent) = match op {
        Operation::Add | Operation::Sub => {
            let exponent = ae.min(be);
            let a = scale(a, ae - exponent)?;
            let b = scale(b, be - exponent)?;
            let coefficient = if matches!(op, Operation::Add) {
                a.checked_add(b)?
            } else {
                a.checked_sub(b)?
            };
            (coefficient, exponent)
        }
        Operation::Mul => (a.checked_mul(b)?, ae + be),
        Operation::Div => unreachable!(),
    };
    if coefficient == 0 {
        return Some(0.0);
    }
    // Truncate only the complete exact result, never either operand: small
    // terms can still change cancellation, borrowing, or the final rounding.
    let digits = coefficient.unsigned_abs().ilog10() + 1;
    if digits > 20 {
        let drop = digits - 20;
        coefficient /= POWERS[drop as usize];
        exponent += drop as i32;
    }
    // Keep a single correctly rounded decimal -> binary conversion. Multiplying
    // a cast coefficient by powi(10) would round twice. Negative underflow must
    // keep -0, unlike the exact-zero branch above.
    Some(format!("{coefficient}e{exponent}").parse().unwrap())
}
