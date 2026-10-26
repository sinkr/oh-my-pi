import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { postmortem } from "@oh-my-pi/pi-utils";

const db = process.argv[2];
if (!db) throw new Error("Expected a database path");
const auth = new AuthStorage(await SqliteAuthCredentialStore.open(db));
await auth.credentials.reload();
// Another owner's cleanup keeps the exit pass open for a moment, and a refresh
// starts while it runs (a request finishing during teardown, say).
postmortem.register("slow-owner", async () => {
	void auth.oauth.refreshStored("anthropic", {
		forceRefresh: true,
		credentialFromRow: credential => credential,
		keepCredentialOnRefreshFailure: true,
		refresh: async current => {
			// The provider rotates the token at once; its answer is slow to arrive.
			await Bun.sleep(3_000);
			return { ...current, access: "new", refresh: "new-refresh", expires: Date.now() + 3_600_000 };
		},
	});
	await Bun.sleep(1_000);
});
await postmortem.quit(0);
