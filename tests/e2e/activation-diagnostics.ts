import { Data, Effect, Option } from 'effect';
import type { JSHandle, Locator } from '@playwright/test';
import { CARD_RULES, type CardId } from '../../shared/cards';

const prefix = 'CI activation failure: ';
export type ActivationSnapshot = {
	beforeVisible: boolean;
	beforeEnabled: boolean;
	beforeFocused: boolean;
	afterVisible: boolean;
	afterEnabled: boolean;
	afterFocused: boolean;
	enterCount: number;
	enterOnControl: boolean;
	enterPrevented: boolean;
	clickCount: number;
	clickOnControl: boolean;
};
export function activationFailureLine(
	card: CardId,
	direction: 'host-to-guest' | 'guest-to-host',
	snapshot: ActivationSnapshot
) {
	return safeActivationFailure(prefix + JSON.stringify({ card, direction, ...snapshot }));
}

// Exact types and keys are rechecked by the external stdout owner. Unknown
// values, vendor errors and arbitrary identifiers never reach public output.
export function safeActivationFailure(line: string): string | undefined {
	if (!line.startsWith(prefix)) return;
	try {
		const row: unknown = JSON.parse(line.slice(prefix.length));
		if (!row || typeof row !== 'object' || Array.isArray(row)) return;
		const r = row as Record<string, unknown>;
		const booleans = [
			'beforeVisible',
			'beforeEnabled',
			'beforeFocused',
			'afterVisible',
			'afterEnabled',
			'afterFocused',
			'enterOnControl',
			'enterPrevented',
			'clickOnControl'
		];
		const keys = ['card', 'direction', 'enterCount', 'clickCount', ...booleans];
		if (Object.keys(r).length !== keys.length || Object.keys(r).some((key) => !keys.includes(key)))
			return;
		if (
			typeof r.card !== 'string' ||
			!Object.hasOwn(CARD_RULES, r.card) ||
			typeof r.direction !== 'string' ||
			!['host-to-guest', 'guest-to-host'].includes(r.direction) ||
			booleans.some((key) => typeof r[key] !== 'boolean')
		)
			return;
		for (const key of ['enterCount', 'clickCount'])
			if (typeof r[key] !== 'number' || !Number.isSafeInteger(r[key]) || r[key] < 0 || r[key] > 99)
				return;
		return (
			prefix +
			JSON.stringify({
				card: r.card,
				direction: r.direction,
				beforeVisible: r.beforeVisible,
				beforeEnabled: r.beforeEnabled,
				beforeFocused: r.beforeFocused,
				afterVisible: r.afterVisible,
				afterEnabled: r.afterEnabled,
				afterFocused: r.afterFocused,
				enterCount: r.enterCount,
				enterOnControl: r.enterOnControl,
				enterPrevented: r.enterPrevented,
				clickCount: r.clickCount,
				clickOnControl: r.clickOnControl
			})
		);
	} catch {
		return;
	}
}

class DiagnosticFailure extends Data.TaggedError('DiagnosticFailure') {}
const diagnosticStep = <A>(operation: () => Promise<A>) =>
	Effect.tryPromise({ try: operation, catch: () => new DiagnosticFailure() });
const ignoreFailure = <A>(effect: Effect.Effect<A, DiagnosticFailure>) =>
	Effect.runPromise(
		effect.pipe(Effect.catchTag('DiagnosticFailure', () => Effect.succeed(undefined)))
	);
// Deadlines cap optional protocol work, never wait for UI readiness or retry it.
const optional = <A>(operation: () => Promise<A>, deadline = 250) =>
	ignoreFailure(
		diagnosticStep(operation).pipe(
			Effect.timeoutOption(deadline),
			Effect.map(Option.getOrUndefined)
		)
	);

type NativeProbe = { after(): Promise<ActivationSnapshot>; release(): void };
async function release(probe: JSHandle<NativeProbe>) {
	try {
		await optional(() => probe.evaluate((p) => p.release()));
	} finally {
		await optional(() => probe.dispose());
	}
}

export async function observeActivation(control: Locator) {
	const pending = ignoreFailure(
		Effect.acquireUseRelease(
			diagnosticStep(() => control.elementHandles()),
			(handles) =>
				handles.length !== 1
					? Effect.succeed(undefined)
					: diagnosticStep(() =>
							handles[0].evaluateHandle((element) => {
								const sample = () => ({
									visible: (element as Element).checkVisibility(),
									enabled: !(element as HTMLButtonElement).disabled,
									focused: document.activeElement === element
								});
								const before = sample();
								let listening = true;
								const pendingEnter: KeyboardEvent[] = [];
								const events = {
									enterCount: 0,
									enterOnControl: false,
									enterPrevented: false,
									clickCount: 0,
									clickOnControl: false
								};
								const targetsControl = (target: EventTarget | null) =>
									target instanceof Node && (target === element || element.contains(target));
								const keydown = (event: KeyboardEvent) => {
									if (!listening || !event.isTrusted || event.key !== 'Enter') return;
									events.enterCount = Math.min(99, events.enterCount + 1);
									events.enterOnControl ||= targetsControl(event.target);
									if (pendingEnter.length < 99) pendingEnter.push(event);
								};
								const click = (event: MouseEvent) => {
									if (!listening || !event.isTrusted) return;
									events.clickCount = Math.min(99, events.clickCount + 1);
									events.clickOnControl ||= targetsControl(event.target);
								};
								const stop = () => {
									listening = false;
									document.removeEventListener('keydown', keydown, true);
									document.removeEventListener('click', click, true);
								};
								document.addEventListener('keydown', keydown, true);
								document.addEventListener('click', click, true);
								return {
									async after() {
										stop();
										// Native dispatch can run a microtask between listeners.
										// This sample runs after the original press has completed,
										// then crosses a microtask checkpoint before reading events.
										await Promise.resolve();
										events.enterPrevented = pendingEnter.some((event) => event.defaultPrevented);
										pendingEnter.length = 0;
										const after = sample();
										return {
											beforeVisible: before.visible,
											beforeEnabled: before.enabled,
											beforeFocused: before.focused,
											afterVisible: after.visible,
											afterEnabled: after.enabled,
											afterFocused: after.focused,
											...events
										};
									},
									release() {
										stop();
										pendingEnter.length = 0;
									}
								};
							})
						),
			(handles) =>
				Effect.promise(async () => {
					for (const handle of handles) await optional(() => handle.dispose());
				})
		)
	);
	// Acquisition includes query, native setup and release of temporary handles.
	const probe = await optional(() => pending, 1000);
	if (!probe) {
		// A slow acquisition can finish after the optional deadline. Its resource
		// still has an owner and is released as soon as the protocol returns it.
		void pending.then((late) => (late ? release(late) : undefined));
		return;
	}
	let snapshot: ActivationSnapshot | undefined;
	return {
		async after() {
			snapshot = await optional(() => probe.evaluate((p) => p.after()));
		},
		read() {
			return snapshot;
		},
		async close() {
			await release(probe);
		}
	};
}
