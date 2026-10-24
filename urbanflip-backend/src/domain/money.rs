//! Exact decimal money math on stroops (10^-7), Stellar's own precision.
//! No floats anywhere in the computation path.

pub const MAX_DECIMALS: u32 = 7;

#[derive(Debug, thiserror::Error, PartialEq)]
#[error("invalid decimal amount '{0}' (expected non-negative, <= 7 decimals)")]
pub struct InvalidAmount(pub String);

/// "12345.67" -> 123456700000
pub fn to_stroops(decimal: &str) -> Result<i128, InvalidAmount> {
    let parts: Vec<&str> = decimal.split('.').collect();
    if parts.len() > 2 {
        return Err(InvalidAmount(decimal.to_string()));
    }
    let int = parts[0];
    if int.is_empty() || !int.bytes().all(|b| b.is_ascii_digit()) {
        return Err(InvalidAmount(decimal.to_string()));
    }
    let frac = parts.get(1).copied().unwrap_or("");
    if frac.len() > MAX_DECIMALS as usize || !frac.bytes().all(|b| b.is_ascii_digit()) {
        return Err(InvalidAmount(decimal.to_string()));
    }
    let mut digits = String::with_capacity(int.len() + MAX_DECIMALS as usize);
    digits.push_str(int);
    digits.push_str(frac);
    for _ in frac.len()..MAX_DECIMALS as usize {
        digits.push('0');
    }
    digits.parse::<i128>().map_err(|_| InvalidAmount(decimal.to_string()))
}

/// 123456700000 -> "12345.6700000"
pub fn from_stroops(stroops: i128) -> String {
    let negative = stroops < 0;
    let abs = stroops.unsigned_abs();
    let s = format!("{:0>8}", abs);
    let len = s.len();
    let (int, frac) = s.split_at(len - MAX_DECIMALS as usize);
    let sign = if negative { "-" } else { "" };
    format!("{sign}{int}.{frac}")
}

/// Trailing-zero-trimmed display, keeping at least `min_decimals`.
pub fn display_amount(stroops: i128, min_decimals: usize) -> String {
    let full = from_stroops(stroops);
    let (int, frac) = full.split_once('.').expect("from_stroops always has a dot");
    let trimmed = frac.trim_end_matches('0');
    let keep = min_decimals.max(trimmed.len()).min(MAX_DECIMALS as usize);
    format!("{int}.{}", &frac[..keep])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_formats_exactly() {
        assert_eq!(to_stroops("12345.67").unwrap(), 123456700000);
        assert_eq!(to_stroops("0.0000001").unwrap(), 1);
        assert_eq!(to_stroops("42").unwrap(), 420000000);
        assert_eq!(from_stroops(123456700000), "12345.6700000");
        assert_eq!(from_stroops(1), "0.0000001");
    }

    #[test]
    fn rejects_unusable_amounts() {
        assert!(to_stroops("-5").is_err());
        assert!(to_stroops("1.12345678").is_err());
        assert!(to_stroops("abc").is_err());
        assert!(to_stroops("").is_err());
    }

    #[test]
    fn displays_trimmed() {
        assert_eq!(display_amount(to_stroops("150.50").unwrap(), 2), "150.50");
        assert_eq!(display_amount(to_stroops("150.0000001").unwrap(), 2), "150.0000001");
    }
}
