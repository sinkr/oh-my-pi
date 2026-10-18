/**
 * OMP Browser Relay — MV3 service worker.
 *
 * Dumb pipe by design: all CDP orchestration lives in the relay server. This
 * worker (1) keeps a websocket to the relay, (2) executes its RPCs against
 * `chrome.debugger`/`chrome.tabs`, and (3) streams tab + debugger events back.
 *
 * Service-worker lifetime: the open websocket plus a periodic ping keeps the
 * worker alive while connected (Chrome 116+); a chrome.alarms tick revives it
 * and re-dials after Chrome reaps it while disconnected.
 */
import type { ExtToRelayMessage, RelayToExtMessage, TabSnapshot } from "../../coding-agent/src/tools/browser/relay/protocol";
import { ownedDebuggerTabs } from "./debugger-ownership";

const DEFAULT_PORT = 9224;
const PING_INTERVAL_MS = 20_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
const REMOVE_TAB_ATTEMPTS = 3;
const REMOVE_TAB_RETRY_MS = 500;

let ws: WebSocket | null = null;
let reconnectDelay = RECONNECT_MIN_MS;
let pingTimer: NodeJS.Timeout | null = null;
const relayInitiatedDetachTabs = new Set<number>();

/**
 * Stable per-install browser identity, persisted in `chrome.storage.local` and
 * sent in every hello. The relay namespaces tab registries per instance, so
 * several browsers can share one relay and a service-worker restart keeps the
 * browser's tab registry instead of replacing another browser's connection.
 */
let instanceId: string | null = null;
async function ensureInstanceId(): Promise<string> {
	if (instanceId) return instanceId;
	const key = "relayInstanceId";
	const stored = await chrome.storage.local.get({ [key]: "" });
	const existing = stored[key];
	instanceId = typeof existing === "string" && existing.length > 0 ? existing : crypto.randomUUID();
	await chrome.storage.local.set({ [key]: instanceId } as Record<string, string>);
	return instanceId;
}

const BROWSER_SESSION_KEY = "relayBrowserSession";

/**
 * A random id for this browser session. Chrome reuses tab ids after a restart, so the relay scopes target ids and
 * saved closes to it. It lives in `chrome.storage.local`, so reloading or updating the extension keeps it, and is
 * replaced when the browser starts (`runtime.onStartup`).
 */
async function ensureBrowserSession(): Promise<string> {
	const stored = await chrome.storage.local.get({ [BROWSER_SESSION_KEY]: "" });
	const existing = stored[BROWSER_SESSION_KEY];
	if (typeof existing === "string" && existing.length > 0) return existing;
	const created = crypto.randomUUID();
	await chrome.storage.local.set({ [BROWSER_SESSION_KEY]: created });
	return created;
}

const ORPHAN_TABS_KEY = "relayOrphanTabs";
/** Serializes edits of the stored orphan-tab list, so concurrent passes do not overwrite each other's changes. */
let orphanEdits: Promise<number[]> = Promise.resolve([]);

/** Apply `edit` to the stored orphan-tab ids; resolves with the list as stored. */
function editOrphanTabs(edit: (ids: number[]) => number[]): Promise<number[]> {
	orphanEdits = orphanEdits
		.catch(() => [])
		.then(async () => {
			const stored = await chrome.storage.session.get({ [ORPHAN_TABS_KEY]: [] });
			const listed = stored[ORPHAN_TABS_KEY];
			const before = Array.isArray(listed) ? listed.filter(id => typeof id === "number") : [];
			const ids = edit(before);
			if (ids.length !== before.length || ids.some((id, i) => id !== before[i])) {
				await chrome.storage.session.set({ [ORPHAN_TABS_KEY]: ids });
			}
			return ids;
		});
	return orphanEdits;
}

/**
 * Close tabs created for RPCs whose relay connection was gone. Each is kept in `chrome.storage.session`, which
 * outlives a service-worker restart, until Chrome confirms its close, and tried again on the next connect and
 * keepalive; `added` is stored before any close is tried.
 */
async function closeOrphanTabs(added?: number): Promise<void> {
	try {
		const ids = await editOrphanTabs(ids => (added === undefined || ids.includes(added) ? ids : [...ids, added]));
		for (const id of ids) {
			const closed = await removeTab(id).then(
				() => true,
				() => false,
			);
			if (closed) await editOrphanTabs(list => list.filter(other => other !== id));
		}
	} catch {
		// Storage unavailable: the ids stay as stored for the next pass.
	}
}

