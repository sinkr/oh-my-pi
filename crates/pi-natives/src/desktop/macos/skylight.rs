use std::{
	ffi::c_void,
	ptr,
	sync::{
		LazyLock,
		atomic::{AtomicBool, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use core_graphics::{event::CGEvent, geometry::CGPoint};
use foreign_types::ForeignType;
use libc::pid_t;
use objc2_core_foundation::{CFArray, CFDictionary, CFNumber, CFRetained, CFString, CFType};

use super::{
	super::{
		control,
		error::{CoreResult, DesktopError},
	},
	ax, capture,
	release::Route,
	release_guard,
	route::{self, Routes, symbol},
};

const EVENT_RECORD_LENGTH: usize = 248;
const EVENT_RECORD_LENGTH_BYTE: u8 = 0xf8;
const EVENT_RECORD_KIND: u8 = 0x0d;
const WINDOW_ID_OFFSET: usize = 0x3c;
const FOCUS_MARKER_OFFSET: usize = 0x8a;
const FOCUS_MARKER: u8 = 0x01;
/// `kCPSUserGenerated`: lets `AppKit` install the requested native key window.
const CPS_USER_GENERATED: u32 = 0x200;
/// `kCPSNoWindows`: changes the front process without raising its windows.
const CPS_NO_WINDOWS: u32 = 0x400;
/// Covers delayed AX/AppKit activation after the synchronous action returns.
/// The lease is joined before returning; it never continues fighting the user.
const BACKGROUND_SETTLE: Duration = Duration::from_millis(200);
/// Upper bound on waiting for a foreground activation to become observable.
const ACTIVATION_TIMEOUT: Duration = Duration::from_millis(400);
const ACTIVATION_POLL: Duration = Duration::from_millis(10);
/// Keeps the target frontmost until it has consumed foreground input.
const FOREGROUND_SETTLE: Duration = Duration::from_millis(40);
/// `SLSSetFrontProcessWithInfo`'s result when a user key press or click was
/// dispatched after the request's timestamp.
const EXPIRED_FRONT_REQUEST: i32 = -13066;

unsafe extern "C" {
	fn CGEventSourceCounterForEventType(state: i32, event_type: u32) -> u32;
}

#[repr(C)]
#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct ProcessSerialNumber {
	high: u32,
	low:  u32,
}

type SLPSPostEventRecordToFn = unsafe extern "C" fn(*const ProcessSerialNumber, *const u8) -> i32;
type SLPSGetFrontProcessFn = unsafe extern "C" fn(*mut ProcessSerialNumber) -> i32;
type CGSMainConnectionIDFn = unsafe extern "C" fn() -> u32;
type SLSGetWindowOwnerFn = unsafe extern "C" fn(u32, u32, *mut u32) -> i32;
type SLSGetConnectionPSNFn = unsafe extern "C" fn(u32, *mut ProcessSerialNumber) -> i32;
type GetProcessForPIDFn = unsafe extern "C" fn(pid_t, *mut ProcessSerialNumber) -> i32;
type GetProcessPIDFn = unsafe extern "C" fn(*const ProcessSerialNumber, *mut pid_t) -> i32;
type CGEventSetWindowLocationFn = unsafe extern "C" fn(*mut c_void, CGPoint);
type SLPSSetFrontProcessWithOptionsFn =
	unsafe extern "C" fn(*const ProcessSerialNumber, u32, u32) -> i32;
type SLSSetFrontProcessWithInfoFn =
	unsafe extern "C" fn(*const ProcessSerialNumber, u32, u32, *const c_void) -> i32;

#[derive(Clone, Copy)]
struct PsnLookup {
	main_connection:     Option<CGSMainConnectionIDFn>,
	get_window_owner:    Option<SLSGetWindowOwnerFn>,
	get_connection_psn:  Option<SLSGetConnectionPSNFn>,
	get_process_for_pid: Option<GetProcessForPIDFn>,
}

impl PsnLookup {
	fn can_resolve(self) -> bool {
		(self.main_connection.is_some()
			&& self.get_window_owner.is_some()
			&& self.get_connection_psn.is_some())
			|| self.get_process_for_pid.is_some()
	}
}

#[derive(Clone, Copy)]
struct RequiredSpi {
	routes:              &'static Routes,
	set_window_location: CGEventSetWindowLocationFn,
	main_connection:     CGSMainConnectionIDFn,
}

#[derive(Clone, Copy)]
struct ForegroundSpi {
	set_front:   SLPSSetFrontProcessWithOptionsFn,
	get_front:   SLPSGetFrontProcessFn,
	post_record: SLPSPostEventRecordToFn,
	psn:         PsnLookup,
	conditional: Option<ConditionalFront>,
}

/// The front-process request `WindowServer` refuses when the user pressed a
/// key or clicked after the request's timestamp.
#[derive(Clone, Copy)]
struct ConditionalFront {
	set_front:     SLSSetFrontProcessWithInfoFn,
	/// `kSLSSetFrontProcessRequestTimestampKey`, a process-lived `CFString`.
	timestamp_key: *const CFString,
}

// SAFETY: `timestamp_key` points at an immutable, process-lived CFString
// constant exported by SkyLight.
unsafe impl Send for ConditionalFront {}
// SAFETY: as above; the pointee is never mutated.
unsafe impl Sync for ConditionalFront {}

/// The front process as `WindowServer` reports it. Unlike
/// `NSWorkspace.frontmostApplication`, this does not depend on an `AppKit`
/// run loop in this process observing activation changes.
#[derive(Clone, Copy)]
struct FrontProcess {
	psn: ProcessSerialNumber,
	pid: Option<pid_t>,
}

static REQUIRED: LazyLock<Option<RequiredSpi>> = LazyLock::new(resolve_required);
static FOREGROUND: LazyLock<Option<ForegroundSpi>> = LazyLock::new(resolve_foreground);
static PROCESS_PID: LazyLock<Option<GetProcessPIDFn>> = LazyLock::new(|| symbol(c"GetProcessPID"));

pub(super) fn is_available() -> bool {
	required().is_ok() && takeover_available()
}

pub(super) fn takeover_available() -> bool {
	FOREGROUND.is_some() && PROCESS_PID.is_some()
}

fn required() -> CoreResult<&'static RequiredSpi> {
	REQUIRED.as_ref().ok_or_else(|| {
		DesktopError::background_unavailable(
			"skylight-spi-missing: required SkyLight background input symbols are unavailable; retry \
			 with takeover:true or use ax actions",
		)
	})
}

fn resolve_required() -> Option<RequiredSpi> {
	Some(RequiredSpi {
		routes:              route::routes()?,
		set_window_location: symbol(c"CGEventSetWindowLocation")?,
		main_connection:     symbol(c"CGSMainConnectionID")?,
	})
}

fn resolve_foreground() -> Option<ForegroundSpi> {
	route::load_skylight()?;
	let psn = PsnLookup {
		main_connection:     symbol(c"CGSMainConnectionID"),
		get_window_owner:    symbol(c"SLSGetWindowOwner"),
		get_connection_psn:  symbol(c"SLSGetConnectionPSN"),
		get_process_for_pid: symbol(c"GetProcessForPID"),
	};
	if !psn.can_resolve() {
		return None;
	}
	Some(ForegroundSpi {
		set_front: symbol(c"_SLPSSetFrontProcessWithOptions")?,
		get_front: symbol(c"_SLPSGetFrontProcess")?,
		post_record: symbol(c"SLPSPostEventRecordTo")?,
		psn,
		conditional: resolve_conditional_front(),
	})
}

fn resolve_conditional_front() -> Option<ConditionalFront> {
	let key: *const *const CFString = symbol(c"kSLSSetFrontProcessRequestTimestampKey")?;
	// SAFETY: the exported symbol is a `CFStringRef` variable that SkyLight
	// initializes before any of its functions can be called.
	let timestamp_key = unsafe { key.read() };
	if timestamp_key.is_null() {
		return None;
	}
	Some(ConditionalFront { set_front: symbol(c"SLSSetFrontProcessWithInfo")?, timestamp_key })
}

fn event_ptr(event: &CGEvent) -> *mut c_void {
	event.as_ptr().cast()
}

/// Stamps raw `SkyLight` integer event fields onto `event`.
pub(super) fn set_fields(event: &CGEvent, fields: &[(u32, i64)]) -> CoreResult<()> {
	let routes = required()?.routes;
	let ptr = event_ptr(event);
	for &(field, value) in fields {
		// SAFETY: The event is alive for the call.
		unsafe { routes.set_field(ptr, field, value) };
	}
	Ok(())
}

/// Stamps a window-local point, measured from the window's top-left including
/// its title bar, for hit-testing a pid-addressed pointer event.
pub(super) fn set_window_location(event: &CGEvent, location: CGPoint) -> CoreResult<()> {
	let spi = required()?;
	// SAFETY: The event is alive for the call and the setter passed the atomic
	// exact-signature probe.
	unsafe { (spi.set_window_location)(event_ptr(event), location) };
	Ok(())
}

/// Posts a pointer event through `SkyLight` alone (see [`Routes::routed`]).
pub(super) fn post_routed(pid: pid_t, event: &CGEvent) -> CoreResult<()> {
	post_to_pid(Route::Routed(pid), event, |routes, event| {
		// SAFETY: `post_to_pid` passes the live event it retains for the call.
		unsafe { routes.routed(pid, event) };
		Ok(())
	})
}

/// Posts a background pointer event through `SkyLight` and, where it is a
/// separate function, the public per-pid queue (see [`Routes::public`]).
pub(super) fn post_dual(pid: pid_t, event: &CGEvent) -> CoreResult<()> {
	post_to_pid(Route::Dual(pid), event, |routes, event| {
		// SAFETY: `post_to_pid` passes the live event it retains for the call.
		unsafe { routes.routed(pid, event) };
		control::check()?;
		// SAFETY: as above.
		unsafe { routes.public(pid, event) };
		Ok(())
	})
}

/// Posts a keyboard event on the authenticated `SkyLight` route (see
/// [`Routes::keyboard`]).
pub(super) fn post_keyboard(pid: pid_t, event: &CGEvent) -> CoreResult<()> {
	post_to_pid(Route::Keyboard(pid), event, |routes, event| {
		// SAFETY: `post_to_pid` passes the live event it retains for the call.
		unsafe { routes.keyboard(pid, event) };
		Ok(())
	})
}

/// Posts `event`, tagged as synthetic, through `post` on `route`, telling the
/// input request's release helper what it holds. `post` receives a live
/// event, retained for the synchronous call.
fn post_to_pid(
	route: Route,
	event: &CGEvent,
	post: impl FnOnce(&Routes, *mut c_void) -> CoreResult<()>,
) -> CoreResult<()> {
	control::check()?;
	event.set_integer_value_field(
		core_graphics::event::EventField::EVENT_SOURCE_USER_DATA,
		control::SYNTHETIC_EVENT_TAG,
	);
	let routes = required()?.routes;
	release_guard::post(route, event, || post(routes, event_ptr(event)))
}

/// This process's `WindowServer` connection, which `AppKit` stamps on the
/// window events it builds as their window context.
pub(super) fn sender_connection() -> CoreResult<i64> {
	let spi = required()?;
	// SAFETY: The no-argument connection query was resolved with its exact
	// signature.
	Ok(i64::from(unsafe { (spi.main_connection)() }))
}

/// The 248-byte focus event record addressed to window `wid`.
fn focus_record(wid: u32) -> [u8; EVENT_RECORD_LENGTH] {
	let mut record = [0u8; EVENT_RECORD_LENGTH];
	record[0x04] = EVENT_RECORD_LENGTH_BYTE;
	record[0x08] = EVENT_RECORD_KIND;
	record[WINDOW_ID_OFFSET..WINDOW_ID_OFFSET + 4].copy_from_slice(&wid.to_le_bytes());
	record[FOCUS_MARKER_OFFSET] = FOCUS_MARKER;
	record
}

/// One of the paired records (`kind` 0x01, then 0x02) that make window `wid`
/// the native key window of its process.
fn make_key_record(wid: u32, kind: u8) -> [u8; EVENT_RECORD_LENGTH] {
	let mut record = [0u8; EVENT_RECORD_LENGTH];
	record[0x04] = EVENT_RECORD_LENGTH_BYTE;
	record[0x08] = kind;
	record[0x20..0x30].fill(0xff);
	record[0x3a] = 0x10;
	record[WINDOW_ID_OFFSET..WINDOW_ID_OFFSET + 4].copy_from_slice(&wid.to_le_bytes());
	record
}

fn post_record(
	post: SLPSPostEventRecordToFn,
	psn: ProcessSerialNumber,
	record: &[u8; EVENT_RECORD_LENGTH],
) -> bool {
	// SAFETY: The PSN and the complete 248-byte record live through the
	// synchronous SPI call.
	unsafe { post(&psn, record.as_ptr()) == 0 }
}

fn front_process(get_front: SLPSGetFrontProcessFn) -> Option<FrontProcess> {
	let mut psn = ProcessSerialNumber::default();
	// SAFETY: `psn` is writable and exactly the 8-byte PSN record expected by
	// this SPI.
	if unsafe { get_front(&mut psn) } != 0 {
		return None;
	}
	let pid = (*PROCESS_PID).and_then(|get_pid| {
		let mut pid: pid_t = 0;
		// SAFETY: Both pointers are valid for the synchronous lookup and the
		// symbol has the exact GetProcessPID ABI.
		(unsafe { get_pid(&psn, &mut pid) } == 0 && pid > 0).then_some(pid)
	});
	Some(FrontProcess { psn, pid })
}

/// Joins the action and its cleanup without hiding a failed restoration or
/// encouraging an unsafe blind retry of an action that may already have landed.
pub(super) fn after_cleanup<T>(result: CoreResult<T>, cleanup: CoreResult<()>) -> CoreResult<T> {
	match (result, cleanup) {
		(result, Ok(())) => result,
		(Ok(_), Err(error)) => Err(DesktopError::input_failed(format!(
			"input may already have been delivered, but restoration failed: {error}; inspect the \
			 desktop before retrying"
		))),
		(Err(action), Err(cleanup)) => Err(DesktopError::input_failed(format!(
			"{action}; restoration also failed: {cleanup}; inspect the desktop before retrying"
		))),
	}
}

/// Physical activity is a conservative veto, not proof of which app the user
/// chose. A source that updates HID counters for synthetic events can also veto
/// restoration; yielding control is safer than fighting a deliberate switch.
fn activation_activity() -> [u32; 5] {
	// Left/right/other press, key press, and modifiers can change activation.
	[1, 3, 25, 10, 12].map(|event_type| {
		// SAFETY: HIDSystemState (1) and these public CGEventType values are
		// defined by CGEventSource.h / CGEventTypes.h; this is a read-only query.
		unsafe { CGEventSourceCounterForEventType(1, event_type) }
	})
}

#[derive(Debug, PartialEq, Eq)]
enum FocusDecision {
	Observe,
	Restore,
	Disarm,
}

/// Once the user changes the front app/window, later target activations cannot
/// resurrect this action's old focus claim.
struct BackgroundFocusLease {
	previous:    ProcessSerialNumber,
	target:      ProcessSerialNumber,
	/// The user's key window; `None` when the front app showed no window.
	key:         Option<u32>,
	activity:    [u32; 5],
	/// Polls left in which the target coming to the front counts as the
	/// user's doing: a click seen while their app was still in front may be
	/// the one on the target that brings it forward a moment later.
	click_polls: u8,
	disarmed:    bool,
	/// The user came to the target ([`TargetVisit`]).
	visited:     bool,
}

/// Polls of [`ACTIVATION_POLL`] after a click with the user's app in front
/// during which the target coming forward is taken as that click's work.
const CLICK_SWITCH_POLLS: u8 = 25;

/// Whether `now` counts a press of a mouse button that `before` did not
/// ([`activation_activity`] lists the three buttons first).
fn clicked(before: [u32; 5], now: [u32; 5]) -> bool {
	before[..3] != now[..3]
}

impl BackgroundFocusLease {
	fn observe(
		&mut self,
		front: ProcessSerialNumber,
		key: Option<u32>,
		activity: [u32; 5],
	) -> FocusDecision {
		if self.disarmed
			|| (front != self.previous && front != self.target)
			|| (front == self.previous && key.is_some_and(|key| Some(key) != self.key))
			|| (front == self.target && (activity != self.activity || self.click_polls > 0))
		{
			// The target in front now is the user's: they acted there, or the
			// lease no longer sends it back.
			self.visited |= front == self.target;
			self.disarmed = true;
			return FocusDecision::Disarm;
		}
		if front == self.target {
			FocusDecision::Restore
		} else {
			// Typing while the user's original window is still frontmost is not
			// a focus change. Remember it so a later app reflex can be contained.
			// A click may be on the target, which then comes forward only on a
			// later poll, so the target counts as the user's for a while.
			self.click_polls = if clicked(self.activity, activity) {
				CLICK_SWITCH_POLLS
			} else {
				self.click_polls.saturating_sub(1)
			};
			self.activity = activity;
			FocusDecision::Observe
		}
	}

	/// The hand-back was refused because the user pressed a key or clicked
	/// with the target in front.
	const fn user_acted(&mut self) {
		self.visited = true;
		self.disarmed = true;
	}
}

/// Whether the user has come to the background target since its guard
/// began: the target was in front with a key or click of theirs, the
/// hand-back was refused because of one, or the target was in front after the
/// guard stood down. Later steps of the input must stop then, even once the
/// user has left the target again.
#[derive(Clone, Copy)]
pub(super) struct TargetVisit<'a>(&'a AtomicBool);

