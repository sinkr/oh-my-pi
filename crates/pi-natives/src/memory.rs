//! Return freed native heap pages to the OS once native work goes quiet.
//!
//! glibc gives each thread that allocates under contention its own arena (up
//! to eight per core), and an arena keeps the pages its frees leave behind.
//! Native work fans out across libuv, Tokio's blocking pool, and Rayon, so a
//! long session accumulates dozens of arenas holding memory nothing owns any
//! more: on a 32-core host, 80 rounds of reads, edits, and grep left 349 MiB
//! anonymous RSS, of which `malloc_trim(0)` returned 193 MiB in 16 ms. Capping
//! arenas instead slows that work 13-51%, and only takes effect from the
//! environment before the process starts.
//!
//! Every blocking native job holds a [`NativeWork`] guard. When the last one
//! drops, a dedicated thread waits for [`QUIET_PERIOD`] without new work and
//! then trims once. It sleeps on a condition variable in between, so an idle
//! process does nothing, and a trim never runs while counted jobs are using
//! the arenas it locks. Synchronous exports on the JS thread are not counted;
//! the next trim covers their arena too.

/// Marks one blocking native job as running for the idle trimmer.
#[must_use = "work counts as running only while the guard is alive"]
pub struct NativeWork(());

/// Count a blocking native job as running until the guard drops.
#[inline]
pub fn native_work() -> NativeWork {
	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	allocator::begin();
	NativeWork(())
}

impl Drop for NativeWork {
	#[inline]
	fn drop(&mut self) {
		#[cfg(all(target_os = "linux", target_env = "gnu"))]
		allocator::end();
	}
}

#[cfg(any(all(target_os = "linux", target_env = "gnu"), test))]
mod allocator {
	use std::time::Duration;

	use parking_lot::{Condvar, Mutex, MutexGuard};

	/// Quiet time after the last job before trimming: long enough to skip the
	/// gaps inside a burst of tool calls, short enough to trim while the agent
	/// waits on the model or the user.
	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	const QUIET_PERIOD: Duration = Duration::from_secs(5);

	/// Running jobs and how much finished work the last trim covered.
	struct Activity {
		running:  usize,
		finished: u64,
		trimmed:  u64,
	}

	impl Activity {
		/// Work finished since the last trim and none running: the generation a
		/// trim after the quiet period would cover.
		const fn pending(&self) -> Option<u64> {
			if self.running == 0 && self.finished != self.trimmed {
				Some(self.finished)
			} else {
				None
			}
		}
	}

	struct Trimmer {
		activity: Mutex<Activity>,
		idle:     Condvar,
	}

	impl Trimmer {
		const fn new() -> Self {
			Self {
				activity: Mutex::new(Activity { running: 0, finished: 0, trimmed: 0 }),
				idle:     Condvar::new(),
			}
		}

		fn begin(&self) {
			self.activity.lock().running += 1;
		}

		fn end(&self) {
			let mut activity = self.activity.lock();
			activity.running -= 1;
			activity.finished += 1;
			if activity.running == 0 {
				self.idle.notify_one();
			}
		}

		/// Trim after each quiet period that follows finished work; never
		/// returns.
		///
		/// Work that ends during the wait restarts it, and work still running
		/// when it expires defers the trim until that work ends.
		fn run(&self, quiet: Duration, mut release: impl FnMut()) -> ! {
			let mut activity = self.activity.lock();
			loop {
				let Some(generation) = activity.pending() else {
					self.idle.wait(&mut activity);
					continue;
				};
				if !self.idle.wait_for(&mut activity, quiet).timed_out() {
					continue;
				}
				if activity.pending() != Some(generation) {
					continue;
				}
				activity.trimmed = generation;
				MutexGuard::unlocked(&mut activity, &mut release);
			}
		}
	}

	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	static TRIMMER: Trimmer = Trimmer::new();

	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	pub(super) fn begin() {
		static STARTED: std::sync::Once = std::sync::Once::new();
		STARTED.call_once(|| {
			// Without the thread nothing is trimmed; the work itself is
			// unaffected.
			let _ = std::thread::Builder::new()
				.name("pi-heap-trim".into())
				.stack_size(64 * 1024)
				.spawn(|| TRIMMER.run(QUIET_PERIOD, release_unused_pages));
		});
		TRIMMER.begin();
	}

	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	pub(super) fn end() {
		TRIMMER.end();
	}

	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	fn release_unused_pages() {
		// SAFETY: malloc_trim is thread-safe, accepts any padding size, and only
		// releases free allocator pages; live allocations remain valid.
		unsafe {
			libc::malloc_trim(0);
		}
	}

	#[cfg(test)]
	mod tests {
		use std::sync::{Arc, mpsc};

		use super::*;

		/// Run a trimmer on its own thread; the thread outlives the test, parked.
		fn spawn_trimmer(quiet: Duration, release: impl FnMut() + Send + 'static) -> Arc<Trimmer> {
			let trimmer = Arc::new(Trimmer::new());
			let runner = Arc::clone(&trimmer);
			std::thread::spawn(move || runner.run(quiet, release));
			trimmer
		}

		#[test]
		fn trims_once_per_quiet_period_after_work_and_never_while_work_runs() {
			const QUIET: Duration = Duration::from_millis(50);
			let (trimmed_tx, trimmed) = mpsc::channel();
			let trimmer = spawn_trimmer(QUIET, move || trimmed_tx.send(()).unwrap());

			// Nothing has run yet, so there is nothing to trim.
			assert!(trimmed.recv_timeout(QUIET * 4).is_err());

			// Overlapping jobs: the first ending must not trim under the second.
			trimmer.begin();
			trimmer.begin();
			trimmer.end();
			assert!(trimmed.recv_timeout(QUIET * 4).is_err());
			trimmer.end();
			trimmed
				.recv_timeout(Duration::from_secs(10))
				.expect("trim after the quiet period");

			// Staying idle does not trim the same work again.
			assert!(trimmed.recv_timeout(QUIET * 4).is_err());

			// A job still running when the quiet period ends defers the trim.
			trimmer.begin();
			trimmer.end();
			trimmer.begin();
			assert!(trimmed.recv_timeout(QUIET * 4).is_err());
			trimmer.end();
			trimmed
				.recv_timeout(Duration::from_secs(10))
				.expect("trim once that job ends");
			assert!(trimmed.recv_timeout(QUIET * 4).is_err());
		}

		#[test]
		fn work_during_a_trim_neither_blocks_nor_goes_untrimmed() {
			const QUIET: Duration = Duration::from_millis(20);
			let (entered_tx, entered) = mpsc::channel();
			let (proceed_tx, proceed) = mpsc::channel::<()>();
			let trimmer = spawn_trimmer(QUIET, move || {
				entered_tx.send(()).unwrap();
				proceed.recv().unwrap();
			});

			trimmer.begin();
			trimmer.end();
			entered
				.recv_timeout(Duration::from_secs(10))
				.expect("first trim");
			// The first trim is still running: jobs must start and finish freely.
			trimmer.begin();
			trimmer.end();
			proceed_tx.send(()).unwrap();
			entered
				.recv_timeout(Duration::from_secs(10))
				.expect("trim covering the later job");
			proceed_tx.send(()).unwrap();
		}
	}
}
