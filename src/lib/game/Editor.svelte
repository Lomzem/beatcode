<script lang="ts">
	import { Effect } from 'effect';
	import { storage } from '#lib/auth/storage.js';
	import { onMount } from 'svelte';
	import { EditorState, Compartment, Prec } from '@codemirror/state';
	import {
		EditorView,
		keymap,
		lineNumbers,
		highlightActiveLineGutter,
		drawSelection
	} from '@codemirror/view';
	import { cpp } from '@codemirror/lang-cpp';
	import {
		bracketMatching,
		indentOnInput,
		syntaxHighlighting,
		defaultHighlightStyle,
		HighlightStyle
	} from '@codemirror/language';
	import {
		history,
		historyKeymap,
		defaultKeymap,
		indentWithTab,
		insertNewline
	} from '@codemirror/commands';
	import {
		autocompletion,
		completeAnyWord,
		closeBrackets,
		closeBracketsKeymap,
		completionKeymap
	} from '@codemirror/autocomplete';
	import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
	import { setDiagnostics, lintKeymap, type Diagnostic } from '@codemirror/lint';
	let {
		draftKey,
		noPaste = false,
		noHints = false,
		diagnostics = '',
		onSource,
		onNotice
	}: {
		draftKey: string;
		noPaste?: boolean;
		noHints?: boolean;
		diagnostics?: string;
		onSource: (source: string) => void;
		onNotice: (message: string) => void;
	} = $props();
	let host: HTMLDivElement;
	let view: EditorView | undefined = $state();
	let saved = $state('');
	let storageError = $state(false);
	let preferences = $state({ wrap: true, font: '1', announcements: 'standard' });
	const assist = new Compartment();
	const wrapping = new Compartment();
	const parsed = $derived(
		diagnostics.split('\n').flatMap((line) => {
			const found = /^main\.cpp:(\d+):(\d+): (error|warning|note): (.*)$/.exec(line);
			return found
				? [
						{
							line: Number(found[1]),
							column: Number(found[2]),
							severity: found[3],
							message: found[4]
						}
					]
				: [];
		})
	);
	function assistance() {
		// Keep completion's state field mounted while switching its providers off.
		// Removing it during an asynchronous completion leaves a stale SDK callback.
		return [
			autocompletion({ override: noHints ? [] : [completeAnyWord], activateOnTyping: !noHints }),
			...(noHints
				? [keymap.of([{ key: 'Enter', run: insertNewline }])]
				: [
						indentOnInput(),
						closeBrackets(),
						keymap.of([...closeBracketsKeymap, ...completionKeymap])
					])
		];
	}

	export function focusDiagnostic(line: number, column: number) {
		if (!view) return;
		const target = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines));
		const at = Math.min(target.to, target.from + Math.max(0, column - 1));
		view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
		view.focus();
	}
	onMount(() => {
		const playerKey = draftKey.split(':round:')[0];
		let source =
			'#include <iostream>\nusing namespace std;\n\nint main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n    \n    return 0;\n}\n';
		Effect.runSync(
			storage(() => {
				const own = localStorage.getItem(draftKey);
				const prior = localStorage.getItem(playerKey + ':last');
				if (own !== null) {
					source = own;
					saved = 'Draft restored from this device.';
				} else if (prior !== null) {
					source = prior;
					saved = 'Your previous draft was carried into this round.';
				}
				preferences.wrap = localStorage.getItem('beatcode.wrap') !== 'off';
				preferences.font = localStorage.getItem('beatcode.font') ?? '1';
				preferences.announcements = localStorage.getItem('beatcode.announcements') ?? 'standard';
			}).pipe(
				Effect.catchTag('StorageUnavailable', () =>
					Effect.sync(() => {
						storageError = true;
					})
				)
			)
		);
		function store(value: string) {
			onSource(value);
			Effect.runSync(
				storage(() => {
					localStorage.setItem(draftKey, value);
					localStorage.setItem(playerKey + ':last', value);
					saved = 'Draft saved on this device.';
				}).pipe(
					Effect.catchTag('StorageUnavailable', () =>
						Effect.sync(() => {
							storageError = true;
						})
					)
				)
			);
		}
		const editor = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: source,
				extensions: [
					lineNumbers(),
					highlightActiveLineGutter(),
					drawSelection(),
					cpp(),
					bracketMatching(),
					syntaxHighlighting(
						HighlightStyle.define(
							defaultHighlightStyle.specs.map((style) => ({ ...style, color: 'var(--code-token)' }))
						)
					),
					history(),
					highlightSelectionMatches(),
					keymap.of([
						indentWithTab,
						...defaultKeymap,
						...historyKeymap,
						...searchKeymap,
						...lintKeymap
					]),
					Prec.highest(assist.of(assistance())),
					wrapping.of(preferences.wrap ? EditorView.lineWrapping : []),
					EditorView.contentAttributes.of({
						tabindex: '0',
						'aria-label': 'C++ solution',
						'aria-describedby': 'editor-help',
						role: 'textbox',
						'aria-multiline': 'true',
						spellcheck: 'false'
					}),
					EditorView.domEventHandlers({
						paste(event) {
							if (noPaste) {
								event.preventDefault();
								onNotice('Paste blocked by No paste. Typing and navigation remain available.');
								return true;
							}
							return false;
						},
						drop(event) {
							if (noPaste) {
								event.preventDefault();
								onNotice('Drop blocked by No paste.');
								return true;
							}
							return false;
						}
					}),
					EditorView.updateListener.of((update) => {
						if (update.docChanged) store(update.state.doc.toString());
					}),
					EditorView.theme({
						'&': {
							fontSize: preferences.font + 'rem',
							backgroundColor: 'var(--background)',
							color: 'var(--foreground)'
						},
						'.cm-content': {
							fontFamily: 'ui-monospace, monospace',
							minHeight: '18rem',
							paddingBottom: '3rem',
							caretColor: 'var(--foreground)'
						},
						'.cm-gutters': {
							backgroundColor: 'var(--secondary)',
							color: 'var(--foreground)',
							borderColor: 'var(--border)'
						},
						'.cm-cursor': { borderLeftColor: 'var(--foreground)' },
						// Match the base theme's focused selector and invert a readable color pair.
						'.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground':
							{
								backgroundColor: 'var(--foreground)'
							},
						'.cm-content ::selection, .cm-content::selection': {
							color: 'var(--background)'
						},
						'.cm-tooltip': {
							backgroundColor: 'var(--card)',
							color: 'var(--foreground)',
							borderColor: 'var(--border)'
						},
						'&.cm-focused': { outline: '3px solid var(--ring)', outlineOffset: '3px' },
						'.cm-scroller': { overflow: 'auto', maxHeight: '65dvh' }
					})
				]
			})
		});
		view = editor;
		onSource(source);
		return () => {
			editor.destroy();
			view = undefined;
		};
	});
	$effect(() => {
		view?.dispatch({ effects: assist.reconfigure(assistance()) });
	});
	$effect(() => {
		if (!view) return;
		const entries: Diagnostic[] = parsed.map((d) => {
			const line = view!.state.doc.line(Math.min(Math.max(1, d.line), view!.state.doc.lines));
			const from = Math.min(line.to, line.from + Math.max(0, d.column - 1));
			return {
				from,
				to: from,
				severity: d.severity === 'note' ? 'info' : (d.severity as 'error' | 'warning'),
				message: d.message
			};
		});
		view.dispatch(setDiagnostics(view.state, entries));
	});
