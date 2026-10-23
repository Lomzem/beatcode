import { Cause, Effect, Exit } from 'effect';
import { PreventSchedulerYield } from 'effect/Scheduler';
import { ConvexError } from 'convex/values';

/** Expected public rejection; mapped back to the existing ConvexError data at the handler. */
export class DomainFailure {
	readonly _tag = 'DomainFailure';
	constructor(
		readonly code: string,
		readonly message: string = code
	) {}
}

/** Internal calibration policy failures retain their existing Error message. */
export class CalibrationFailure {
	readonly _tag = 'CalibrationFailure';
	constructor(readonly message: string) {}
}

/** Trusted action failures contain only fixed, safe diagnostic codes. */
export class JudgeFailure {
	readonly _tag = 'JudgeFailure';
	constructor(readonly message: string) {}
}

/** Transport/database failures are propagated, never logged or serialized by this adapter. */
export class OperationFailure {
	readonly _tag = 'OperationFailure';
	constructor(readonly cause: unknown) {}
}
export type BackendFailure = DomainFailure | CalibrationFailure | JudgeFailure | OperationFailure;

export const reject = (code: string, message = code) =>
	Effect.fail(new DomainFailure(code, message));

function operationFailure(cause: unknown): BackendFailure {
	if (cause instanceof ConvexError) {
		const data = cause.data;
		if (
			data &&
			typeof data === 'object' &&
			'code' in data &&
			'message' in data &&
			typeof data.code === 'string' &&
			typeof data.message === 'string'
		)
			return new DomainFailure(data.code, data.message);
	}
	return new OperationFailure(cause);
}

/** Lift one SDK operation, not an application workflow. Every call remains sequential. */
export const step = <A>(operation: PromiseLike<A>) =>
	Effect.tryPromise({ try: () => operation, catch: operationFailure });
export const syncStep = <A>(operation: () => A) =>
	Effect.try({ try: operation, catch: operationFailure });

/** The only runtime boundary. Convex owns transactions and scheduling. */
export async function runBackend<A>(program: Effect.Effect<A, BackendFailure>): Promise<A> {
	const exit = await Effect.runPromiseExit(
		Effect.provideService(program, PreventSchedulerYield, true)
	);
	if (Exit.isSuccess(exit)) return exit.value;
	const failure = Cause.squash(exit.cause);
	if (failure instanceof DomainFailure)
		throw new ConvexError({ code: failure.code, message: failure.message });
	if (failure instanceof CalibrationFailure || failure instanceof JudgeFailure)
		throw new Error(failure.message);
	if (failure instanceof OperationFailure) throw failure.cause;
	throw failure;
}
