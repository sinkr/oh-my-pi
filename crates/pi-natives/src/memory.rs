//! Best-effort reclamation of unused native allocator pages.

use napi_derive::napi;

use crate::task;

/// Return unused allocator pages to the OS without evicting caches.
///
/// Runs off the JS thread, at most once per 60 seconds per process on
/// GNU/Linux. Returns false when throttled, unsupported, or no pages could be
/// released.
#[napi]
pub fn trim_native_memory() -> task::Promise<bool> {
	task::blocking("trim_native_memory", (), |_| {
		#[cfg(all(target_os = "linux", target_env = "gnu"))]
		{
			Ok(allocator::trim())
		}
		#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
		{
			Ok(false)
		}
	})
}

#[cfg(any(all(target_os = "linux", target_env = "gnu"), test))]
mod allocator {
	use std::time::{Duration, Instant};

	use parking_lot::Mutex;

	const TRIM_INTERVAL: Duration = Duration::from_secs(60);

	fn try_trim(
		last_trim: &Mutex<Option<Instant>>,
		now: Instant,
		release: impl FnOnce() -> bool,
	) -> bool {
		let Some(mut last) = last_trim.try_lock() else {
			return false;
		};
		if last.is_some_and(|last| now.saturating_duration_since(last) < TRIM_INTERVAL) {
			return false;
		}
		*last = Some(now);
		release()
	}

	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	fn release_unused_pages() -> bool {
		// SAFETY: malloc_trim is thread-safe, accepts any padding size, and only
		// releases free allocator pages; live allocations and cached trees remain
		// valid.
		unsafe { libc::malloc_trim(0) != 0 }
	}

	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	pub(super) fn trim() -> bool {
		static LAST_TRIM: Mutex<Option<Instant>> = Mutex::new(None);
		try_trim(&LAST_TRIM, Instant::now(), release_unused_pages)
	}

	#[cfg(test)]
	mod tests {
		use super::*;

		#[test]
		fn repeated_requests_wait_a_minute_even_when_no_pages_were_released() {
			let last_trim = Mutex::new(None);
			let start = Instant::now();
			let mut calls = 0;
			assert!(!try_trim(&last_trim, start, || {
				calls += 1;
				false
			}));
			assert!(!try_trim(&last_trim, start + TRIM_INTERVAL - Duration::from_nanos(1), || {
				calls += 1;
				true
			}));
			assert_eq!(calls, 1);
			assert!(try_trim(&last_trim, start + TRIM_INTERVAL, || {
				calls += 1;
				true
			}));
			assert_eq!(calls, 2);
		}

		#[test]
		fn concurrent_requests_skip_an_in_progress_trim() {
			let last_trim = Mutex::new(None);
			let start = Instant::now();
			assert!(try_trim(&last_trim, start, || {
				assert!(!try_trim(&last_trim, start + TRIM_INTERVAL, || {
					panic!("must not trim while another request holds the allocator gate")
				}));
				true
			}));
		}

		#[cfg(all(target_os = "linux", target_env = "gnu"))]
		#[test]
		fn trimming_keeps_cached_trees_available_for_reuse() {
			use pi_ast::{
				language::SupportLang,
				parse_cache::{parse_cache_stats, parse_cached},
			};

			// Cache counters are process-global; isolate this probe from parallel tests.
			if std::env::var_os("PI_NATIVE_TRIM_CACHE_PROBE").is_none() {
				let output = std::process::Command::new(std::env::current_exe().unwrap())
					.args([
						"--exact",
						"memory::allocator::tests::trimming_keeps_cached_trees_available_for_reuse",
					])
					.env("PI_NATIVE_TRIM_CACHE_PROBE", "1")
					.output()
					.unwrap();
				let stdout = String::from_utf8_lossy(&output.stdout);
				let stderr = String::from_utf8_lossy(&output.stderr);
				assert!(
					output.status.success() && stdout.contains("1 passed; 0 failed;"),
					"cache probe did not pass: {stdout}\n{stderr}"
				);
				return;
			}

			let code = "fn native_trim_preserves_tree() -> usize { 42 }";
			let tree = parse_cached(code, SupportLang::Rust, Some("native-trim.rs"))
				.unwrap()
				.unwrap();
			let before = parse_cache_stats();
			release_unused_pages();
			let reused = parse_cached(code, SupportLang::Rust, Some("native-trim.rs"))
				.unwrap()
				.unwrap();
			let after = parse_cache_stats();
			assert_eq!(after.hits, before.hits + 1);
			assert_eq!(after.misses, before.misses);
			assert_eq!(after.entries, before.entries);
			assert_eq!(tree.root_node().utf8_text(code.as_bytes()).unwrap(), code);
			assert_eq!(reused.root_node().to_sexp(), tree.root_node().to_sexp());
			assert!(!reused.root_node().has_error());
		}
	}
}
