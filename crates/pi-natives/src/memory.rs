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
	}
}