static NO_VISIT: AtomicBool = AtomicBool::new(false);

impl TargetVisit<'_> {
	/// For input into the application already in front, which no guard
	/// watches.
	pub(super) fn none() -> TargetVisit<'static> {
		TargetVisit(&NO_VISIT)
	}

	pub(super) fn happened(self) -> bool {
		self.0.load(Ordering::Acquire)
	}
}

/// [`with_background_watch`] for an action that has no later steps to stop.
pub(super) fn with_background_guard<T>(
	pid: pid_t,
	action: impl FnOnce() -> CoreResult<T>,
) -> CoreResult<T> {
	with_background_watch(pid, |_| action())
}

/// Contains asynchronous self-activation during background input and its
/// bounded post-action settle, without a process-lived observer or run loop.
/// A third app, changed prior key window, or new hardware input permanently
/// disarms the lease. Only the addressed target can be sent back behind the
/// original front app; unlike cua's wildcard suppressor, unrelated activations
/// are never undone. `action` gets the [`TargetVisit`] the guard records,
/// which keeps being watched after the lease disarms.
pub(super) fn with_background_watch<T>(
	pid: pid_t,
	action: impl FnOnce(TargetVisit<'_>) -> CoreResult<T>,
) -> CoreResult<T> {
	control::check()?;
	let spi = FOREGROUND.as_ref().ok_or_else(|| {
		DesktopError::background_unavailable(
			"focus-restoration SPI is unavailable; use ax actions that do not activate the app or \
			 takeover:true",
		)
	})?;
	let previous = front_process(spi.get_front).ok_or_else(|| {
		DesktopError::background_unavailable(
			"cannot establish the current front process before background input; retry with \
			 takeover:true",
		)
	})?;
	if previous.pid == Some(pid) {
		return action(TargetVisit::none());
	}
	let target = process_psn(spi.psn, pid, 0).ok_or_else(|| {
		DesktopError::background_unavailable(
			"cannot resolve the background target process; retry with takeover:true or use ax actions",
		)
	})?;
	let previous_key = previous
		.pid
		.and_then(restoration_key)
		.ok_or_else(|| {
			DesktopError::background_unavailable(
				"cannot establish the user's key window for background focus restoration; retry with \
				 takeover:true or use ax actions",
			)
		})?
		.window();
	let mut lease = BackgroundFocusLease {
		previous: previous.psn,
		target,
		key: previous_key,
		activity: activation_activity(),
		click_polls: 0,
		disarmed: false,
		visited: false,
	};
	let stopped = AtomicBool::new(false);
	let visited = AtomicBool::new(false);
	thread::scope(|scope| {
		let stop = &stopped;
		let visit = &visited;
		let observer = thread::Builder::new()
			.name("desktop-focus-lease".to_string())
			.spawn_scoped(scope, move || -> CoreResult<()> {
				let mut restored = false;
				loop {
					// Once disarmed, nothing is sent back any more, but the lease
					// keeps watching for the user coming to the target.
					match front_process(spi.get_front) {
						None if lease.disarmed => {},
						None => {
							return Err(DesktopError::input_failed(
								"lost the front process during background input",
							));
						},
						Some(front) => {
							let key = if !lease.disarmed && front.psn == previous.psn {
								previous.pid.and_then(ax::key_window_id)
							} else {
								None
							};
							if lease.observe(front.psn, key, activation_activity())
								== FocusDecision::Restore
							{
								// Re-check immediately before changing focus: an AX
								// probe may have raced a newer application or hardware
								// event. `WindowServer` then refuses the hand-back if
								// the user pressed a key or clicked after the re-check
								// began.
								let handed_back = request_after_check(
									event_clock_now,
									|| {
										front_process(spi.get_front).is_some_and(|front| front.psn == target)
											&& activation_activity() == lease.activity
									},
									|since| {
										set_front_unless_user_acted(
											spi,
											previous.psn,
											previous_key.unwrap_or(0),
											since,
										)
									},
								)?;
								match handed_back {
									None => {},
									// The user brought the target forward themselves.
									Some(FrontRequest::UserActed) => lease.user_acted(),
									Some(FrontRequest::Done) => {
										restored = true;
										if let Some(key) = previous_key
											&& !post_record(spi.post_record, previous.psn, &focus_record(key))
										{
											return Err(DesktopError::input_failed(
												"background key-window restoration was rejected",
											));
										}
									},
								}
							}
						},
					}
					visit.store(lease.visited, Ordering::Release);
					if stop.load(Ordering::Acquire) {
						if restored
							&& !lease.disarmed
							&& front_process(spi.get_front).is_some_and(|front| front.psn == target)
						{
							return Err(DesktopError::input_failed(
								"the background target reactivated after focus restoration; input may \
								 already have landed; inspect the desktop and use takeover:true or ax \
								 actions",
							));
						}
						return Ok(());
					}
					thread::park_timeout(ACTIVATION_POLL);
				}
			})
			.map_err(|error| {
				DesktopError::background_unavailable(format!(
					"could not start the background focus guard: {error}; retry with takeover:true or \
					 use ax actions"
				))
			})?;
		struct StopObserver<'a> {
			stopped: &'a AtomicBool,
			thread:  thread::Thread,
		}
		impl Drop for StopObserver<'_> {
			fn drop(&mut self) {
				self.stopped.store(true, Ordering::Release);
				self.thread.unpark();
			}
		}
		let stop = StopObserver { stopped: &stopped, thread: observer.thread().clone() };
		let result =
			run_then_settle(|| action(TargetVisit(&visited)), || control::wait(BACKGROUND_SETTLE));
		drop(stop);
		let cleanup = observer.join().unwrap_or_else(|_| {
			Err(DesktopError::input_failed("background focus guard terminated unexpectedly"))
		});
		after_cleanup(result, cleanup)
	})
}

