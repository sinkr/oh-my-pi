//! Listen-only physical Escape monitoring for operation and durable task
//! ownership.
use std::{
	ffi::c_void,
	ptr,
	sync::atomic::{AtomicU32, Ordering},
	thread::{self, JoinHandle},
};

use super::{CoreResult, DesktopError, EmergencyStop};

pub(crate) const SYNTHETIC_EVENT_TAG: i64 = 0x7069_6465_736b;
const SOURCE_USER_DATA: u32 = 42;
const SOURCE_UNIX_PID: u32 = 41;
const KEYBOARD_KEYCODE: u32 = 9;
const KEY_DOWN: u32 = 10;
type Ref = *mut c_void;
type ConstRef = *const c_void;
type Callback = unsafe extern "C" fn(Ref, u32, Ref, Ref) -> Ref;

#[repr(C)]
struct SourceContext {
	version:     isize,
	info:        Ref,
	retain:      Option<unsafe extern "C" fn(ConstRef) -> ConstRef>,
	release:     Option<unsafe extern "C" fn(ConstRef)>,
	description: Option<unsafe extern "C" fn(ConstRef) -> ConstRef>,
	equal:       Option<unsafe extern "C" fn(ConstRef, ConstRef) -> bool>,
	hash:        Option<unsafe extern "C" fn(ConstRef) -> usize>,
	schedule:    Option<unsafe extern "C" fn(Ref, Ref, Ref)>,
	cancel:      Option<unsafe extern "C" fn(Ref, Ref, Ref)>,
	perform:     Option<unsafe extern "C" fn(Ref)>,
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
	fn CGEventTapCreate(
		tap: u32,
		place: u32,
		options: u32,
		mask: u64,
		callback: Callback,
		user: Ref,
	) -> Ref;
	fn CGEventGetIntegerValueField(event: Ref, field: u32) -> i64;
	fn CGEventGetFlags(event: Ref) -> u64;
	fn CGEventTapEnable(tap: Ref, enable: bool);
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
	static kCFRunLoopDefaultMode: Ref;
	fn CFMachPortCreateRunLoopSource(allocator: Ref, port: Ref, order: isize) -> Ref;
	fn CFMachPortInvalidate(port: Ref);
	fn CFRunLoopGetCurrent() -> ConstRef;
	fn CFRunLoopAddSource(run_loop: ConstRef, source: Ref, mode: Ref);
	fn CFRunLoopRemoveSource(run_loop: ConstRef, source: Ref, mode: Ref);
	fn CFRunLoopSourceCreate(allocator: Ref, order: isize, context: *mut SourceContext) -> Ref;
	fn CFRunLoopSourceSignal(source: Ref);
	fn CFRunLoopRun();
	fn CFRunLoopStop(run_loop: ConstRef);
	fn CFRunLoopWakeUp(run_loop: ConstRef);
	fn CFRetain(object: ConstRef) -> ConstRef;
	fn CFRelease(object: ConstRef);
}

struct TapContext {
	stop: EmergencyStop,
	tap:  Ref,
}

const fn physical_escape(kind: u32, key: i64, pid: i64, tag: i64) -> bool {
	kind == KEY_DOWN && key == 53 && pid == 0 && tag != SYNTHETIC_EVENT_TAG
}

const FLAGS_CHANGED: u32 = 12;
const COMMAND_FLAG: u64 = 0x0010_0000;
const CONTROL_FLAG: u64 = 0x0004_0000;
const SECONDARY_FN_FLAG: u64 = 0x0080_0000;

/// Mouse presses (left, right, other `CGEventType`s): the one list both the
/// takeover monitor and the HID press counters classify presses by.
pub(crate) const POINTER_PRESS_TYPES: [u32; 3] = [1, 3, 25];

pub(crate) const fn is_pointer_press(kind: u32) -> bool {
	let mut i = 0;
	while i < POINTER_PRESS_TYPES.len() {
		if POINTER_PRESS_TYPES[i] == kind {
			return true;
		}
		i += 1;
	}
	false
}

/// F1-F20, home of Mission Control, Launchpad, Show Desktop and the
/// Control-F keyboard-focus shortcuts (menu bar, Dock, status menus).
const fn function_key(key: i64) -> bool {
	matches!(
		key,
		122 | 120
			| 99
			| 118
			| 96
			| 97
			| 98
			| 100
			| 101
			| 109
			| 103
			| 111
			| 105
			| 107
			| 113
			| 106
			| 64
			| 79
			| 80
			| 90
	)
}

