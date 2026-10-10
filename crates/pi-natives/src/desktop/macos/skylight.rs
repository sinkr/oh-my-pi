use std::{
	ffi::{CStr, c_void},
	mem,
	os::raw::{c_char, c_int, c_uint},
	ptr,
	sync::{
		LazyLock,
		atomic::{AtomicBool, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use core_graphics::{
	event::CGEvent,
	event_source::{CGEventSource, CGEventSourceStateID},
	geometry::CGPoint,
};
use foreign_types::ForeignType;
use libc::pid_t;
use objc2_core_foundation::{CFArray, CFDictionary, CFNumber, CFRetained, CFString, CFType};

use super::{
	super::{
		control,
		error::{CoreResult, DesktopError},
	},
	ax, capture,
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
/// How recent a mouse click or ⌘/⌃/⌥ chord must be for a target activation to
/// count as the user's own switch. Measured on a VM: ⌘-Tab activates the chosen
/// app about 3 ms after ⌘ is released, at most one poll after the guard last
/// saw ⌘ held.
const USER_SWITCH_WINDOW: Duration = Duration::from_millis(250);
/// Keeps the target frontmost until it has consumed foreground input.
const FOREGROUND_SETTLE: Duration = Duration::from_millis(40);
/// `SLSSetFrontProcessWithInfo`'s result when a user key press or click was
/// dispatched after the request's timestamp.
const EXPIRED_FRONT_REQUEST: i32 = -13066;

unsafe extern "C" {
	fn CGEventSourceCounterForEventType(state: i32, event_type: u32) -> u32;
	fn CGEventSourceFlagsState(state: i32) -> u64;
	fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
}

#[repr(C)]
#[derive(Clone, Copy, Default, PartialEq, Eq)]
struct ProcessSerialNumber {
	high: u32,
	low:  u32,
}

type SLEventPostToPidFn = unsafe extern "C" fn(pid_t, *mut c_void);
type SLEventSetIntegerValueFieldFn = unsafe extern "C" fn(*mut c_void, u32, i64);
type SLPSPostEventRecordToFn = unsafe extern "C" fn(*const ProcessSerialNumber, *const u8) -> i32;
type SLPSGetFrontProcessFn = unsafe extern "C" fn(*mut ProcessSerialNumber) -> i32;
/// Writes the process holding keyboard focus and a status byte.
type SLPSGetKeyFocusProcessFn = unsafe extern "C" fn(*mut ProcessSerialNumber, *mut u8) -> i32;
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
type SLEventSetAuthenticationMessageFn = unsafe extern "C" fn(*mut c_void, *mut c_void);
type ObjcGetClassFn = unsafe extern "C" fn(*const c_char) -> *mut c_void;
type SelRegisterNameFn = unsafe extern "C" fn(*const c_char) -> *mut c_void;
type ClassRespondsToSelectorFn = unsafe extern "C" fn(*mut c_void, *mut c_void) -> bool;
type AuthenticationFactoryFn =
	unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, c_int, c_uint) -> *mut c_void;

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
	post_to_pid:         SLEventPostToPidFn,
	/// `CGEventPostToPid` when it is a separate implementation; `None` where
	/// it re-exports `SLEventPostToPid` (as on macOS 26), since posting
	/// through both would then deliver every event twice.
	public_post_to_pid:  Option<SLEventPostToPidFn>,
	set_integer:         SLEventSetIntegerValueFieldFn,
	set_window_location: CGEventSetWindowLocationFn,
	main_connection:     CGSMainConnectionIDFn,
}

#[derive(Clone, Copy)]
struct ForegroundSpi {
	set_front:     SLPSSetFrontProcessWithOptionsFn,
	get_front:     SLPSGetFrontProcessFn,
	/// Differs from the front process while a panel of another process, such
	/// as Spotlight or a launcher, has the keyboard.
	get_key_focus: Option<SLPSGetKeyFocusProcessFn>,
	post_record:   SLPSPostEventRecordToFn,
	psn:           PsnLookup,
	conditional:   Option<ConditionalFront>,
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

#[derive(Clone, Copy)]
struct AuthenticationSpi {
	set_message:       SLEventSetAuthenticationMessageFn,
	objc_get_class:    ObjcGetClassFn,
	sel_register_name: SelRegisterNameFn,
	class_responds:    ClassRespondsToSelectorFn,
	factory:           AuthenticationFactoryFn,
}

/// The front process as `WindowServer` reports it. Unlike
/// `NSWorkspace.frontmostApplication`, this does not depend on an `AppKit`
/// run loop in this process observing activation changes.
#[derive(Clone, Copy)]
struct FrontProcess {
	psn: ProcessSerialNumber,
	pid: Option<pid_t>,
}

static REQUIRED: LazyLock<Option<RequiredSpi>> = LazyLock::new(resolve_required);
static AUTHENTICATION: LazyLock<Option<AuthenticationSpi>> = LazyLock::new(resolve_authentication);
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
	ensure_skylight_loaded()?;
	let post_to_pid: SLEventPostToPidFn = symbol(c"SLEventPostToPid")?;
	Some(RequiredSpi {
		post_to_pid,
		public_post_to_pid: symbol::<SLEventPostToPidFn>(c"CGEventPostToPid")
			.filter(|public| *public as usize != post_to_pid as usize),
		set_integer: symbol(c"SLEventSetIntegerValueField")?,
		set_window_location: symbol(c"CGEventSetWindowLocation")?,
		main_connection: symbol(c"CGSMainConnectionID")?,
	})
}

fn resolve_foreground() -> Option<ForegroundSpi> {
	ensure_skylight_loaded()?;
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
		get_key_focus: symbol(c"SLPSGetKeyFocusProcess"),
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

pub(super) fn ensure_skylight_loaded() -> Option<()> {
	static LOADED: LazyLock<bool> = LazyLock::new(|| {
		let path = c"/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight";
		// SAFETY: `path` is a static NUL-terminated framework path; the handle is
		// intentionally process-lived.
		!unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_NOW | libc::RTLD_GLOBAL) }.is_null()
	});
	if *LOADED { Some(()) } else { None }
}

pub(super) fn symbol<T: Copy>(name: &CStr) -> Option<T> {
	// SAFETY: `name` is NUL-terminated and RTLD_DEFAULT is valid for
	// process-wide lookup.
	let raw = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
	if raw.is_null() {
		return None;
	}
	// SAFETY: Every callsite requests the exact C signature documented in its
	// function-pointer alias.
	Some(unsafe { mem::transmute_copy::<*mut c_void, T>(&raw) })
}

fn event_ptr(event: &CGEvent) -> *mut c_void {
	event.as_ptr().cast()
}

/// Stamps raw `SkyLight` integer event fields onto `event`.
pub(super) fn set_fields(event: &CGEvent, fields: &[(u32, i64)]) -> CoreResult<()> {
	let spi = required()?;
	let ptr = event_ptr(event);
	for &(field, value) in fields {
		// SAFETY: The event is alive for the call and `set_integer` passed the
		// atomic exact-signature probe.
		unsafe { (spi.set_integer)(ptr, field, value) };
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

/// Posts a pointer event through `SkyLight` alone, without the keyboard
/// authentication envelope, which would route it past the session event tap
/// Chromium's window handler listens on.
pub(super) fn post_routed(pid: pid_t, event: &CGEvent) -> CoreResult<()> {
	control::check()?;
	event.set_integer_value_field(
		core_graphics::event::EventField::EVENT_SOURCE_USER_DATA,
		control::SYNTHETIC_EVENT_TAG,
	);
	let spi = required()?;
	// SAFETY: `event` remains retained for the synchronous post and
	// `post_to_pid` was atomically resolved with its exact ABI.
	unsafe { (spi.post_to_pid)(pid, event_ptr(event)) };
	Ok(())
}

/// Posts a background pointer event through `SkyLight`, then through the
/// public per-pid queue only where `CGEventPostToPid` is a separate function.
/// Where it is not, a second post would deliver the event twice. The separate
/// public post is kept as it was; its benefit there is unmeasured.
pub(super) fn post_dual(pid: pid_t, event: &CGEvent) -> CoreResult<()> {
	let spi = required()?;
	post_routed(pid, event)?;
	if let Some(public_post_to_pid) = spi.public_post_to_pid {
		control::check()?;
		// SAFETY: `event` remains retained for the synchronous post and the
		// symbol was resolved with the `SLEventPostToPid` ABI it shares.
		unsafe { public_post_to_pid(pid, event_ptr(event)) };
	}
	Ok(())
}

pub(super) fn post_keyboard(pid: pid_t, event: &CGEvent) -> CoreResult<()> {
	control::check()?;
	event.set_integer_value_field(
		core_graphics::event::EventField::EVENT_SOURCE_USER_DATA,
		control::SYNTHETIC_EVENT_TAG,
	);
	let spi = required()?;
	attach_keyboard_authentication(pid, event);
	// The authenticated SkyLight route reaches Chromium and AppKit. Posting the
	// same event through the public per-pid queue as well would deliver every
	// key twice. SAFETY: `event` remains retained and the exact symbol is part
	// of the required atomic probe.
	unsafe { (spi.post_to_pid)(pid, event_ptr(event)) };
	Ok(())
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

/// `kCGEventSourceStateHIDSystemState`: input from hardware. Events posted to a
/// pid, as background input is, leave it unchanged.
const HID_SYSTEM_STATE: i32 = 1;
/// Left, right and other mouse button down and up (`CGEventType`).
const MOUSE_BUTTON_EVENTS: [u32; 6] = [1, 2, 3, 4, 25, 26];
/// ⌘, ⌥ and ⌃ (`kCGEventFlagMaskCommand | Alternate | Control`).
const SWITCH_MODIFIERS: u64 = 0x0010_0000 | 0x0008_0000 | 0x0004_0000;

/// What one poll reads of how the user could be switching apps. Typing, Shift
/// and Caps Lock pick no app, so none of them appear here.
#[derive(Clone, Copy)]
struct SwitchSignals {
	/// HID counters of `MOUSE_BUTTON_EVENTS`.
	buttons:    [u32; 6],
	/// When a mouse button last went down or up.
	last_click: Option<Instant>,
	/// A switch modifier is held now.
	chord:      bool,
	/// The process that has the keyboard.
	key_focus:  Option<ProcessSerialNumber>,
}

impl SwitchSignals {
	const fn new(
		buttons: [u32; 6],
		last_click: Option<Instant>,
		flags: u64,
		key_focus: Option<ProcessSerialNumber>,
	) -> Self {
		Self { buttons, last_click, chord: flags & SWITCH_MODIFIERS != 0, key_focus }
	}

	fn read(spi: &ForegroundSpi, now: Instant) -> Self {
		// SAFETY: HIDSystemState and these public CGEventType values are defined
		// by CGEventSource.h / CGEventTypes.h; these are read-only queries.
		let buttons = MOUSE_BUTTON_EVENTS.map(|event_type| unsafe {
			CGEventSourceCounterForEventType(HID_SYSTEM_STATE, event_type)
		});
		let last_click = MOUSE_BUTTON_EVENTS
			.into_iter()
			// SAFETY: as above.
			.map(|event_type| unsafe {
				CGEventSourceSecondsSinceLastEventType(HID_SYSTEM_STATE, event_type)
			})
			.filter_map(|seconds| Duration::try_from_secs_f64(seconds).ok())
			.min()
			.and_then(|since| now.checked_sub(since));
		// SAFETY: as above.
		let flags = unsafe { CGEventSourceFlagsState(HID_SYSTEM_STATE) };
		let key_focus = spi.get_key_focus.and_then(|get_key_focus| {
			let mut psn = ProcessSerialNumber::default();
			let mut status = 0u8;
			// SAFETY: Both out-pointers are writable for the synchronous call,
			// which writes the 8-byte PSN and one status byte.
			(unsafe { get_key_focus(&mut psn, &mut status) } == 0).then_some(psn)
		});
		Self::new(buttons, last_click, flags, key_focus)
	}
}

/// The process owning the element under the pointer, by the accessibility hit
/// test (which skips click-through overlays such as the Dock's full-screen
/// window): where a click seen by the poll right after it landed.
fn click_owner() -> Option<pid_t> {
	let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
	let point = CGEvent::new(source).ok()?.location();
	ax::point_owner(point.x, point.y).map(|owner| owner.pid)
}

/// How the user, rather than an app, changed the front app.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UserSwitch {
	/// A hardware mouse button went down or up outside the user's app: on
	/// another app's window, the Dock, the app switcher or a Spotlight result.
	Click,
	/// ⌘, ⌥ or ⌃ was held: ⌘-Tab, ⌘-H, Spaces, launcher hotkeys.
	Chord,
	/// Another process's panel had the keyboard, as Spotlight's does while the
	/// user types an app name and presses Return.
	Panel,
}

/// Answers "did the user switch apps on purpose since T, and how?" for an
/// action between the user's app and the `target`, whose own focus grabs are
/// not the user's doing. Clicks are timed exactly from the HID state and placed
/// by the window under the pointer when a poll sees them; a chord or panel is
/// seen only while it lasts, so callers poll more often than a ⌘-Tab holds ⌘
/// (about 100 ms).
struct UserSwitchWatch {
	user:     ProcessSerialNumber,
	user_pid: Option<pid_t>,
	target:   ProcessSerialNumber,
	buttons:  [u32; 6],
	click:    Option<Instant>,
	chord:    Option<Instant>,
	panel:    Option<Instant>,
}

impl UserSwitchWatch {
	/// Starts with the user's app in front at `now`; a click up to `lookback`
	/// earlier still counts.
	fn new(
		user: FrontProcess,
		target: ProcessSerialNumber,
		signals: SwitchSignals,
		now: Instant,
		lookback: Duration,
		click_owner: impl FnOnce() -> Option<pid_t>,
	) -> Self {
		let mut watch = Self {
			user: user.psn,
			user_pid: user.pid,
			target,
			buttons: signals.buttons,
			click: None,
			chord: None,
			panel: None,
		};
		if let Some(at) = signals
			.last_click
			.filter(|at| now.saturating_duration_since(*at) <= lookback)
		{
			watch.record_click(at, click_owner);
		}
		watch.observe_held(signals, user.psn, now);
		watch
	}

	fn observe(
		&mut self,
		signals: SwitchSignals,
		front: ProcessSerialNumber,
		now: Instant,
		click_owner: impl FnOnce() -> Option<pid_t>,
	) {
		if signals.buttons != self.buttons {
			self.buttons = signals.buttons;
			self.record_click(signals.last_click.unwrap_or(now), click_owner);
		}
		self.observe_held(signals, front, now);
	}

	/// A click on one of the user's own windows picks no other app; a click
	/// anywhere else, or one that cannot be placed, may.
	fn record_click(&mut self, at: Instant, click_owner: impl FnOnce() -> Option<pid_t>) {
		let owner = click_owner();
		if owner.is_none() || owner != self.user_pid {
			self.click = Some(at);
		}
	}

	fn observe_held(&mut self, signals: SwitchSignals, front: ProcessSerialNumber, now: Instant) {
		if signals.chord {
			self.chord = Some(now);
		}
		if signals
			.key_focus
			.is_some_and(|focus| focus != front && focus != self.user && focus != self.target)
		{
			self.panel = Some(now);
		}
	}

	/// The latest switch seen at or after `start`.
	fn since(&self, start: Instant) -> Option<UserSwitch> {
		[
			(self.click, UserSwitch::Click),
			(self.chord, UserSwitch::Chord),
			(self.panel, UserSwitch::Panel),
		]
		.into_iter()
		.filter_map(|(at, how)| at.filter(|at| *at >= start).map(|at| (at, how)))
		.max_by_key(|(at, _)| *at)
		.map(|(_, how)| how)
	}
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
	previous: ProcessSerialNumber,
	target:   ProcessSerialNumber,
	/// The user's key window; `None` when the front app showed no window.
	key:      Option<u32>,
	user:     UserSwitchWatch,
	disarmed: bool,
	/// The user came to the target ([`TargetVisit`]).
	visited:  bool,
}

impl BackgroundFocusLease {
	fn new(
		previous: FrontProcess,
		target: ProcessSerialNumber,
		key: Option<u32>,
		signals: SwitchSignals,
		now: Instant,
		click_owner: impl FnOnce() -> Option<pid_t>,
	) -> Self {
		let user =
			UserSwitchWatch::new(previous, target, signals, now, USER_SWITCH_WINDOW, click_owner);
		Self { previous: previous.psn, target, key, user, disarmed: false, visited: false }
	}

	fn observe(
		&mut self,
		front: ProcessSerialNumber,
		key: Option<u32>,
		signals: SwitchSignals,
		now: Instant,
		click_owner: impl FnOnce() -> Option<pid_t>,
	) -> FocusDecision {
		self.user.observe(signals, front, now, click_owner);
		// The target came forward right after a user switch: the user picked it.
		// Otherwise it activated itself, even while the user kept typing.
		let picked = now
			.checked_sub(USER_SWITCH_WINDOW)
			.and_then(|start| self.user.since(start))
			.is_some();
		if self.disarmed
			|| (front != self.previous && front != self.target)
			|| (front == self.previous && key.is_some_and(|key| Some(key) != self.key))
			|| (front == self.target && picked)
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
			FocusDecision::Observe
		}
	}

	/// The hand-back was refused because the user pressed a key or clicked
	/// with the target in front.
	const fn user_acted(&mut self) {
		self.visited = true;
		self.disarmed = true;
	}

	/// Whether, after a restore, the target is in front again at the end of
	/// the action without the user having switched to it.
	fn reactivated(
		&mut self,
		restored: bool,
		front: ProcessSerialNumber,
		signals: SwitchSignals,
		now: Instant,
		click_owner: impl FnOnce() -> Option<pid_t>,
	) -> bool {
		restored
			&& front == self.target
			&& self.observe(front, None, signals, now, click_owner) == FocusDecision::Restore
	}
}

/// Whether the user has come to the background target since its guard
/// began: the target came forward right after a click, chord or panel of
/// theirs, the hand-back was refused because of a key or click, or the target
/// was in front after the guard stood down. Later steps of the input must stop
/// then, even once the user has left the target again.
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
/// A third app, a changed prior key window, or the target coming forward right
/// after a click outside the user's app, a ⌘/⌥/⌃ chord or a Spotlight-style
/// panel permanently disarms the lease; typing does not. Only the addressed
/// target can be sent back behind the original front app; unrelated
/// activations are never undone. `action` gets the [`TargetVisit`] the guard
/// records, which keeps being watched after the lease disarms.
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
	let now = Instant::now();
	let mut lease = BackgroundFocusLease::new(
		previous,
		target,
		previous_key,
		SwitchSignals::read(spi, now),
		now,
		click_owner,
	);
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
							let now = Instant::now();
							if lease.observe(
								front.psn,
								key,
								SwitchSignals::read(spi, now),
								now,
								click_owner,
							) == FocusDecision::Restore
							{
								// Re-check immediately before changing focus: an AX
								// probe may have raced a newer application or user
								// switch. `WindowServer` then refuses the hand-back if
								// the user pressed a key or clicked after the re-check
								// began.
								let handed_back = request_after_check(
									event_clock_now,
									|| {
										front_process(spi.get_front).is_some_and(|front| front.psn == target)
											&& {
												let now = Instant::now();
												lease.observe(
													target,
													None,
													SwitchSignals::read(spi, now),
													now,
													click_owner,
												) == FocusDecision::Restore
											}
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
									// The re-check observed instead; a disarm it recorded
									// stops the hand-backs from the next poll.
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
						let now = Instant::now();
						if front_process(spi.get_front).is_some_and(|front| {
							lease.reactivated(
								restored,
								front.psn,
								SwitchSignals::read(spi, now),
								now,
								click_owner,
							)
						}) {
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
	ensure_skylight_loaded()?;
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
	ensure_skylight_loaded()?;
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

fn resolve_authentication() -> Option<AuthenticationSpi> {
	Some(AuthenticationSpi {
		set_message:       symbol(c"SLEventSetAuthenticationMessage")?,
		objc_get_class:    symbol(c"objc_getClass")?,
		sel_register_name: symbol(c"sel_registerName")?,
		class_responds:    symbol(c"class_respondsToSelector")?,
		factory:           symbol(c"objc_msgSend")?,
	})
}

fn attach_keyboard_authentication(pid: pid_t, event: &CGEvent) {
	let Some(spi) = AUTHENTICATION.as_ref() else {
		return;
	};
	// SAFETY: Both C strings are static; runtime lookup functions have their
	// exact Objective-C ABI.
	let class = unsafe { (spi.objc_get_class)(c"SLSEventAuthenticationMessage".as_ptr()) };
	// SAFETY: The selector C string is static and NUL-terminated.
	let selector =
		unsafe { (spi.sel_register_name)(c"messageWithEventRecord:pid:version:".as_ptr()) };
	if class.is_null() || selector.is_null() {
		return;
	}
	// SAFETY: This guard is required because macOS 14 has the class but lacks
	// the macOS 15+ factory selector.
	if !unsafe { (spi.class_responds)(class, selector) } {
		return;
	}
	// __CGEvent stores its SLSEventRecord pointer after CFRuntimeBase and a
	// padded u32.
	let event_raw = event_ptr(event);
	let mut record = ptr::null_mut();
	for offset in [24usize, 32, 16] {
		// SAFETY: These are the known pointer-aligned candidate slots in
		// __CGEvent; read_unaligned avoids alignment assumptions.
		let candidate =
			unsafe { ptr::read_unaligned(event_raw.cast::<u8>().add(offset).cast::<*mut c_void>()) };
		if !candidate.is_null() {
			record = candidate;
			break;
		}
	}
	if record.is_null() {
		return;
	}
	// SAFETY: Class response was checked before invoking this exact factory
	// signature.
	let message = unsafe { (spi.factory)(class, selector, record, pid, 0) };
	if message.is_null() {
		return;
	}
	// SAFETY: The event and autoreleased authentication object are alive for the
	// synchronous attachment.
	unsafe { (spi.set_message)(event_raw, message) };
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::desktop::error::ErrorCode;

	const PREVIOUS: ProcessSerialNumber = ProcessSerialNumber { high: 0, low: 7 };
	const TARGET: ProcessSerialNumber = ProcessSerialNumber { high: 0, low: 8 };
	const THIRD: ProcessSerialNumber = ProcessSerialNumber { high: 0, low: 9 };
	const USER: FrontProcess = FrontProcess { psn: PREVIOUS, pid: Some(70) };
	// HID flag states as a USB keyboard reports them on macOS.
	const NO_MODIFIERS: u64 = 0x100;
	const SHIFT: u64 = 0x2_0102;
	const CAPS_LOCK: u64 = 0x1_0100;
	const FN: u64 = 0x80_0100;
	const COMMAND: u64 = 0x10_0108;
	const OPTION: u64 = 0x8_0120;
	const CONTROL: u64 = 0x4_0101;

	// Where a click landed, as `click_owner` reports it.
	const fn on_dock() -> Option<pid_t> {
		Some(71)
	}

	const fn in_user_app() -> Option<pid_t> {
		USER.pid
	}

	const fn unplaced() -> Option<pid_t> {
		None
	}

	/// Signals after `clicks` hardware clicks (left down and up), timed between
	/// polls, with no key focus reading.
	fn input(clicks: u32, flags: u64) -> SwitchSignals {
		SwitchSignals::new([clicks, clicks, 0, 0, 0, 0], None, flags, None)
	}

	/// Signals with no clicks or modifiers while `process` has the keyboard.
	fn keyboard_in(process: ProcessSerialNumber) -> SwitchSignals {
		SwitchSignals::new([0; 6], None, NO_MODIFIERS, Some(process))
	}

	fn ms(millis: u64) -> Duration {
		Duration::from_millis(millis)
	}

	/// A lease started at `start`, the user's last hardware click at
	/// `last_click` on the Dock.
	fn lease_at(start: Instant, last_click: Option<Instant>) -> BackgroundFocusLease {
		let signals = SwitchSignals::new([0; 6], last_click, NO_MODIFIERS, None);
		BackgroundFocusLease::new(USER, TARGET, Some(42), signals, start, on_dock)
	}

	#[test]
	fn user_switch_watch_names_how_the_user_switched_since_a_time() {
		let t0 = Instant::now();
		let watch = |signals| UserSwitchWatch::new(USER, TARGET, signals, t0, ms(250), on_dock);
		// Typing, Shift, Caps Lock and the Globe key switch nothing.
		for flags in [NO_MODIFIERS, SHIFT, CAPS_LOCK, FN] {
			assert_eq!(watch(input(0, flags)).since(t0), None, "flags {flags:#x}");
		}
		for flags in [COMMAND, OPTION, CONTROL] {
			assert_eq!(watch(input(0, flags)).since(t0), Some(UserSwitch::Chord), "flags {flags:#x}");
		}
		assert_eq!(watch(keyboard_in(THIRD)).since(t0), Some(UserSwitch::Panel));
		// The keyboard in either app of the action is not another panel.
		assert_eq!(watch(keyboard_in(PREVIOUS)).since(t0), None);
		assert_eq!(watch(keyboard_in(TARGET)).since(t0), None);

		// A click is timed by the HID state, not by when a poll saw it.
		let clicked = SwitchSignals::new([0; 6], Some(t0), NO_MODIFIERS, None);
		assert_eq!(watch(clicked).since(t0), Some(UserSwitch::Click));
		let mut later = watch(input(0, NO_MODIFIERS));
		let click = SwitchSignals::new([1, 1, 0, 0, 0, 0], Some(t0 + ms(5)), NO_MODIFIERS, None);
		later.observe(click, PREVIOUS, t0 + ms(40), on_dock);
		assert_eq!(later.since(t0 + ms(5)), Some(UserSwitch::Click));
		assert_eq!(later.since(t0 + ms(6)), None, "the click came before");
		// A click older than the lookback when watching starts does not count.
		let stale = SwitchSignals::new([0; 6], Some(t0), NO_MODIFIERS, None);
		let started = UserSwitchWatch::new(USER, TARGET, stale, t0 + ms(251), ms(250), on_dock);
		assert_eq!(started.since(t0), None);

		// A click on the user's own window picks no other app; one that cannot
		// be placed counts.
		let mut own = watch(input(0, NO_MODIFIERS));
		own.observe(click, PREVIOUS, t0 + ms(10), in_user_app);
		assert_eq!(own.since(t0), None);
		let mut lost = watch(input(0, NO_MODIFIERS));
		lost.observe(click, PREVIOUS, t0 + ms(10), unplaced);
		assert_eq!(lost.since(t0), Some(UserSwitch::Click));

		// The latest switch names the reason; one before `start` does not count.
		let mut both = watch(input(0, COMMAND));
		both.observe(keyboard_in(THIRD), PREVIOUS, t0 + ms(30), on_dock);
		assert_eq!(both.since(t0), Some(UserSwitch::Panel));
		assert_eq!(both.since(t0 + ms(31)), None);
	}

	#[test]
	fn user_focus_changes_permanently_disarm_background_restoration() {
		let t0 = Instant::now();
		let idle = input(0, NO_MODIFIERS);
		let mut guard = lease_at(t0, None);
		assert_eq!(guard.observe(TARGET, None, idle, t0, on_dock), FocusDecision::Restore);
		assert_eq!(guard.observe(THIRD, None, idle, t0 + ms(10), on_dock), FocusDecision::Disarm);
		assert_eq!(guard.observe(TARGET, None, idle, t0 + ms(20), on_dock), FocusDecision::Disarm);

		let mut guard = lease_at(t0, None);
		assert_eq!(
			guard.observe(PREVIOUS, Some(43), idle, t0 + ms(10), on_dock),
			FocusDecision::Disarm
		);
		assert_eq!(guard.observe(TARGET, None, idle, t0 + ms(20), on_dock), FocusDecision::Disarm);
	}

	#[test]
	fn typing_through_a_target_self_activation_keeps_the_users_app_in_front() {
		let t0 = Instant::now();
		for flags in [NO_MODIFIERS, SHIFT, CAPS_LOCK, FN] {
			let mut guard = lease_at(t0, None);
			assert_eq!(
				guard.observe(PREVIOUS, Some(42), input(0, SHIFT), t0 + ms(10), on_dock),
				FocusDecision::Observe
			);
			// The target activates itself while the user types (a capital letter's
			// Shift, Caps Lock, or the Globe key held).
			assert_eq!(
				guard.observe(TARGET, None, input(0, flags), t0 + ms(20), on_dock),
				FocusDecision::Restore,
				"flags {flags:#x}"
			);
			// It may do so again later in the same lease.
			assert_eq!(
				guard.observe(PREVIOUS, Some(42), input(0, NO_MODIFIERS), t0 + ms(30), on_dock),
				FocusDecision::Observe
			);
			assert_eq!(
				guard.observe(TARGET, None, input(0, SHIFT), t0 + ms(40), on_dock),
				FocusDecision::Restore
			);
		}

		// A chord or click that ended longer ago than the switch window picked
		// nothing the target's activation follows from.
		let late = t0 + USER_SWITCH_WINDOW + ms(1);
		let mut guard = lease_at(t0, None);
		assert_eq!(
			guard.observe(PREVIOUS, Some(42), input(1, COMMAND), t0, on_dock),
			FocusDecision::Observe
		);
		assert_eq!(
			guard.observe(TARGET, None, input(1, NO_MODIFIERS), late, on_dock),
			FocusDecision::Restore
		);
		let mut guard = lease_at(t0 + ms(50), Some(t0));
		assert_eq!(
			guard.observe(TARGET, None, input(0, NO_MODIFIERS), late, on_dock),
			FocusDecision::Restore
		);

		// A click in the user's own app, during the action or just before it,
		// with the same timing as a click on the Dock below.
		let mut guard = lease_at(t0, None);
		let click = SwitchSignals::new([1, 1, 0, 0, 0, 0], Some(t0 + ms(5)), NO_MODIFIERS, None);
		assert_eq!(
			guard.observe(PREVIOUS, Some(42), click, t0 + ms(10), in_user_app),
			FocusDecision::Observe
		);
		assert_eq!(guard.observe(TARGET, None, click, t0 + ms(100), on_dock), FocusDecision::Restore);
		let signals = SwitchSignals::new([1, 1, 0, 0, 0, 0], Some(t0), NO_MODIFIERS, None);
		let mut guard =
			BackgroundFocusLease::new(USER, TARGET, Some(42), signals, t0 + ms(50), in_user_app);
		assert_eq!(
			guard.observe(TARGET, None, signals, t0 + ms(60), on_dock),
			FocusDecision::Restore
		);

		// The keyboard in the user's app, or taken by the target itself, is no
		// user switch either.
		for holder in [PREVIOUS, TARGET] {
			let mut guard = lease_at(t0, None);
			assert_eq!(
				guard.observe(PREVIOUS, Some(42), keyboard_in(holder), t0 + ms(10), on_dock),
				FocusDecision::Observe
			);
			assert_eq!(
				guard.observe(TARGET, None, keyboard_in(TARGET), t0 + ms(20), on_dock),
				FocusDecision::Restore
			);
		}
	}

	#[test]
	fn a_click_chord_or_spotlight_right_before_the_target_comes_forward_is_the_users_switch() {
		let t0 = Instant::now();
		let idle = input(0, NO_MODIFIERS);
		// ⌘-Tab: ⌘ held at the last poll, released just before the target came
		// forward (13 ms apart on a VM).
		let mut guard = lease_at(t0, None);
		assert_eq!(
			guard.observe(PREVIOUS, Some(42), input(0, COMMAND), t0 + ms(100), on_dock),
			FocusDecision::Observe
		);
		assert_eq!(guard.observe(TARGET, None, idle, t0 + ms(113), on_dock), FocusDecision::Disarm);
		assert_eq!(
			guard.observe(TARGET, None, idle, t0 + ms(1000), on_dock),
			FocusDecision::Disarm,
			"a switch disarms the lease for good"
		);

		// ⌘, ⌥ or ⌃ still held as the target comes forward (⌘-H, Spaces,
		// launchers).
		for flags in [COMMAND, OPTION, CONTROL] {
			let mut guard = lease_at(t0, None);
			assert_eq!(
				guard.observe(TARGET, None, input(0, flags), t0 + ms(10), on_dock),
				FocusDecision::Disarm,
				"flags {flags:#x}"
			);
		}

		// A click on the Dock or another window, or one that cannot be placed,
		// seen at the last poll or between polls.
		for owner in [on_dock, unplaced] {
			let mut guard = lease_at(t0, None);
			let click = SwitchSignals::new([1, 1, 0, 0, 0, 0], Some(t0 + ms(5)), NO_MODIFIERS, None);
			assert_eq!(
				guard.observe(PREVIOUS, Some(42), click, t0 + ms(10), owner),
				FocusDecision::Observe
			);
			assert_eq!(guard.observe(TARGET, None, click, t0 + ms(100), owner), FocusDecision::Disarm);
		}
		let mut guard = lease_at(t0, None);
		assert_eq!(
			guard.observe(TARGET, None, input(1, NO_MODIFIERS), t0 + ms(10), on_dock),
			FocusDecision::Disarm
		);

		// A click just before the action began, or a chord held as it began.
		let mut guard = lease_at(t0 + ms(50), Some(t0));
		assert_eq!(guard.observe(TARGET, None, idle, t0 + ms(60), on_dock), FocusDecision::Disarm);
		let mut guard =
			BackgroundFocusLease::new(USER, TARGET, Some(42), input(0, COMMAND), t0, on_dock);
		assert_eq!(guard.observe(TARGET, None, idle, t0 + ms(10), on_dock), FocusDecision::Disarm);

		// Spotlight: its panel has the keyboard while the user's app stays in
		// front, then Return brings the target forward (about 10 ms later on a
		// VM).
		let mut guard = lease_at(t0, None);
		assert_eq!(
			guard.observe(PREVIOUS, Some(42), keyboard_in(THIRD), t0 + ms(500), on_dock),
			FocusDecision::Observe
		);
		assert_eq!(
			guard.observe(TARGET, None, keyboard_in(TARGET), t0 + ms(525), on_dock),
			FocusDecision::Disarm
		);
	}

	#[test]
	fn the_target_back_in_front_at_the_end_is_an_error_only_without_a_user_switch() {
		let t0 = Instant::now();
		let idle = input(0, NO_MODIFIERS);
		// It reactivated itself after the restore: input may have landed there.
		assert!(lease_at(t0, None).reactivated(true, TARGET, idle, t0 + ms(10), on_dock));
		// The user switched to it just as the action ended.
		assert!(!lease_at(t0, None).reactivated(
			true,
			TARGET,
			input(0, COMMAND),
			t0 + ms(10),
			on_dock
		));
		assert!(!lease_at(t0, None).reactivated(
			true,
			TARGET,
			keyboard_in(THIRD),
			t0 + ms(10),
			on_dock
		));
		// Nothing was restored, or another app is in front.
		assert!(!lease_at(t0, None).reactivated(false, TARGET, idle, t0 + ms(10), on_dock));
		assert!(!lease_at(t0, None).reactivated(true, THIRD, idle, t0 + ms(10), on_dock));
	}

	#[test]
	fn a_window_appearing_in_a_windowless_front_app_is_a_user_focus_change() {
		// Finder in front after a click on the desktop: no key window to restore.
		let t0 = Instant::now();
		let idle = input(0, NO_MODIFIERS);
		let lease = || BackgroundFocusLease::new(USER, TARGET, None, idle, t0, on_dock);
		let mut guard = lease();
		assert_eq!(guard.observe(PREVIOUS, None, idle, t0 + ms(10), on_dock), FocusDecision::Observe);
		assert_eq!(guard.observe(TARGET, None, idle, t0 + ms(20), on_dock), FocusDecision::Restore);

		// The user opened a Finder window meanwhile: hands off.
		let mut guard = lease();
		assert_eq!(
			guard.observe(PREVIOUS, Some(43), idle, t0 + ms(10), on_dock),
			FocusDecision::Disarm
		);
		assert_eq!(guard.observe(TARGET, None, idle, t0 + ms(20), on_dock), FocusDecision::Disarm);
	}

	#[test]
	fn a_visit_to_the_target_is_kept_after_the_user_leaves_it() {
		let t0 = Instant::now();
		let idle = input(0, NO_MODIFIERS);
		// The user clicks the target, then goes back to their app.
		let mut guard = lease_at(t0, None);
		guard.observe(TARGET, None, input(1, NO_MODIFIERS), t0 + ms(10), on_dock);
		guard.observe(PREVIOUS, Some(42), input(1, NO_MODIFIERS), t0 + ms(20), on_dock);
		assert!(guard.visited);
		// After a switch to a third app the lease stands down, yet still sees
		// the user come to the target.
		let mut guard = lease_at(t0, None);
		guard.observe(THIRD, None, idle, t0 + ms(10), on_dock);
		assert!(!guard.visited);
		guard.observe(TARGET, None, idle, t0 + ms(20), on_dock);
		assert!(guard.visited);
		// The target's own activation, sent back even while the user types, is
		// not a visit; a refused hand-back is.
		let mut guard = lease_at(t0, None);
		assert_eq!(
			guard.observe(TARGET, None, input(0, SHIFT), t0 + ms(10), on_dock),
			FocusDecision::Restore
		);
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