</script>

<p id="editor-help">Press Escape, then Tab to leave the editor.</p>
<details>
	<summary>Editor shortcuts</summary>
	<p>
		C++20. Tab indents. Ctrl-M toggles Tab navigation. Undo, search and navigation remain available.
	</p>
</details>
<div class="editor-host" bind:this={host}></div>
<p class="muted">
	{storageError
		? 'Local storage is unavailable. Keep this tab open and copy your source before leaving.'
		: saved}
</p>
{#if diagnostics}<details open>
		<summary>Compiler diagnostics</summary>{#if parsed.length}<ul>
				{#each parsed as entry, index (index)}<li>
						<button class="game-button" onclick={() => focusDiagnostic(entry.line, entry.column)}
							>Line {entry.line}, column {entry.column}: {entry.severity}: {entry.message}</button
						>
					</li>{/each}
			</ul>{:else}<pre>{diagnostics}</pre>{/if}
	</details>{/if}

<style>
	.editor-host {
		max-width: 100%;
		min-width: 0;
		border: 1px solid var(--border);
		border-radius: 0.4rem;
	}
	p {
		font-size: 0.875rem;
	}
	:global(.cm-content) {
		tab-size: 4;
	}
	:global(.cm-scroller) {
		overflow-wrap: normal;
	}
	@media (forced-colors: active) {
		:global(.cm-editor) {
			color: CanvasText !important;
			background: Canvas !important;
		}
		:global(.cm-cursor) {
			border-color: CanvasText !important;
		}
		:global(.cm-editor .cm-selectionBackground) {
			forced-color-adjust: none;
			background: CanvasText !important;
		}
		:global(.cm-editor .cm-content::selection),
		:global(.cm-editor .cm-content ::selection) {
			forced-color-adjust: none;
			color: Canvas !important;
		}
	}
</style>
