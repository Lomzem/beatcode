<svelte:head><title>Privacy — Beatcode</title></svelte:head>
<div class="shell page prose">
	<h1>Privacy</h1>
	<h2>Sign-in information</h2>
	<p>
		Clerk manages sign-in and sessions. Beatcode stores your account identifier and chosen nickname.
		Your opponent sees your nickname, not your email. Social sign-in requests basic identity
		information, not your repositories, messages or files.
	</p>
	<h2>Code and match data</h2>
	<p>
		Convex stores rooms, decks, submissions and results. Modal compiles and runs submitted C++ in
		isolated sandboxes. Your source stays private unless you explicitly share it with that match’s
		opponent. Source and judging details expire after seven days; match results expire after thirty
		days.
	</p>
	<h2>On your device</h2>
	<p>
		Your browser stores sessions, preferences and code drafts. Clearing site data removes local
		drafts. Cloudflare delivers the site. Beatcode has no advertising or marketing analytics.
	</p>
	<details>
		<summary>Service policies and contact</summary>
		<ul>
			<li><a href="https://clerk.com/legal/privacy">Clerk</a></li>
			<li><a href="https://www.convex.dev/legal/privacy">Convex</a></li>
			<li><a href="https://modal.com/legal/privacy">Modal</a></li>
			<li><a href="https://www.cloudflare.com/privacypolicy/">Cloudflare</a></li>
		</ul>
		<p>
			For data questions or removal requests, contact the operator through the <a
				href="https://github.com/Lomzem/beatcode">Beatcode repository</a
			>. Don’t post private code or account details in a public issue.
		</p>
	</details>
</div>
