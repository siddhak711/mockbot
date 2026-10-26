# Requests

This file is kept up to date as requests come and go.

| Ask                                          | Done-criteria                                                                                                                       | PR                                    | Status                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------- |
| Google OAuth login works on production.      | `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set in Vercel and 'Sign in with Google' succeeds on <https://mockbot-jet.vercel.app>. | #22 (code present but env vars unset) | waiting on Siddha (needs Google OAuth client created + env wired) |
| Playwright smoke-test CI gate.               | PR #28 merged, 4 GitHub Actions secrets present, main branch ruleset requires check 'e2e-smoke / e2e-smoke'.                        | #28                                   | open (held on Siddha approval)                                    |
| Composio connector catalog.                  | PR #31 merged and Add-connector flow connects Notion + GitHub via Composio on production.                                           | #31                                   | open (in Reviewer loop)                                           |
| Fix GitHub connector error after connecting. | Clicking Connect → GitHub on the live site no longer shows 'Set GITHUB_OAUTH_CLIENT_ID...' and completes via Composio.              | part of #31                           | open                                                              |
