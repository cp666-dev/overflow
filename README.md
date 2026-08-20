# Overflow

Landing page for **Overflow**, a pool for idle AI capacity. When your AI subscription caps out, your agent keeps working on discounted, honestly-labeled open-model capacity; GPU owners sell metered, hard-capped tokens into the pool while their hardware is idle.

Phase 0 of the plan: validate demand with two waitlists (`demand` for people who hit limits, `supply` for people with idle GPUs) before building the gateway.

## Stack

Single static `index.html`, no build step, deployed on GitHub Pages.

## Before launch (manual steps)

1. **Formspree**: create a form at [formspree.io](https://formspree.io), then replace `FORM_ID` in the `FORMSPREE_ID` constant in `index.html`. Both waitlist forms post to the same form with a `tag` field (`demand` / `supply`). Until then, forms show a fallback email address instead of failing silently.
2. **Cloudflare Web Analytics**: add the site in Cloudflare (Web Analytics → manual setup) and paste the beacon `<script>` snippet just before `</body>`. Use the **manual JS snippet**, not the nameserver/proxy option, since proxying would overwrite the A records GitHub Pages needs if a custom domain is added later.
3. **Custom domain (optional)**: point four A records (`185.199.108.153`, `.109.153`, `.110.153`, `.111.153`) at `@` and a `www` CNAME at `cp666-dev.github.io`, then set the domain in repo Settings → Pages.

## Success gate

~200+ demand-side signups (or clear qualitative pull) before starting Phase 1, the metered OpenAI-compatible fallback gateway. Full plan and phased architecture live in the project planning notes.