interface RelaySettings {
	port: number;
	token: string;
}

async function loadSettings(): Promise<RelaySettings> {
	const stored = await chrome.storage.local.get({ port: DEFAULT_PORT, token: "" });
	const port = Number(stored.port);
	return {
		port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT,
		token: typeof stored.token === "string" ? stored.token : "",
	};
}

function snapshot(tab: ChromeTab): TabSnapshot | null {
	if (tab.id === undefined) return null;
	return {
		tabId: tab.id,
		url: tab.url ?? tab.pendingUrl ?? "",
		title: tab.title ?? "",
		active: tab.active,
		discarded: tab.discarded === true,
		windowId: tab.windowId,
		pinned: tab.pinned,
		groupId: tab.groupId,
	};
}

/** Title of the omp tab group; mirrored to session storage so a restarted service worker can still dissolve it. */
let ompGroupTitle: string | null = null;

/**
 * Serialize group mutations. Chrome's query→group→set-title sequence is not
 * atomic: two concurrent runs both miss the not-yet-titled group and mint
 * duplicate "omp" groups in the same window.
 */
let groupOps: Promise<unknown> = Promise.resolve();
function enqueueGroupOp<T>(fn: () => Promise<T>): Promise<T> {
	const result = groupOps.then(fn, fn);
	groupOps = result.catch(() => {});
	return result;
}

/** Move tabs into the per-window omp group, creating or reusing it by title. */
async function groupTabs(tabIds: number[], title: string, color: string): Promise<{ grouped: Record<string, number> }> {
	ompGroupTitle = title;
	void chrome.storage.session.set({ ompGroupTitle: title });
	const byWindow = new Map<number, number[]>();
	for (const tabId of tabIds) {
		try {
			const tab = await chrome.tabs.get(tabId);
			// Grouping silently unpins; never touch pinned tabs.
			if (tab.pinned || tab.id === undefined) continue;
			const bucket = byWindow.get(tab.windowId) ?? [];
			bucket.push(tab.id);
			byWindow.set(tab.windowId, bucket);
		} catch {
			// Tab already closed.
		}
	}
	const grouped: Record<string, number> = {};
	for (const [windowId, ids] of byWindow) {
		const existing = await chrome.tabGroups.query({ title, windowId });
		let groupId: number;
		if (existing[0]) {
			groupId = existing[0].id;
			// Heal duplicate same-title groups left behind by older races.
			for (const dupe of existing.slice(1)) {
				const dupeTabs = await chrome.tabs.query({ groupId: dupe.id });
				const dupeIds = dupeTabs.map(tab => tab.id).filter(id => id !== undefined);
				if (dupeIds.length > 0) await chrome.tabs.group({ tabIds: dupeIds, groupId });
			}
			await chrome.tabs.group({ tabIds: ids, groupId });
		} else {
			groupId = await chrome.tabs.group({ tabIds: ids });
		}
		await chrome.tabGroups.update(groupId, { title, color });
		for (const id of ids) grouped[String(id)] = groupId;
	}
	return { grouped };
}

/** Dissolve every omp-titled group (relay disconnected or asked us to release tabs). */
async function restoreGroups(): Promise<void> {
	if (!ompGroupTitle) {
		// Service worker restarted since the last group op; recover the title.
		const stored = await chrome.storage.session.get({ ompGroupTitle: "" }).catch(() => ({ ompGroupTitle: "" }));
		ompGroupTitle = typeof stored.ompGroupTitle === "string" && stored.ompGroupTitle ? stored.ompGroupTitle : null;
	}
	if (!ompGroupTitle) return;
	const groups = await chrome.tabGroups.query({ title: ompGroupTitle }).catch(() => []);
	for (const group of groups) {
		const tabs = await chrome.tabs.query({ groupId: group.id }).catch(() => []);
		const ids = tabs.map(tab => tab.id).filter(id => id !== undefined);
		if (ids.length > 0) await chrome.tabs.ungroup(ids).catch(() => {});
	}
}

/** The socket each in-flight RPC came in on, and its op, by RPC id (unique across relay processes). */
const rpcOrigins = new Map<number, { socket: WebSocket; op: string }>();