/// The arrows and the Help, Home, End, Page Up, Page Down and Forward Delete
/// keys, which carry the fn flag whenever they are typed.
const fn navigation_key(key: i64) -> bool {
	matches!(key, 114..=117 | 119 | 121 | 123..=126)
}

/// Shift, Option and Caps Lock: modifiers that only change the characters
/// typed. Command and Control start shortcuts, and a Globe (fn) press or a
/// double Command or Control press can itself open the emoji picker or start
/// Dictation.
const fn typing_modifier(key: i64) -> bool {
	matches!(key, 56 | 60 | 58 | 61 | 57)
}

/// Whether a key press is plain typing: no Command or Control, not a function
/// key, and fn only on the keys that always carry it. Shift and Option type
/// characters. Anything else may be a shortcut that picks an app, window,
/// Space or menu, so only this allowlist counts as typing.
const fn plain_typing(key: i64, flags: u64) -> bool {
	flags & (COMMAND_FLAG | CONTROL_FLAG) == 0
		&& !function_key(key)
		&& (flags & SECONDARY_FN_FLAG == 0 || navigation_key(key))
}

/// The event types the takeover monitor's tap listens to: every pointer
/// press, then key presses and modifier changes.
pub(crate) const MONITORED_TYPES: [u32; 5] = [
	POINTER_PRESS_TYPES[0],
	POINTER_PRESS_TYPES[1],
	POINTER_PRESS_TYPES[2],
	KEY_DOWN,
	FLAGS_CHANGED,
];

const fn monitor_mask() -> u64 {
	let mut mask = 0;
	let mut i = 0;
	while i < MONITORED_TYPES.len() {
		mask |= 1 << MONITORED_TYPES[i];
		i += 1;
	}
	mask
}

/// Events of each [`MONITORED_TYPES`] type the takeover monitor has seen and
/// classified, among those `WindowServer`'s HID counters also count (see
/// [`seen_index`]).
static SEEN: [AtomicU32; 5] = [const { AtomicU32::new(0) }; 5];

/// Where an event the tap sees goes in [`SEEN`]: only hardware input (no
/// source pid) and omp's own tagged events, which omp posts only to the HID
/// event tap, so every seen event is one the HID counters count too. Another
/// process's event may have been posted to the session, which the tap sees
/// but the HID counters skip; counting it would let it stand in for a user
/// click still in the tap's queue. One posted to the HID tap leaves the
/// monitor behind instead, which only stands the hand-back down.
const fn seen_index(kind: u32, pid: i64, tag: i64) -> Option<usize> {
	if pid != 0 && tag != SYNTHETIC_EVENT_TAG {
		return None;
	}
	let mut i = 0;
	while i < MONITORED_TYPES.len() {
		if MONITORED_TYPES[i] == kind {
			return Some(i);
		}
		i += 1;
	}
	None
}

/// [`SEEN`] now. Next to `WindowServer`'s HID counters for the same types, it
/// tells whether the monitor has caught up with every event counted so far,
/// since the tap's callback trails `WindowServer`.
pub(crate) fn monitor_seen() -> [u32; 5] {
	SEEN.each_ref().map(|seen| seen.load(Ordering::Acquire))
}

/// What a physical event means for takeover's hand-back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UserInput {
	/// A mouse press, any key press that is not plain typing (Command-Tab,
	/// Control-Up, Control-F2, F3, a Globe shortcut), or a Command, Control or
	/// Globe modifier on its own: it may pick an app, window, Space or menu,
	/// or open system UI, so the hand-back stands down.
	Choice,
	/// Plain typing, which reaches the takeover target only because takeover
	/// holds the front.
	Typing,
}

const fn user_input(kind: u32, key: i64, flags: u64, pid: i64, tag: i64) -> Option<UserInput> {
	if pid != 0 || tag == SYNTHETIC_EVENT_TAG {
		return None;
	}
	match kind {
		kind if is_pointer_press(kind) => Some(UserInput::Choice),
		KEY_DOWN if plain_typing(key, flags) => Some(UserInput::Typing),
		KEY_DOWN => Some(UserInput::Choice),
		FLAGS_CHANGED if typing_modifier(key) => Some(UserInput::Typing),
		FLAGS_CHANGED => Some(UserInput::Choice),
		_ => None,
	}
}

