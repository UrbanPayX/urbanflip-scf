pub mod api;
pub mod audit;
pub mod domain;
pub mod gate;
pub mod ops;
pub mod sdp;
pub mod stellar;
pub mod store;
pub mod wallet;

pub use api::state::Config;

/// Current UTC time as RFC 3339 with milliseconds, e.g. 2026-10-23T16:44:18.836Z.
pub fn gate_now() -> String {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    rfc3339(d.as_secs(), d.subsec_millis())
}

/// Unix seconds to a UTC calendar date (Hinnant's civil_from_days).
fn rfc3339(secs: u64, millis: u32) -> String {
    let z = (secs / 86_400) as i64 + 719_468;
    let rem = secs % 86_400;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn formats_rfc3339_utc() {
        assert_eq!(super::rfc3339(0, 0), "1970-01-01T00:00:00.000Z");
        assert_eq!(super::rfc3339(951_782_400, 5), "2000-02-29T00:00:00.005Z");
        assert_eq!(super::rfc3339(1_792_774_167, 796), "2026-10-23T16:49:27.796Z");
        assert_eq!(super::rfc3339(4_102_444_799, 999), "2099-12-31T23:59:59.999Z");
    }
}