function trackOrigin(msg: RelayToExtMessage, origin: WebSocket): RelayToExtMessage {
	if (msg.t === "rpc") rpcOrigins.set(msg.id, { socket: origin, op: msg.op });
	return msg;
}

/** A `createTab` result: the tab Chrome opened. */
function isCreatedTab(result: unknown): result is { tab: { tabId: number } } {
	return typeof result === "object" && result !== null && "tab" in result;
}

/**
 * Send to the relay. An RPC's answer goes only on the socket the RPC came in on: once that socket has closed
 * (dropped, or replaced after a settings change), the relay has already failed the call, so the answer is dropped,
 * and a tab created for it is closed here, since no one can learn its id any more.
 */
function post(msg: ExtToRelayMessage): void {
	if (msg.t === "rpcResult") {
		const origin = rpcOrigins.get(msg.id);
		rpcOrigins.delete(msg.id);
		if (origin && (origin.socket !== ws || origin.socket.readyState !== WebSocket.OPEN)) {
			if (origin.op === "createTab" && msg.ok && isCreatedTab(msg.result)) {
				void closeOrphanTabs(msg.result.tab.tabId);
			}
			return;
		}
	}
	if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** Chrome can refuse a tab close for a moment (a tab being dragged, an unload in progress); try again before failing. */
async function removeTab(tabId: number): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await chrome.tabs.remove(tabId);
			return;
		} catch (error) {
			// Already closed: the close the relay asked for has happened.
			if (/No tab with id/.test(String(error))) return;
			if (attempt >= REMOVE_TAB_ATTEMPTS) throw error;
			const pause = Promise.withResolvers<void>();
			setTimeout(pause.resolve, REMOVE_TAB_RETRY_MS);
			await pause.promise;
		}
	}
}

async function setBadge(connected: boolean): Promise<void> {
	try {
		await chrome.action.setBadgeText({ text: connected ? "on" : "off" });
		await chrome.action.setBadgeBackgroundColor({ color: connected ? "#1a7f37" : "#8b8b8b" });
	} catch {
		// Badge is cosmetic; never let it break the relay loop.
	}
}

async function buildHello(): Promise<ExtToRelayMessage> {
	const [tabs, targets] = await Promise.all([chrome.tabs.query({}), chrome.debugger.getTargets()]);
	const snapshots: TabSnapshot[] = [];
	for (const tab of tabs) {
		const snap = snapshot(tab);
		if (snap) snapshots.push(snap);
	}
	// `attached` is true for DevTools or another extension too; only our own attachment answers a command.
	const attachedTabIds = await ownedDebuggerTabs(targets, tabId =>
		chrome.debugger.sendCommand({ tabId }, "Target.getTargetInfo"),
	);
	const versionMatch = /Chrome\/[\d.]+/.exec(navigator.userAgent);
	return {
		t: "hello",
		instanceId: await ensureInstanceId(),
		browserSession: await ensureBrowserSession(),
		userAgent: navigator.userAgent,
		browserVersion: versionMatch?.[0] ?? "Chrome/unknown",
		discardedTabsProtocol: 1, // Keep in sync with the relay protocol version.
		tabs: snapshots,
		attachedTabIds,
	};
}

async function runRpc(msg: Extract<RelayToExtMessage, { t: "rpc" }>): Promise<unknown> {
	switch (msg.op) {
		case "attach":
			await chrome.debugger.attach({ tabId: msg.tabId }, "1.3");
			return {};
		case "detach":
			relayInitiatedDetachTabs.add(msg.tabId);
			try {
				await chrome.debugger.detach({ tabId: msg.tabId });
				return {};
			} catch (error) {
				relayInitiatedDetachTabs.delete(msg.tabId);
				throw error;
			}
		case "send":
			return await chrome.debugger.sendCommand(
				msg.sessionId ? { tabId: msg.tabId, sessionId: msg.sessionId } : { tabId: msg.tabId },
				msg.method,
				msg.params,
			);
		case "createTab": {
			const tab = await chrome.tabs.create({ url: msg.url, active: msg.active ?? true });
			const snap = snapshot(tab);
			if (!snap) throw new Error("created tab has no id");
			return { tab: snap };
		}
		case "removeTab":
			await removeTab(msg.tabId);
			return {};
		case "activateTab": {
			const tab = await chrome.tabs.get(msg.tabId);
			await chrome.windows.update(tab.windowId, { focused: true });
			await chrome.tabs.update(msg.tabId, { active: true });
			return {};
		}
		case "group":
			return await enqueueGroupOp(() => groupTabs(msg.tabIds, msg.title, msg.color));
		case "ungroup":
			await enqueueGroupOp(() => chrome.tabs.ungroup(msg.tabIds).catch(() => {}));
			return {};
	}
}

