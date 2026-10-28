import { fixtures, type FixtureName } from './fixtures';

/** `?state=<name>` selects the fixture; `?theme=` applies a saved Settings theme. */
const params = new URLSearchParams(location.search);
const name = (params.get('state') ?? 'match-active') as FixtureName;
if (!(name in fixtures)) throw new Error(`Unknown game UI fixture: ${name}`);
export const selected = fixtures[name];
const theme = params.get('theme');
if (theme) document.documentElement.dataset.theme = theme;