/// Now in nanoseconds of `CLOCK_UPTIME_RAW`: the clock `WindowServer` compares
/// a front-process request's timestamp with, and the one the takeover monitor
/// stamps the user's typing with, so the two compare directly.
pub(crate) fn uptime_ns() -> u64 {
	let mut time = libc::timespec { tv_sec: 0, tv_nsec: 0 };
	// SAFETY: `time` is writable for the call, which retains no pointer.
	unsafe { libc::clock_gettime(libc::CLOCK_UPTIME_RAW, &raw mut time) };
	u64::try_from(time.tv_sec).unwrap_or(0) * 1_000_000_000
		+ u64::try_from(time.tv_nsec).unwrap_or(0)
}

unsafe extern "C" fn observe(_proxy: Ref, kind: u32, event: Ref, user: Ref) -> Ref {
	// SAFETY: the monitor thread retains this stack context through
	// invalidation.
	let context = unsafe { &*(user.cast::<TapContext>()) };
	if kind == u32::MAX || kind == u32::MAX - 1 {
		context.stop.cancel();
		// SAFETY: the event tap remains alive until this callback returns.
		unsafe {
			CGEventTapEnable(context.tap, true);
		}
		return event;
	}
	if !event.is_null() {
		// SAFETY: documented read-only CGEvent fields.
		let (key, pid, tag, flags) = unsafe {
			(
				CGEventGetIntegerValueField(event, KEYBOARD_KEYCODE),
				CGEventGetIntegerValueField(event, SOURCE_UNIX_PID),
				CGEventGetIntegerValueField(event, SOURCE_USER_DATA),
				CGEventGetFlags(event),
			)
		};
		match user_input(kind, key, flags, pid, tag) {
			Some(UserInput::Choice) => {
				super::USER_CHOICES.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
			},
			Some(UserInput::Typing) => {
				super::LAST_USER_TYPING.store(uptime_ns(), std::sync::atomic::Ordering::Release);
			},
			None => {},
		}
		// After the classification above, so a reader that sees this count
		// also sees what the event meant.
		if let Some(index) = seen_index(kind, pid, tag) {
			SEEN[index].fetch_add(1, Ordering::AcqRel);
		}
		if physical_escape(kind, key, pid, tag) {
			context.stop.escape();
		}
	}
	event
}

unsafe extern "C" fn stop_loop(_: Ref) {
	// SAFETY: this callback runs on the monitor's own run loop.
	unsafe {
		CFRunLoopStop(CFRunLoopGetCurrent());
	}
}

pub(super) struct EscapeMonitor {
	thread:      Option<JoinHandle<()>>,
	run_loop:    usize,
	stop_source: usize,
}

impl EscapeMonitor {
	pub(super) fn start(emergency: EmergencyStop) -> CoreResult<Self> {
		let (ready, receive) = flume::bounded(1);
		let worker = thread::Builder::new()
			.name("desktop-escape".into())
			.spawn(move || {
				let mut context = TapContext { stop: emergency, tap: ptr::null_mut() };
				// SAFETY: listen-only tap; context stays live until invalidation.
				let tap = unsafe {
					CGEventTapCreate(
						1,
						0,
						1,
						monitor_mask(),
						observe,
						ptr::from_mut(&mut context).cast(),
					)
				};
				if tap.is_null() {
					let _ = ready.send(None);
					return;
				}
				context.tap = tap;
				let mut stop_context = SourceContext {
					version:     0,
					info:        ptr::null_mut(),
					retain:      None,
					release:     None,
					description: None,
					equal:       None,
					hash:        None,
					schedule:    None,
					cancel:      None,
					perform:     Some(stop_loop),
				};
				// SAFETY: valid create-rule tap and version-zero run-loop context.
				let (source, stop_source) = unsafe {
					(
						CFMachPortCreateRunLoopSource(ptr::null_mut(), tap, 0),
						CFRunLoopSourceCreate(ptr::null_mut(), -1, &raw mut stop_context),
					)
				};
				if source.is_null() || stop_source.is_null() {
					// SAFETY: release exactly the objects successfully created
					// above.
					unsafe {
						if !source.is_null() {
							CFRelease(source);
						}
						if !stop_source.is_null() {
							CFRelease(stop_source);
						}
						CFMachPortInvalidate(tap);
						CFRelease(tap);
					}
					let _ = ready.send(None);
					return;
				}
				// SAFETY: all sources remain retained throughout the loop; the
				// owner gets separate retains for its signal/wakeup
				// request.
				unsafe {
					let run_loop = CFRunLoopGetCurrent();
					CFRunLoopAddSource(run_loop, source, kCFRunLoopDefaultMode);
					CFRunLoopAddSource(run_loop, stop_source, kCFRunLoopDefaultMode);
					CGEventTapEnable(tap, true);
					let _ =
						ready.send(Some((CFRetain(run_loop) as usize, CFRetain(stop_source) as usize)));
					CFRunLoopRun();
					CFRunLoopRemoveSource(run_loop, source, kCFRunLoopDefaultMode);
					CFRunLoopRemoveSource(run_loop, stop_source, kCFRunLoopDefaultMode);
					CFMachPortInvalidate(tap);
					CFRelease(source);
					CFRelease(stop_source);
					CFRelease(tap);
				}
			})
			.map_err(|error| {
				DesktopError::input_failed(format!("cannot start emergency Escape monitor: {error}"))
			})?;
		let Some((run_loop, stop_source)) = receive.recv().ok().flatten() else {
			let _ = worker.join();
			return Err(DesktopError::permission_denied(
				"cannot start the emergency Escape monitor: macOS refused its event tap, so no input \
				 was sent; check Accessibility for the app that launched omp",
			));
		};
		Ok(Self { thread: Some(worker), run_loop, stop_source })
	}
}

