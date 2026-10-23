# Managed identity with static delivery

Use Clerk for GitHub, Discord and Google OAuth accounts and sessions, with email-code fallback, with Convex verifying Clerk tokens and enforcing player and room authorization. The human rejected maintaining custom authentication, so the earlier guest JWT design is superseded; provider independence costs less than owning session security for this experiment.

Serve the SvelteKit static frontend from Cloudflare Workers Free at the human-owned domain beatcode.org. This supports Clerk production DNS and SPA routes without the GitHub Pages routing workarounds. GitHub Actions checks pull requests and deploys the backend followed by the frontend after successful main pushes; credentials remain in trusted deployment steps. The domain is the accepted paid item, while hosting and auth remain on free plans.


## Amendment: hosted authentication and prerendering (2026-10-23)

Clerk Account Portal owns sign-in/sign-up, email and provider flows, and signup challenges. The SvelteKit app uses the official session-only JavaScript SDK and restores verified Clerk sessions into Convex. This replaces the initial app-local custom forms: their SDK flow did not support the enabled signup challenge. Hosting the vendor UI avoids adding React to the app or weakening account protection. Invitations stay in app-local fragments and verified tab storage; external return URLs contain no private invitation.

Public routes are prerendered at build time to prevent empty startup content and layout shifts. Cloudflare still serves static assets, with a private-route SPA fallback. This does not add a per-request SSR service or change the free hosting choice.
