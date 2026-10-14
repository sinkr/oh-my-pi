import type { DesktopSession, DesktopSessionOptions } from "./index.js";

/** Construct a desktop session, loading the native addon on first use. */
export declare function createDesktopSession(options: DesktopSessionOptions): DesktopSession;

/** Invalidate this process's listen-only event taps before it exits (see the native doc). */
export declare function closeDesktopEventTaps(): void;
