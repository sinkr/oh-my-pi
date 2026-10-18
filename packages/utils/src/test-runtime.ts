const BUN_TEST_ENTRY_PATTERN = /[._](?:test|spec)\.[cm]?[jt]sx?$/;

/** True when the process is an explicitly marked test child or Bun is running a test entrypoint. */
export function isBunTestRuntime(): boolean {
	return Bun.env.PI_TEST_RUNTIME === "1" || BUN_TEST_ENTRY_PATTERN.test(Bun.main);
}