/// Runs a guarded action, then the settle during which the guard still sends
/// back an app the action brought forward. The settle follows a failed action
/// too: an AX action can report an error and still activate its app, as
/// `AXOpen` on a file in Chrome's Open panel fails with -25205 within 20 ms
/// and Chrome comes to the front some 20 ms later. The action's own error wins
/// over the settle's.
fn run_then_settle<T>(
	action: impl FnOnce() -> CoreResult<T>,
	settle: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<T> {
	let result = action();
	let settled = settle();
	result.and_then(|value| settled.map(|()| value))
}

fn set_front(spi: &ForegroundSpi, psn: ProcessSerialNumber, wid: u32) -> CoreResult<()> {
	control::check()?;
	// SAFETY: The PSN was resolved from WindowServer. kCPSNoWindows changes
	// only the front process; no activate-all-windows fallback is permitted.
	if unsafe { (spi.set_front)(&psn, wid, CPS_NO_WINDOWS) } != 0 {
		return Err(DesktopError::input_failed(
			"WindowServer rejected front-process restoration/activation",
		));
	}
	Ok(())
}

/// What a front-process request through [`set_front_unless_user_acted`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FrontRequest {
	Done,
	/// `WindowServer` refused it: the user pressed a key or clicked after its
	/// timestamp, so the front application is theirs.
	UserActed,
}

