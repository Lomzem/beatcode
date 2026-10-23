import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';
const crons = cronJobs();
crons.interval('reap idle rooms', { minutes: 5 }, internal.rooms._reap, {});
crons.interval('pump judge queue', { minutes: 1 }, internal.judge._pump, {});
crons.interval('reap orphan judge sandboxes', { minutes: 10 }, internal.judgeController._reap, {});
crons.daily(
	'purge expired private and operational records',
	{ hourUTC: 3, minuteUTC: 0 },
	internal.ops._purge,
	{}
);
export default crons;
