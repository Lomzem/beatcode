import { Data, Effect } from 'effect';

/** Operator errors deliberately retain no raw process, input or credential data. */
export class OperatorError extends Data.TaggedError('OperatorError')<{
	readonly message: string;
}> {}

export const operatorSync = <A>(message: string, evaluate: () => A) =>
	Effect.try({ try: evaluate, catch: () => new OperatorError({ message }) });

export const operatorAsync = <A>(message: string, evaluate: () => Promise<A>) =>
	Effect.tryPromise({ try: evaluate, catch: () => new OperatorError({ message }) });