/// Now on the clock `WindowServer` compares a front-process request's
/// timestamp with: nanoseconds of `CLOCK_UPTIME_RAW`.
fn event_clock_now() -> u64 {
	let mut time = libc::timespec { tv_sec: 0, tv_nsec: 0 };
	// SAFETY: `time` is writable for the call; CLOCK_UPTIME_RAW is a clock
	// every supported macOS provides, and the call retains no pointer.
	unsafe { libc::clock_gettime(libc::CLOCK_UPTIME_RAW, &raw mut time) };
	u64::try_from(time.tv_sec).unwrap_or(0) * 1_000_000_000
		+ u64::try_from(time.tv_nsec).unwrap_or(0)
}

/// Runs `request` with a timestamp taken from `now` before `still_ours`
/// confirms the hand-back is still wanted; `None` when it no longer is.
/// `WindowServer` refuses the request if the user pressed a key or clicked
/// after that timestamp, so input arriving between the check and the request
/// vetoes it as well.
fn request_after_check(
	now: impl FnOnce() -> u64,
	still_ours: impl FnOnce() -> bool,
	request: impl FnOnce(u64) -> CoreResult<FrontRequest>,
) -> CoreResult<Option<FrontRequest>> {
	let since = now();
	if !still_ours() {
		return Ok(None);
	}
	request(since).map(Some)
}