impl Drop for EscapeMonitor {
	fn drop(&mut self) {
		// SAFETY: these retains belong to this owner. A signaled source remains
		// pending even when stop races the first CFRunLoopRun call.
		unsafe {
			CFRunLoopSourceSignal(self.stop_source as Ref);
			CFRunLoopWakeUp(self.run_loop as ConstRef);
			CFRelease(self.stop_source as ConstRef);
			CFRelease(self.run_loop as ConstRef);
		}
		if let Some(worker) = self.thread.take()
			&& worker.thread().id() != thread::current().id()
		{
			let _ = worker.join();
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn only_physical_escape_cancels() {
		assert!(physical_escape(KEY_DOWN, 53, 0, 0));
		assert!(!physical_escape(KEY_DOWN, 53, 0, SYNTHETIC_EVENT_TAG));
		assert!(!physical_escape(KEY_DOWN, 53, 42, 0));
		assert!(!physical_escape(KEY_DOWN, 0, 0, 0));
		assert!(!physical_escape(11, 53, 0, 0));
	}

	#[test]
	fn clicks_and_command_shortcuts_choose_while_plain_typing_does_not() {
		for kind in [LEFT_MOUSE_DOWN, RIGHT_MOUSE_DOWN, OTHER_MOUSE_DOWN] {
			assert_eq!(user_input(kind, 0, 0, 0, 0), Some(UserInput::Choice));
			assert_eq!(user_input(kind, 0, 0, 0, SYNTHETIC_EVENT_TAG), None);
			assert_eq!(user_input(kind, 0, 0, 42, 0), None);
		}
		// Command-Tab and Command-Space pick an app; Shift-typing does not.
		assert_eq!(user_input(KEY_DOWN, 48, COMMAND_FLAG, 0, 0), Some(UserInput::Choice));
		assert_eq!(user_input(KEY_DOWN, 49, COMMAND_FLAG | 0x2_0000, 0, 0), Some(UserInput::Choice));
		assert_eq!(user_input(KEY_DOWN, 0, 0x2_0000, 0, 0), Some(UserInput::Typing));
		assert_eq!(user_input(KEY_DOWN, 0, 0, 0, 0), Some(UserInput::Typing));
		assert_eq!(user_input(FLAGS_CHANGED, 56, 0x2_0000, 0, 0), Some(UserInput::Typing));
		// omp's own keys and those another process posts are not the user's.
		assert_eq!(user_input(KEY_DOWN, 48, COMMAND_FLAG, 0, SYNTHETIC_EVENT_TAG), None);
		assert_eq!(user_input(KEY_DOWN, 0, 0, 42, 0), None);
		// Releases mean nothing on their own.
		for kind in [11, 2, 4, 26] {
			assert_eq!(user_input(kind, 48, COMMAND_FLAG, 0, 0), None);
		}
	}

	#[test]
	fn only_plain_typing_types_and_every_other_shortcut_chooses() {
		// Arrow keydowns carry the fn and numeric-pad flags.
		let fn_pad = SECONDARY_FN_FLAG | 0x0020_0000;
		for arrow in 123..=126 {
			// Control-Up and its kin: Mission Control and Space switches.
			let control = user_input(KEY_DOWN, arrow, CONTROL_FLAG | fn_pad, 0, 0);
			assert_eq!(control, Some(UserInput::Choice));
			assert_eq!(user_input(KEY_DOWN, arrow, fn_pad, 0, 0), Some(UserInput::Typing));
			let word = user_input(KEY_DOWN, arrow, fn_pad | 0x8_0000, 0, 0);
			assert_eq!(word, Some(UserInput::Typing), "Option-arrow moves by word");
		}
		for key in [115, 119, 116, 121, 117] {
			assert_eq!(user_input(KEY_DOWN, key, SECONDARY_FN_FLAG, 0, 0), Some(UserInput::Typing));
		}
		// Control-1 through Control-9 switch Desktops; Control-F2 and Control-F8
		// focus the menu bar and status menus; F3 and F4 open Mission Control and
		// Launchpad; Globe-F toggles full screen; any other Control chord may be
		// an app's or the system's shortcut too.
		for (key, flags) in [
			(18, CONTROL_FLAG),
			(25, CONTROL_FLAG),
			(120, CONTROL_FLAG | SECONDARY_FN_FLAG),
			(100, CONTROL_FLAG | SECONDARY_FN_FLAG),
			(99, SECONDARY_FN_FLAG),
			(118, 0),
			(3, SECONDARY_FN_FLAG),
			(0, CONTROL_FLAG),
		] {
			assert_eq!(user_input(KEY_DOWN, key, flags, 0, 0), Some(UserInput::Choice), "{key}");
		}
		// Letters, Shift and Option characters, Return and Delete are typing.
		for (key, flags) in [(0, 0), (0, 0x2_0000), (0, 0x8_0000), (36, 0), (51, 0)] {
			assert_eq!(user_input(KEY_DOWN, key, flags, 0, 0), Some(UserInput::Typing), "{key}");
		}
		assert_eq!(user_input(KEY_DOWN, 126, CONTROL_FLAG, 0, SYNTHETIC_EVENT_TAG), None);
	}

	#[test]
	fn only_shift_option_and_caps_lock_are_typing_modifiers() {
		// Shift, Option and Caps Lock change the characters typed.
		for key in [56, 60, 58, 61, 57] {
			assert_eq!(user_input(FLAGS_CHANGED, key, 0, 0, 0), Some(UserInput::Typing), "{key}");
		}
		// Globe on its own opens the emoji picker or starts Dictation, a double
		// Command or Control press can start Dictation, and both start shortcuts.
		for key in [63, 55, 54, 59, 62] {
			assert_eq!(user_input(FLAGS_CHANGED, key, 0, 0, 0), Some(UserInput::Choice), "{key}");
		}
		assert_eq!(user_input(FLAGS_CHANGED, 63, SECONDARY_FN_FLAG, 0, SYNTHETIC_EVENT_TAG), None);
	}

	#[test]
	fn the_monitor_counts_only_events_the_hid_counters_count() {
		for kind in [LEFT_MOUSE_DOWN, RIGHT_MOUSE_DOWN, OTHER_MOUSE_DOWN, 10, 12] {
			// Hardware input and omp's own HID-tap posts.
			let index = seen_index(kind, 0, 0);
			assert!(index.is_some(), "{kind}");
			assert_eq!(seen_index(kind, 4242, SYNTHETIC_EVENT_TAG), index);
			// Another process's event, perhaps posted to the session, which the
			// HID counters skip: it must not cover a click still queued.
			assert_eq!(seen_index(kind, 4242, 0), None);
		}
		assert_eq!(seen_index(11, 0, 0), None, "key releases are not watched");
	}

	/// `CGEventType` values from `CGEventTypes.h`, spelled out here rather
	/// than taken from the lists under test.
	const LEFT_MOUSE_DOWN: u32 = 1;
	const RIGHT_MOUSE_DOWN: u32 = 3;
	const OTHER_MOUSE_DOWN: u32 = 25;

	#[test]
	fn the_monitor_sees_and_counts_every_mouse_button_press() {
		for kind in [LEFT_MOUSE_DOWN, RIGHT_MOUSE_DOWN, OTHER_MOUSE_DOWN, 10, 12] {
			assert_ne!(monitor_mask() & (1 << kind), 0, "the tap listens for {kind}");
			assert!(seen_index(kind, 0, 0).is_some(), "{kind} counts toward the monitor's progress");
		}
		for kind in [LEFT_MOUSE_DOWN, RIGHT_MOUSE_DOWN, OTHER_MOUSE_DOWN] {
			assert_eq!(user_input(kind, 0, 0, 0, 0), Some(UserInput::Choice), "{kind}");
		}
		// Releases, moves, drags and scrolling are neither choices nor watched.
		for kind in [2, 4, 26, 5, 6, 7, 27, 22] {
			assert_eq!(monitor_mask() & (1 << kind), 0, "{kind}");
			assert_eq!(seen_index(kind, 0, 0), None, "{kind}");
			assert_eq!(user_input(kind, 0, 0, 0, 0), None, "{kind}");
		}
	}
}