/** Handle a message from the relay on `origin`, the socket it came in on (see {@link post}). */
function handleRelayMessage(raw: string, origin: WebSocket): void {
	let msg: RelayToExtMessage;
	try {
		msg = trackOrigin(JSON.parse(raw) as RelayToExtMessage, origin);
	} catch {
		return;
	}
	if (msg.t === "pong") return;
	void runRpc(msg)
		.then(result => post({ t: "rpcResult", id: msg.id, ok: true, result }))
		.catch((err: unknown) => {
			post({ t: "rpcResult", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
		});
}

function scheduleReconnect(): void {
	const delay = reconnectDelay;
	reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
	setTimeout(() => void connect(), delay);
}

async function connect(): Promise<void> {
	if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
	const settings = await loadSettings();
	const url = `ws://127.0.0.1:${settings.port}/ext${settings.token ? `?token=${encodeURIComponent(settings.token)}` : ""}`;
	const socket = new WebSocket(url);
	ws = socket;
	socket.onopen = () => {
		reconnectDelay = RECONNECT_MIN_MS;
		void setBadge(true);
		void closeOrphanTabs();
		void buildHello().then(hello => post(hello));
		clearInterval(pingTimer ?? undefined);
		pingTimer = setInterval(() => post({ t: "ping" }), PING_INTERVAL_MS);
	};
	socket.onmessage = event => {
		if (typeof event.data === "string") handleRelayMessage(event.data, socket);
	};
	socket.onclose = () => {
		if (ws !== socket) return;
		ws = null;
		if (pingTimer !== null) {
			clearInterval(pingTimer);
			pingTimer = null;
		}
		void setBadge(false);
		void restoreGroups();
		scheduleReconnect();
	};
	socket.onerror = () => {
		socket.close();
	};
}

// ---- event streaming ---------------------------------------------------------

chrome.debugger.onEvent.addListener((source, method, params) => {
	if (source.tabId === undefined) return;
	post({ t: "cdpEvent", tabId: source.tabId, sessionId: source.sessionId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
	if (source.tabId === undefined) return;
	const relayInitiated = relayInitiatedDetachTabs.delete(source.tabId);
	post({ t: "detached", tabId: source.tabId, reason, relayInitiated });
});

chrome.tabs.onCreated.addListener(tab => {
	const snap = snapshot(tab);
	if (snap) post({ t: "tabCreated", tab: snap });
});

chrome.tabs.onUpdated.addListener((_tabId, _changeInfo, tab) => {
	const snap = snapshot(tab);
	if (snap) post({ t: "tabUpdated", tab: snap });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
	void chrome.tabs.get(tabId).then(tab => {
		const snap = snapshot(tab);
		if (snap) post({ t: "tabUpdated", tab: snap });
	}).catch(() => {
		// The tab may have closed before Chrome answered.
	});
});

chrome.tabs.onRemoved.addListener(tabId => {
	post({ t: "tabRemoved", tabId });
});

// ---- lifecycle ----------------------------------------------------------------

chrome.alarms.create("omp-relay-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
	if (alarm.name !== "omp-relay-keepalive") return;
	void connect();
	void closeOrphanTabs();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
	if (areaName !== "local") return;
	if (Object.keys(changes).every(key => key === BROWSER_SESSION_KEY)) return;
	// Settings changed: drop the current connection and re-dial with new ones.
	ws?.close();
	void connect();
});

chrome.action.onClicked.addListener(() => void chrome.runtime.openOptionsPage());
chrome.runtime.onInstalled.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => {
	// The browser just started, so tab ids from before may be reused: take a new session id and say hello again
	// with it, replacing a hello already sent with the old one.
	void chrome.storage.local.set({ [BROWSER_SESSION_KEY]: crypto.randomUUID() }).then(() => {
		ws?.close();
		void connect();
	});
});

void connect();