/// Makes `psn` the front process unless the user pressed a key or clicked
/// after `since` ([`event_clock_now`]). `WindowServer` decides on its own
/// event clock, so polling delays cannot hide that input; events posted to a
/// process, as background input is, do not count. Where the conditional
/// request is unavailable, the front process changes unconditionally.
fn set_front_unless_user_acted(
	spi: &ForegroundSpi,
	psn: ProcessSerialNumber,
	wid: u32,
	since: u64,
) -> CoreResult<FrontRequest> {
	let Some(conditional) = spi.conditional else {
		return set_front(spi, psn, wid).map(|()| FrontRequest::Done);
	};
	control::check()?;
	let timestamp = CFNumber::new_i64(i64::try_from(since).unwrap_or(i64::MAX));
	// SAFETY: `timestamp_key` is SkyLight's process-lived CFString constant.
	let key = unsafe { &*conditional.timestamp_key };
	let info = CFDictionary::<CFString, CFNumber>::from_slices(&[key], &[&*timestamp]);
	// SAFETY: The PSN was resolved from WindowServer and `info` stays alive
	// for the synchronous call. kCPSNoWindows changes only the front process.
	let status =
		unsafe { (conditional.set_front)(&psn, wid, CPS_NO_WINDOWS, ptr::from_ref(&*info).cast()) };
	front_request(status)
}

fn front_request(status: i32) -> CoreResult<FrontRequest> {
	match status {
		0 => Ok(FrontRequest::Done),
		EXPIRED_FRONT_REQUEST => Ok(FrontRequest::UserActed),
		_ => Err(DesktopError::input_failed(
			"WindowServer rejected front-process restoration/activation",
		)),
	}
}

/// What the user's front application gets back after input elsewhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UserKey {
	Window(u32),
	/// It provably shows no window, as Finder after a click on the desktop or
	/// an app that just closed its last window: only the front process is
	/// restored.
	Windowless,
}

impl UserKey {
	const fn window(self) -> Option<u32> {
		match self {
			Self::Window(id) => Some(id),
			Self::Windowless => None,
		}
	}
}

/// The front application `pid`'s [`UserKey`]; `None` when neither its key
/// window nor its windowlessness can be established.
fn restoration_key(pid: pid_t) -> Option<UserKey> {
	restorable_key(
		ax::key_window_id(pid),
		|| ax::window_records(pid).map(|records| records.iter().any(|record| record.id.is_some())),
		|| capture::has_onscreen_window(pid),
	)
}

/// [`restoration_key`]'s decision: an app with no key window counts as
/// windowless only when both its accessibility windows (Finder's unmappable
/// desktop entry aside) and `WindowServer`'s on-screen list show none of its
/// windows. An unreadable answer from either refuses.
fn restorable_key(
	key: Option<u32>,
	ax_lists_window: impl FnOnce() -> Option<bool>,
	shows_window: impl FnOnce() -> Option<bool>,
) -> Option<UserKey> {
	if let Some(key) = key {
		return Some(UserKey::Window(key));
	}
	(ax_lists_window() == Some(false) && shows_window() == Some(false))
		.then_some(UserKey::Windowless)
}

/// Makes `wid` the frontmost key window, runs `action`, then restores the
/// previous front process (or, within one process, its previous key window).
///
/// `action` receives whether focus actually moved, so keyboard delivery can
/// give a just-activated surface time to arm its input handling. A target that
/// already is the key window of the front process is not re-activated:
/// re-activating it can clear Chromium's renderer focus. The window is made
/// key without being raised; callers that need it unobstructed raise it.
pub(super) fn with_foreground<T>(
	pid: pid_t,
	wid: u32,
	action: impl FnOnce(bool) -> CoreResult<T>,
) -> CoreResult<T> {
	control::check()?;
	let activity = control::user_activity();
	let spi = FOREGROUND.as_ref().ok_or_else(|| {
		DesktopError::input_failed("exact-window takeover SPI is unavailable; no input was sent")
	})?;
	let previous = front_process(spi.get_front).ok_or_else(|| {
		DesktopError::input_failed(
			"cannot identify the front process for takeover restoration; no input was sent",
		)
	})?;
	let target = process_psn(spi.psn, pid, wid).ok_or_else(|| {
		DesktopError::input_failed("cannot resolve the exact takeover target; no input was sent")
	})?;
	let focused = ax::focused_window_id(pid);
	if preserves_exact_existing_focus(Some(previous.psn), target, focused, wid) {
		return action(false).and_then(|value| control::wait(FOREGROUND_SETTLE).map(|()| value));
	}
	let previous_pid = previous.pid.ok_or_else(|| {
		DesktopError::input_failed(
			"cannot identify the previous application for takeover restoration; no input was sent",
		)
	})?;
	let previous_key = restoration_key(previous_pid)
		.ok_or_else(|| {
			DesktopError::input_failed(
				"cannot identify the previous key window for takeover restoration; no input was sent",
			)
		})?
		.window();
	let restore = |preparation_failed: bool| {
		if control::user_activity() != activity {
			return Ok(());
		}
		let front = front_process(spi.get_front).ok_or_else(|| {
			DesktopError::input_failed("cannot establish current focus for takeover restoration")
		})?;
		// A user-selected third app or sibling window must not be overwritten.
		if front.psn != target {
			return Ok(());
		}
		if ax::focused_window_id(pid)
			.is_some_and(|key| key != wid && (!preparation_failed || Some(key) != focused))
		{
			return Ok(());
		}
		if control::user_activity() != activity
			|| !front_process(spi.get_front).is_some_and(|front| front.psn == target)
		{
			return Ok(());
		}
		set_front(spi, previous.psn, previous_key.unwrap_or(0))?;
		// A previous app that showed no window gets only its front status back.
		let Some(previous_key) = previous_key else {
			return Ok(());
		};
		// Returning to an app often reinstates its original key window by
		// itself. Re-making an already-key Chromium window can clear the user's
		// renderer focus, just as reactivating an already-key input target can.
		if ax::focused_window_id(previous_pid) != Some(previous_key) {
			make_exact_window_key(spi, previous.psn, previous_key)?;
		}
		await_window_focused(spi, previous_pid, previous_key, previous.psn)
	};
	let prepare = set_front(spi, target, wid)
		.and_then(|()| make_exact_window_key(spi, target, wid))
		.and_then(|()| await_window_focused(spi, pid, wid, target));
	if let Err(error) = prepare {
		return after_cleanup(Err(error), control::cleanup(|| restore(true)));
	}
	let result = action(true).and_then(|value| control::wait(FOREGROUND_SETTLE).map(|()| value));
	after_cleanup(result, control::cleanup(|| restore(false)))
}

