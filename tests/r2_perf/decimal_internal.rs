//! Included by engine::k4decimal; compares against the pre-optimization path.
use super::*;

fn reference(op: Operation, a: f64, b: f64) -> f64 {
    if !a.is_finite() || !b.is_finite() || matches!(op, Operation::Div) && b == 0.0 {
        return match op {
            Operation::Add => a + b,
            Operation::Sub => a - b,
            Operation::Mul => a * b,
            Operation::Div => a / b,
        };
    }
    // These original BigInt helpers must not delegate to the compact path.
    calculate(op, decimal(a), decimal(b))
}

fn assert_same(op: Operation, a: f64, b: f64) {
    let actual = apply(op, a, b);
    let expected = reference(op, a, b);
    assert!(
        actual.to_bits() == expected.to_bits() || actual.is_nan() && expected.is_nan(),
        "op={} a={a:?} b={b:?}: {actual:?} ({:x}) != {expected:?} ({:x})",
        op as u8,
        actual.to_bits(),
        expected.to_bits(),
    );
}

#[test]
fn r2_perf_decimal_extremes_and_binary64_boundaries_match_original_bits() {
    let values = [
        0.0,
        -0.0,
        1.0,
        -1.0,
        0.1,
        0.2,
        0.3,
        -0.3,
        0.999,
        9_007_199_254_740_991.0,
        9_007_199_254_740_992.0,
        9_007_199_254_740_994.0,
        1_000_000_000_000_000_100.0,
        1.0000000000000002,
        0.9999999999999999,
        1e-6,
        1e-7,
        1e20,
        1e21,
        1e22,
        1e38,
        1e39,
        f64::from_bits(1),
        -f64::from_bits(1),
        f64::MIN_POSITIVE,
        f64::from_bits(f64::MIN_POSITIVE.to_bits() - 1),
        f64::MAX,
        f64::MIN,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NAN,
    ];
    for op in [
        Operation::Add,
        Operation::Sub,
        Operation::Mul,
        Operation::Div,
    ] {
        for a in values {
            for b in values {
                assert_same(op, a, b);
            }
        }
    }
    assert_eq!(
        apply(Operation::Mul, -f64::from_bits(1), 0.1).to_bits(),
        (-0.0f64).to_bits()
    );
    assert_eq!(apply(Operation::Mul, -0.0, 0.1).to_bits(), 0.0f64.to_bits());
}

#[test]
fn r2_perf_decimal_fixed_seed_inputs_and_cancellation_match_original_bits() {
    let mut state = 0x7b9d_51ce_a603_24f8u64;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    for _ in 0..4096 {
        let a = f64::from_bits(next());
        let b = f64::from_bits(next());
        for op in [Operation::Add, Operation::Sub, Operation::Mul] {
            assert_same(op, a, b);
            // Same/adjacent exponents exercise compact add/sub and cancellation.
            assert_same(op, a, f64::from_bits(a.to_bits() ^ 1));
            assert_same(op, a, -a);
        }
    }
}

#[test]
fn r2_perf_decimal_scaled_coefficients_preserve_truncation_and_fallback() {
    for exponent in [-308, -40, -22, -21, -6, 0, 6, 20, 21, 38, 39, 100, 308] {
        for coefficient in [
            "1",
            "-1",
            "12345678901234567",
            "-9999999999999999",
            "10000000000000001",
            "99999999999999999",
        ] {
            let a: f64 = format!("{coefficient}e{exponent}").parse().unwrap();
            for b in [
                0.1,
                -0.1,
                1.2345678901234567,
                -9.999999999999998,
                f64::from_bits(1),
                1e308,
            ] {
                for op in [Operation::Add, Operation::Sub, Operation::Mul] {
                    assert_same(op, a, b);
                    assert_same(op, b, a);
                }
            }
        }
    }
}

#[test]
fn r2_perf_decimal_compact_path_declines_overflow_without_early_rounding() {
    for (op, a, b) in [
        (Operation::Add, 0.1, 0.2),
        (Operation::Add, 1e38, 1.0),
        (Operation::Add, 1.7e38, 1.0),
        (Operation::Sub, 1.0000000000000002, 1.0),
        (Operation::Mul, 1.2345678901234567, 9.999999999999998),
        (Operation::Mul, 1_000_000_000_000_000_100.0, 0.1),
        (Operation::Mul, f64::MAX, f64::MAX),
        (Operation::Mul, -f64::from_bits(1), 0.1),
    ] {
        let actual = compact::apply(op, a, b).expect("bounded coefficient fast path");
        assert_eq!(actual.to_bits(), reference(op, a, b).to_bits());
    }
    for (op, a, b) in [
        (Operation::Add, 1e39, 1.0),
        (Operation::Sub, f64::MAX, f64::from_bits(1)),
        // The power fits i128, but the aligned coefficient does not.
        (Operation::Add, 1.8e38, 1.0),
        (Operation::Div, 0.3, 0.1),
    ] {
        assert!(compact::apply(op, a, b).is_none());
        assert_same(op, a, b);
    }
}

#[test]
fn r2_perf_decimal_truncation_precedes_binary_rounding() {
    // Without the 20-digit truncation this product rounds one ULP lower.
    let a = f64::from_bits(0x36db_e570_2562_886a);
    let expected = 0xadc8_519a_4db6_5e50;
    assert_eq!(reference(Operation::Mul, a, -a).to_bits(), expected);
    assert_eq!(
        compact::apply(Operation::Mul, a, -a).unwrap().to_bits(),
        expected
    );
    assert_eq!(apply(Operation::Mul, a, -a).to_bits(), expected);
}
