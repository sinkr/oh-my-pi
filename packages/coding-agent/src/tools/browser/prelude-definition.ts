import { prompt } from "@oh-my-pi/pi-utils";
import type { EvalPreludeDefinition } from "../../eval/preludes";
import relayGuidance from "../../prompts/system/browser-relay.md" with { type: "text" };
import browserDescription from "../../prompts/tools/browser.md" with { type: "text" };
import type { ToolSession } from "../../sdk";
// @ts-expect-error Bun imports this JavaScript source as text instead of evaluating its module shape.
import browserJavascript from "./prelude.js" with { type: "text" };
import browserPython from "./prelude.py" with { type: "text" };
import { resolveRelayKind } from "./relay/kind";
import { cfgBrowserCdpUrl, cfgBrowserEnabled, cfgBrowserRelay } from "./settings";

/** Build the browser eval facade after an eval runtime first requests preludes. */
export function createBrowserPreludeDefinition(
	session: ToolSession,
	host: Pick<EvalPreludeDefinition, "invoke" | "status">,
): EvalPreludeDefinition {
	// The documentation says an open without `app` gets omp's own browser; with the relay
	// on it gets the user's Chrome, so this session's prompt says so and names the way out.
	const relayDefault = resolveRelayKind({ settingEnabled: cfgBrowserRelay.get(session.settings) }) !== null;
	return {
		name: "browser",
		documentation: browserDescription,
		guidance: relayDefault
			? prompt.render(relayGuidance, { cdpUrl: cfgBrowserCdpUrl.get(session.settings)?.trim() || undefined })
			: undefined,
		javascript: browserJavascript,
		python: browserPython,
		exports: ["browser"],
		approval: "exec",
		enabled: () => cfgBrowserEnabled.get(session.settings),
		invoke: host.invoke,
		status: host.status,
	};
}