pub(super) fn require_front_window(pid: pid_t, wid: u32) -> CoreResult<()> {
	control::check()?;
	if is_front_window(pid, wid) {
		Ok(())
	} else {
		Err(DesktopError::input_failed(format!(
			"takeover window {wid} lost exact keyboard focus; stopped input, which may be partial; \
			 inspect the target before retrying"
		)))
	}
}

pub(super) fn is_front_window(pid: pid_t, wid: u32) -> bool {
	FOREGROUND.as_ref().is_some_and(|spi| {
		front_process(spi.get_front).is_some_and(|front| front.pid == Some(pid))
			&& ax::focused_window_id(pid) == Some(wid)
	})
}

/// Read-only focus identity used to verify non-activating Space operations.
pub(super) fn front_window_context() -> Option<(pid_t, u32)> {
	let spi = FOREGROUND.as_ref()?;
	let pid = front_process(spi.get_front)?.pid?;
	Some((pid, ax::key_window_id(pid)?))
}

/// The front process's pid as `WindowServer` reports it.
pub(super) fn front_pid() -> Option<pid_t> {
	front_process(FOREGROUND.as_ref()?.get_front)?.pid
}

type SLSWindowQueryWindowsFn = unsafe extern "C" fn(i32, &CFArray, u32) -> *mut CFType;
type SLSWindowQueryResultCopyWindowsFn = unsafe extern "C" fn(&CFType) -> *mut CFType;
type SLSWindowIteratorAdvanceFn = unsafe extern "C" fn(&CFType) -> bool;
type SLSWindowIteratorGetIdFn = unsafe extern "C" fn(&CFType) -> u32;

#[derive(Clone, Copy)]
struct WindowQuerySpi {
	connection: CGSMainConnectionIDFn,
	query:      SLSWindowQueryWindowsFn,
	windows:    SLSWindowQueryResultCopyWindowsFn,
	advance:    SLSWindowIteratorAdvanceFn,
	window_id:  SLSWindowIteratorGetIdFn,
	parent_id:  SLSWindowIteratorGetIdFn,
}

static WINDOW_QUERY: LazyLock<Option<WindowQuerySpi>> = LazyLock::new(|| {
	route::load_skylight()?;
	Some(WindowQuerySpi {
		connection: symbol(c"CGSMainConnectionID")?,
		query:      symbol(c"SLSWindowQueryWindows")?,
		windows:    symbol(c"SLSWindowQueryResultCopyWindows")?,
		advance:    symbol(c"SLSWindowIteratorAdvance")?,
		window_id:  symbol(c"SLSWindowIteratorGetWindowID")?,
		parent_id:  symbol(c"SLSWindowIteratorGetParentID")?,
	})
});

/// The window `wid` is a child of in `WindowServer`, such as the window a
/// sheet or an inline editor's overlay is attached to; `None` for a top-level
/// window or when the query is unavailable.
pub(super) fn window_parent(wid: u32) -> Option<u32> {
	let spi = WINDOW_QUERY.as_ref()?;
	let number = CFNumber::new_i64(i64::from(wid));
	let windows = CFArray::from_objects(&[&*number]);
	// SAFETY: The no-argument connection query has its exact signature.
	let connection = unsafe { (spi.connection)() } as i32;
	// SAFETY: `windows` holds one CFNumber window id and outlives the call; the
	// result is a create-rule object or null.
	let query = retained(unsafe { (spi.query)(connection, windows.as_opaque(), 0) })?;
	// SAFETY: `query` is a live window query; the result is create-rule or null.
	let iterator = retained(unsafe { (spi.windows)(&query) })?;
	// SAFETY: `iterator` stays retained across every iterator call.
	while unsafe { (spi.advance)(&iterator) } {
		// SAFETY: As above; the iterator was advanced onto a window.
		if unsafe { (spi.window_id)(&iterator) } == wid {
			// SAFETY: As above.
			return Some(unsafe { (spi.parent_id)(&iterator) }).filter(|&parent| parent != 0);
		}
	}
	None
}

type SLSConnectionGetPIDFn = unsafe extern "C" fn(u32, *mut pid_t) -> i32;

#[derive(Clone, Copy)]
struct WindowOwnerSpi {
	connection: CGSMainConnectionIDFn,
	owner:      SLSGetWindowOwnerFn,
	pid:        SLSConnectionGetPIDFn,
}

static WINDOW_OWNER: LazyLock<Option<WindowOwnerSpi>> = LazyLock::new(|| {
	route::load_skylight()?;
	Some(WindowOwnerSpi {
		connection: symbol(c"CGSMainConnectionID")?,
		owner:      symbol(c"SLSGetWindowOwner")?,
		pid:        symbol(c"SLSConnectionGetPID")?,
	})
});

/// The process that owns window `wid` in `WindowServer`, including the
/// windows a remote-view service keeps off the window list, such as the one
/// `openAndSavePanelService` draws an application's Open panel in.
pub(super) fn window_owner_pid(wid: u32) -> Option<pid_t> {
	let spi = WINDOW_OWNER.as_ref()?;
	let mut owner = 0u32;
	// SAFETY: The connection query takes no arguments, and `owner` is writable
	// for the exact window-owner signature.
	if unsafe { (spi.owner)((spi.connection)(), wid, &mut owner) } != 0 || owner == 0 {
		return None;
	}
	let mut pid: pid_t = 0;
	// SAFETY: `pid` is writable for the exact connection-pid signature.
	(unsafe { (spi.pid)(owner, &mut pid) } == 0 && pid > 0).then_some(pid)
}

/// Takes ownership of a create-rule `CFType` pointer, which may be null.
fn retained(pointer: *mut CFType) -> Option<CFRetained<CFType>> {
	// SAFETY: Every caller passes the +1 result of a copy or create call.
	ptr::NonNull::new(pointer).map(|pointer| unsafe { CFRetained::from_raw(pointer) })
}

