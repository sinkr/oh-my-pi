---
description: Use Promise.withResolvers() instead of new Promise() constructor
# an executor that takes a resolver: `new Promise(() => {})` has none for withResolvers to replace
condition: "new Promise\\(\\s*(?:async\\s+)?(?:\\(\\s*[A-Za-z_$]|[A-Za-z_$][\\w$]*\\s*=>|function\\b[^(]*\\(\\s*[A-Za-z_$]|[A-Za-z_$][\\w$.]*\\s*\\))"
scope: "tool:edit(*.ts), tool:edit(*.tsx), tool:write(*.ts), tool:write(*.tsx)"
interruptMode: never
---

Prefer `Promise.withResolvers()` over `new Promise((resolve, reject) => ...)`: linear control flow; typed resolvers without callback nesting.

## Basic operation

```typescript
// Bad
function delay(ms: number): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, ms);
	});
}

// Good
function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}
```

## Event-based completion

```typescript
// Bad
function waitForEvent(emitter: EventEmitter, event: string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		emitter.once(event, resolve);
		emitter.once("error", reject);
	});
}

// Good
function waitForEvent(emitter: EventEmitter, event: string): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	emitter.once(event, resolve);
	emitter.once("error", reject);
	return promise;
}
```

## Stored resolver

```typescript
class Gate {
	#promise: Promise<void>;
	#resolve: () => void;

	constructor() {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#promise = promise;
		this.#resolve = resolve;
	}

	open(): void { this.#resolve(); }
	wait(): Promise<void> { return this.#promise; }
}
```

Constructor only if an API specifically requires executor form.