/// Whether the target already is the key window of the front process.
fn preserves_exact_existing_focus(
	previous: Option<ProcessSerialNumber>,
	target: ProcessSerialNumber,
	focused: Option<u32>,
	wid: u32,
) -> bool {
	previous == Some(target) && focused == Some(wid)
}

/// Makes exactly `wid` the native key window of its front process without
/// raising it.
///
/// `AXFocusedWindow` can change without `AppKit` making the matching
/// `NSWindow` key, and menu validation and first-responder installation follow
/// the latter. This marks the front-process request as user generated and
/// posts the paired make-key records for the one window.
fn make_exact_window_key(
	spi: &ForegroundSpi,
	target: ProcessSerialNumber,
	wid: u32,
) -> CoreResult<()> {
	control::check()?;
	// SAFETY: Target PSN is valid and kCPSUserGenerated only changes how the
	// request is attributed.
	if unsafe { (spi.set_front)(&target, wid, CPS_USER_GENERATED) } != 0 {
		return Err(DesktopError::input_failed(format!(
			"window {wid} rejected exact key-window activation"
		)));
	}
	for kind in [0x01, 0x02] {
		if !post_record(spi.post_record, target, &make_key_record(wid, kind)) {
			return Err(DesktopError::input_failed(format!(
				"window {wid} rejected its make-key record"
			)));
		}
	}
	Ok(())
}

/// Waits until `wid` is its application's focused window.
///
/// Global HID input goes to whichever window is key, so a target that still
/// reports another focused window at the deadline refuses before any input is
/// sent. A front process alone is not proof of the exact key window.
fn await_window_focused(
	spi: &ForegroundSpi,
	pid: pid_t,
	wid: u32,
	target: ProcessSerialNumber,
) -> CoreResult<()> {
	let deadline = Instant::now() + ACTIVATION_TIMEOUT;
	loop {
		let focused = ax::focused_window_id(pid);
		let target_front = front_process(spi.get_front).is_some_and(|front| front.psn == target);
		if focused == Some(wid) && target_front {
			return Ok(());
		}
		if Instant::now() >= deadline {
			return Err(DesktopError::input_failed(format!(
				"window {wid} could not be confirmed as the exact frontmost key window",
			)));
		}
		control::wait(ACTIVATION_POLL)?;
	}
}

fn process_psn(lookup: PsnLookup, pid: pid_t, wid: u32) -> Option<ProcessSerialNumber> {
	if let (Some(main_connection), Some(get_window_owner), Some(get_connection_psn)) =
		(lookup.main_connection, lookup.get_window_owner, lookup.get_connection_psn)
	{
		// SAFETY: The no-argument connection query was resolved with its exact
		// signature.
		let main_connection = unsafe { main_connection() };
		let mut owner_connection = 0u32;
		// SAFETY: `owner_connection` is writable for the synchronous lookup.
		if unsafe { get_window_owner(main_connection, wid, &mut owner_connection) } == 0
			&& owner_connection != 0
		{
			let mut psn = ProcessSerialNumber::default();
			// SAFETY: `psn` is writable and has the exact 8-byte layout required
			// by the SPI.
			if unsafe { get_connection_psn(owner_connection, &mut psn) } == 0 {
				return Some(psn);
			}
		}
	}
	let fallback = lookup.get_process_for_pid?;
	let mut psn = ProcessSerialNumber::default();
	// SAFETY: `psn` is writable and `fallback` was resolved with the exact
	// GetProcessForPID ABI.
	if unsafe { fallback(pid, &mut psn) } == 0 {
		Some(psn)
	} else {
		None
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::desktop::error::ErrorCode;

	#[test]
	fn user_focus_changes_permanently_disarm_background_restoration() {
		let previous = ProcessSerialNumber { high: 0, low: 7 };
		let target = ProcessSerialNumber { high: 0, low: 8 };
		let third = ProcessSerialNumber { high: 0, low: 9 };
		let lease = || BackgroundFocusLease {
			previous,
			target,
			key: Some(42),
			activity: [0; 5],
			click_polls: 0,
			disarmed: false,
			visited: false,
		};
		let mut guard = lease();
		assert_eq!(guard.observe(target, None, [0; 5]), FocusDecision::Restore);
		assert_eq!(guard.observe(third, None, [0; 5]), FocusDecision::Disarm);
		assert_eq!(guard.observe(target, None, [0; 5]), FocusDecision::Disarm);

		let mut guard = lease();
		assert_eq!(guard.observe(previous, Some(43), [0; 5]), FocusDecision::Disarm);
		assert_eq!(guard.observe(target, None, [0; 5]), FocusDecision::Disarm);

		let mut guard = lease();
		assert_eq!(guard.observe(target, None, [1; 5]), FocusDecision::Disarm);
	}

	#[test]
	fn typing_in_the_original_window_does_not_claim_a_user_focus_switch() {
		let previous = ProcessSerialNumber { high: 0, low: 7 };
		let target = ProcessSerialNumber { high: 0, low: 8 };
		let mut guard = BackgroundFocusLease {
			previous,
			target,
			key: Some(42),
			activity: [0; 5],
			click_polls: 0,
			disarmed: false,
			visited: false,
		};
		// Key and modifier presses only.
		let typed = [0, 0, 0, 1, 1];
		assert_eq!(guard.observe(previous, Some(42), typed), FocusDecision::Observe);
		assert_eq!(guard.observe(target, None, typed), FocusDecision::Restore);
	}

	#[test]
	fn a_click_seen_just_before_the_target_comes_forward_is_the_users() {
		// The user clicks the target window: the poll sees the click while
		// their app (7) is still in front, and the target (8) in front on a
		// later poll with no further input. Sending it back would undo the
		// user's own switch.
		let previous = ProcessSerialNumber { high: 0, low: 7 };
		let target = ProcessSerialNumber { high: 0, low: 8 };
		let lease = || BackgroundFocusLease {
			previous,
			target,
			key: Some(42),
			activity: [0; 5],
			click_polls: 0,
			disarmed: false,
			visited: false,
		};
		let clicked = [1, 0, 0, 0, 0];
		let mut guard = lease();
		assert_eq!(guard.observe(previous, Some(42), clicked), FocusDecision::Observe);
		assert_eq!(guard.observe(previous, Some(42), clicked), FocusDecision::Observe);
		assert_eq!(guard.observe(target, None, clicked), FocusDecision::Disarm);
		assert!(guard.visited);
		// Long after that click, the target's own activation is sent back.
		let mut guard = lease();
		guard.observe(previous, Some(42), clicked);
		for _ in 0..CLICK_SWITCH_POLLS {
			guard.observe(previous, Some(42), clicked);
		}
		assert_eq!(guard.observe(target, None, clicked), FocusDecision::Restore);
	}

	#[test]
	fn a_window_appearing_in_a_windowless_front_app_is_a_user_focus_change() {
		// Finder in front after a click on the desktop: no key window to restore.
		let previous = ProcessSerialNumber { high: 0, low: 7 };
		let target = ProcessSerialNumber { high: 0, low: 8 };
		let lease = || BackgroundFocusLease {
			previous,
			target,
			key: None,
			activity: [0; 5],
			click_polls: 0,
			disarmed: false,
			visited: false,
		};
		let mut guard = lease();
		assert_eq!(guard.observe(previous, None, [0; 5]), FocusDecision::Observe);
		assert_eq!(guard.observe(target, None, [0; 5]), FocusDecision::Restore);

		// The user opened a Finder window meanwhile: hands off.
		let mut guard = lease();
		assert_eq!(guard.observe(previous, Some(43), [0; 5]), FocusDecision::Disarm);
		assert_eq!(guard.observe(target, None, [0; 5]), FocusDecision::Disarm);
	}

	#[test]
	fn a_visit_to_the_target_is_kept_after_the_user_leaves_it() {
		let previous = ProcessSerialNumber { high: 0, low: 7 };
		let target = ProcessSerialNumber { high: 0, low: 8 };
		let third = ProcessSerialNumber { high: 0, low: 9 };
		let lease = || BackgroundFocusLease {
			previous,
			target,
			key: Some(42),
			activity: [0; 5],
			click_polls: 0,
			disarmed: false,
			visited: false,
		};
		// The user clicks the target, then goes back to their app.
		let mut guard = lease();
		guard.observe(target, None, [1; 5]);
		guard.observe(previous, Some(42), [1; 5]);
		assert!(guard.visited);
		// After a switch to a third app the lease stands down, yet still sees
		// the user come to the target.
		let mut guard = lease();
		guard.observe(third, None, [0; 5]);
		assert!(!guard.visited);
		guard.observe(target, None, [0; 5]);
		assert!(guard.visited);
		// The target's own activation, sent back, is not a visit; a refused
		// hand-back is.
		let mut guard = lease();
		assert_eq!(guard.observe(target, None, [0; 5]), FocusDecision::Restore);
		assert!(!guard.visited);
		guard.user_acted();
		assert!(guard.visited);
	}

	#[test]
	fn only_a_provably_windowless_front_app_is_restored_without_a_key_window() {
		let unread = || -> Option<bool> { panic!("a known key window needs no window scan") };
		assert_eq!(restorable_key(Some(42), unread, unread), Some(UserKey::Window(42)));
		// TextEdit after closing its last document; Finder after a desktop click
		// lists only its unmappable desktop, which counts as no window.
		assert_eq!(restorable_key(None, || Some(false), || Some(false)), Some(UserKey::Windowless));
		// Windows that AX or WindowServer reports, or an unreadable answer,
		// refuse.
		assert_eq!(restorable_key(None, || Some(true), || Some(false)), None);
		assert_eq!(restorable_key(None, || Some(false), || Some(true)), None);
		assert_eq!(restorable_key(None, || None, || Some(false)), None);
		assert_eq!(restorable_key(None, || Some(false), || None), None);
	}

	#[test]
	fn a_failed_action_still_settles_under_the_guard() {
		// AXOpen in Chrome's Open panel fails with -25205, then Chrome comes
		// forward: the guard must still be watching.
		let mut settled = false;
		let result: CoreResult<()> = run_then_settle(
			|| Err(DesktopError::ax_failed("AX action 'AXOpen' failed (AXError(-25205))")),
			|| {
				settled = true;
				Err(DesktopError::cancelled("stopped"))
			},
		);
		assert!(settled);
		let error = result.expect_err("the action failed");
		assert_eq!(
			(error.code, error.message.as_str()),
			(ErrorCode::AxFailed, "AX action 'AXOpen' failed (AXError(-25205))")
		);

		let result = run_then_settle(|| Ok(7), || Err(DesktopError::cancelled("stopped")));
		assert_eq!(result.expect_err("the settle was cancelled").code, ErrorCode::Cancelled);
		assert_eq!(run_then_settle(|| Ok(7), || Ok(())).ok(), Some(7));
	}

	#[test]
	fn only_the_exact_key_window_of_the_front_process_skips_activation() {
		let target = ProcessSerialNumber { high: 0, low: 7 };
		let other = ProcessSerialNumber { high: 0, low: 8 };
		assert!(preserves_exact_existing_focus(Some(target), target, Some(42), 42));
		assert!(!preserves_exact_existing_focus(Some(other), target, Some(42), 42));
		assert!(!preserves_exact_existing_focus(Some(target), target, Some(41), 42));
		assert!(!preserves_exact_existing_focus(Some(target), target, None, 42));
		assert!(!preserves_exact_existing_focus(None, target, Some(42), 42));
	}

	#[test]
	fn the_hand_back_timestamp_precedes_the_last_check() {
		use std::cell::RefCell;
		let steps = RefCell::new(Vec::new());
		let handed = request_after_check(
			|| {
				steps.borrow_mut().push("clock");
				7
			},
			|| {
				steps.borrow_mut().push("check");
				true
			},
			|since| {
				steps.borrow_mut().push("request");
				assert_eq!(since, 7, "the request carries the timestamp taken before the check");
				Ok(FrontRequest::UserActed)
			},
		);
		assert_eq!(handed.ok(), Some(Some(FrontRequest::UserActed)));
		assert_eq!(*steps.borrow(), ["clock", "check", "request"]);

		let unwanted =
			request_after_check(|| 7, || false, |_| panic!("no request once the check fails"));
		assert_eq!(unwanted.ok(), Some(None));
	}

	#[test]
	fn a_front_request_the_user_overtook_is_their_choice_not_an_error() {
		assert_eq!(front_request(0).ok(), Some(FrontRequest::Done));
		assert_eq!(front_request(EXPIRED_FRONT_REQUEST).ok(), Some(FrontRequest::UserActed));
		assert_eq!(
			front_request(-1)
				.expect_err("other failures stay errors")
				.code,
			ErrorCode::InputFailed
		);
	}
}
