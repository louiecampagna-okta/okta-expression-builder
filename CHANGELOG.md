# Changelog

## [1.3.0] — 2026-07-30

Correctness sweep, Okta pagination support, and a proper syntax-highlighted editor. Removed several non-OEL functions that had crept into the evaluator, tightened arity rules for Okta functions that require all their parameters, and fixed cross-origin issues that only appeared on tenants whose admin console runs on a separate `-admin` subdomain.

### Added

- **Syntax highlighting in the expression editor.** Overlay approach: a `<pre>` behind the textarea renders color-coded tokens (strings, numbers, keywords, namespaces, roots, functions, operators) while the textarea handles selection, IME, and accessibility. Perfect pixel alignment maintained by sharing font/padding/box-model between the two elements, disabling ligatures, and keeping all tokens at a single weight.
- **Fixed-width font stack.** Editor now uses `ui-monospace, "SF Mono", "Menlo", "Cascadia Code", "Consolas", "Roboto Mono", "Fira Code", "DejaVu Sans Mono", monospace` — reliable on every platform, with the generic `monospace` keyword as an absolute fallback.
- **Okta pagination.** New `fetchPaginated(url, {maxPages})` helper follows RFC 5988 `Link: <url>; rel="next"` headers. Applied to `fetchUsers`, `fetchUserGroups`, `fetchApps`, `fetchAuthServers`, `fetchAuthServerClaims`, and the Group Rule preview sample. Each with a `maxPages` cap so runaway loops on huge tenants can't happen.

### Changed

- **Group Rule preview sample size** bumped from 25 to 100 (4 pages × 25 users).
- **`iss` claim** in the token preview strips `-admin` from the current hostname before building the issuer URL. Real Okta tokens are issued from `tenant.okta.com`, not the admin domain `tenant-admin.okta.com` where the extension runs.

### Fixed

- **CORS on paginated fetches.** Okta's `Link: rel="next"` header returns absolute URLs pointing at the user-facing domain, but the admin console runs on `-admin`. Following the absolute URL cross-origin got rejected. `parseNextLink` now strips the URL to `pathname + search` so the browser resolves it against the current admin origin.
- **`Groups.contains` / `Groups.startsWith` / `Groups.endsWith` now require all three arguments** per Okta docs (`app, pattern, limit`). Previously `limit` had a JS default and `optional: true` in the spec — Okta's real runtime requires it.
- **Non-OEL functions removed from the evaluator.** Some functions had crept in that aren't part of Okta's OEL reference. Now removed from `FUNCTION_REFERENCE`, `OEL_SPECS`, and evaluator namespaces so they no longer autocomplete or evaluate:
  - `String.match`, `String.splitByRegex`
  - `Convert.toBool`
  - `Arrays.unique`, `Arrays.intersection`, `Arrays.union`, `Arrays.clear`
  - Method-chain aliases `parseUnixTime`, `parseWindowsTime`, `toInteger`, `toNumber`

### Internals

- Syntax highlighting is hand-rolled (no CodeMirror/Monaco dependency) — a single-pass tokenizer produces token spans that the render pass wraps in colored `<span>`s. Token classes: `hl-str`, `hl-num`, `hl-kw`, `hl-ns`, `hl-root`, `hl-fn`, `hl-ident`, `hl-op`, `hl-paren`.
- All programmatic value changes to the expression textarea (Clear, template pick, Quick Insert chip, autocomplete accept, function insertion) now call `renderHighlight()` after modifying `ta.value` so the overlay stays in sync.

## [1.2.0] — 2026-07-30

Token preview now matches Okta's runtime with full fidelity, autocomplete guides users through function signatures with IDE-style help, and the OEL evaluator enforces argument counts and types with signature-aware error messages.

### Added

- **Full-fidelity token preview.** OAuth Claims context now supports:
  - **Token type selector** — preview an ID Token or an Access Token.
  - **Auth server selector** — pick the Org Authorization Server or any Custom Authorization Server. Populated by `GET /api/v1/authorizationServers`.
  - **Real claim evaluation** — for the selected auth server, fetches `/api/v1/authorizationServers/{id}/claims` and evaluates every emittable claim in the current context. The claim you're actively editing overrides the deployed one on name collision so you see the effect of your edit against a full token.
  - **Okta runtime accuracy** — respects `alwaysIncludeInToken` + `conditions.scopes` so claims only appear when a real Okta token would include them. Errored claim expressions are silently dropped (matches Okta). Only claim names Okta actually emits pass through — internal records like `restriction_criteria` and legacy claims like `unique_name` are filtered out.
- **Tabbed output section.** Result, Token/Assertion Preview, and Rule Preview now share a single tabbed pane below the expression editor. Tabs appear/disappear based on context so the overlay stays compact regardless of what you're testing.
- **Signature help.** When the cursor is inside a function call's parens, a floating tooltip above the caret shows the function signature with the current argument highlighted. Handles nested calls, string literals, optional params, and varargs.
- **Autocomplete enhancements.**
  - **Value + type preview inline** — attribute completions show their current value (`"Jane"`, `[5 items]`, `null`, `true`) with color-coded types.
  - **Function param hints** — namespace function completions show their param list (`(str, pattern)`) next to the name.
  - **Method chaining** — after a chain that resolves to a string value (`user.email.`), suggests Identity Engine method-style completions (`substringBefore`, `toUpperCase`, `trim`, `parseStringTime`, etc.).
  - **Accept-inserts-parens** — picking a function inserts `()`, drops the caret between them, and fires signature help immediately.
- **OAuth-context variables in the evaluator.** Added `client`, `oauth_request`, and `context.*` (including `context.oauth2.client`, `context.oauth2.request`, `context.device`, `context.session`, `context.security`, `context.org`). Tenant claim expressions that reference these now evaluate instead of throwing.
- **Context-aware app search.** Sign-on-mode filter matches the current expression context — OAuth Claims shows OIDC apps only, SAML shows SAML apps only, Inline Hook shows both, other contexts show everything. A filter hint at the top of the search results explains what's being shown. If the selected app doesn't fit the new context, a "wrong type" pill appears on the app card.
- **Arg count + type validation in the evaluator.** Every OEL function has an entry in a new `OEL_SPECS` table with a typed parameter list. The interpreter enforces both the required-arg count and the type of each provided arg, producing errors like `Groups.startsWith(app, pattern[, limit]) — argument 2 ('pattern') must be string, got integer` — signature included, no more silent misuse.

### Changed

- **Access token `sub` = user's login (username)**, not the user ID and not the email. Locked in the base and protected from override by fetched claim records.
- **`idp` claim** in the ID token preview uses the real Okta org ID (`00o...`) fetched from `/api/v1/org`, not the org URL.
- **SAML context is honest about being SAML.** Token-type and auth-server pickers hide themselves in SAML; the tab reads "Assertion Preview" instead of "Token Preview"; the name-input placeholder becomes "attribute name" with a `customAttribute` default.
- **Base-owned claims can't be overridden.** `sub`, `iss`, `aud`, `iat`, `exp`, `jti`, `ver`, `cid`, `uid`, `scp`, `auth_time`, `idp`, `amr` are always populated from the base and never from fetched claim records (Okta owns these end-to-end).
- **Group-typed claim conditions** on custom auth servers are approximated locally (`STARTS_WITH`, `CONTAINS`, `EQUALS`, `REGEX`) against the fetched group list.

### Fixed

- **Non-emittable claim records no longer leak into token previews.** Okta's claims API returns internal records (`restriction_criteria`, `unique_name`, etc.) with the same structure as real claims. Filtered by an explicit Okta-emitted-claims whitelist (sourced from Okta's own OIDC docs).
- **`Groups.startsWith('IT_')` no longer silently returns `[]`.** Missing required args now throw a clear error rather than passing `undefined` into the JS function.
- **Argument types validated.** Passing a number where a string is expected (or a string where an integer is expected) now throws with a friendly message identifying the offending argument.
- **Optional params correctly recognized.** OEL function defs use `= undefined` on optional parameters so `Function.length` accurately reflects the minimum required count. `Time.now()`, `user.getGroups()`, `String.substring(str, start)` all work as documented.

### Internals

- New API helpers: `fetchAuthServers`, `fetchAuthServerClaims`.
- Interpreter's `MethodCall` / `Call` cases now go through a unified `checkCall(fullName, fn, args)` that consults `OEL_SPECS` for arity + type validation, falling back to JS `Function.length` for functions not in the spec table.
- Namespace name is derived from the AST when the call is on an Ident (e.g. `Groups.startsWith` — namespace is `Groups`), enabling per-namespace spec lookup without runtime tagging.
- Autocomplete popup layout switched to two columns (name + value/hint) with a wider min-width to accommodate value peeks.

## [1.1.0] — 2026-07-29

Major release adding real-app selection, live claim evaluation against tenant configuration, and a stack of quality-of-life features that make the expression builder feel closer to Okta's server-side runtime.

### Added

- **Real app selection** — a second picker alongside the user picker. Search your org's apps by name or label; the extension hydrates `state.profile.app` from real data (`id`, `label`, `signOnMode`, OIDC `clientId`, and any custom `app.profile.*` fields defined on the app). Directory sources (AD, LDAP, Okta-to-Okta) are surfaced with a dedicated badge.
- **Live app-user assignment lookup** — when both a user and an app are selected, hits `GET /api/v1/apps/{appId}/users/{userId}`. If the user is assigned, `appuser` is populated with the real per-app profile schema + credentials. If unassigned, every `appuser.*` reference evaluates to `null` (matching Okta's real runtime) and a "not assigned" warning pill is shown.
- **Manager traversal** — when a selected user has a `managerId`, the manager's profile is fetched via `/api/v1/users/{managerId}` and made available to `getManagerUser(user).*` expressions with real data.
- **User + app profile schemas** — `GET /api/v1/meta/schemas/user/default` and per-app `/apps/{id}/default` are pulled in the background. Every declared attribute appears in the Quick Insert chip list, even those the current user hasn't populated. Null-valued chips are dimmed so populated values are still easy to spot.
- **Policy presets for App Sign-On Policy context** — six realistic combinations (managed corp + pwd+MFA + low risk, unmanaged BYOD + high risk, Kerberos SSO, etc.) swap `device`/`session`/`security` in one click. Only shown in the App Sign-On Policy context.
- **Full token / assertion preview** — new tabbed pane below the expression editor.
  - OIDC contexts: pick **ID Token** or **Access Token**, pick **Org Auth Server** or any **Custom Authorization Server**. Fetches the server's real claim mappings via `/api/v1/authorizationServers/{id}/claims` and evaluates each active `EXPRESSION`-typed claim in the current context, producing a full token JSON alongside the claim you're editing. Errored claims are silently dropped (matching Okta runtime). Claims filtered out by `conditions.scopes` are omitted and reported.
  - SAML context: renders a SAML assertion with NameID + AttributeStatement. Token-type / auth-server pickers hide themselves since they don't apply.
  - Claim/attribute name is editable inline; the currently-edited value overrides the fetched one on name collision so you can see the effect of your edit against the deployed config.
- **Group Rule preview across real users** — in the Group Rules context, a "Run against org" button samples the first 25 users, evaluates the current expression per user with their real groups, and shows pass/fail counts + a scrollable list of matching users.
- **Editor autocomplete** — trigger on `.` after known root identifiers (`user`, `appuser`, `idpuser`, `app`, `org`, `device`, `session`, `security`, `String`, `Arrays`, `Time`, `Convert`, `Iso3166Convert`, `DateTime`, `Groups`). Dropdown merges live profile keys with schema-declared attributes for `user`/`appuser`, and function names for namespaces. Arrow keys navigate, Enter/Tab inserts, Esc closes. Positioning uses a mirror-div technique so the popup sits at the current caret line.
- **OAuth-context variables in the evaluator** — added `client`, `oauth_request`, and `context.*` (including `context.oauth2.client`, `context.oauth2.request`, `context.device`, `context.session`, `context.security`, `context.org`). Tenant-authored claim expressions that reference these now evaluate rather than throwing.
- **Context-aware app search** — sign-on-mode filter matches the current context: OAuth Claims shows OIDC apps only; SAML shows SAML apps only; Inline Hook shows OIDC + SAML; everything else shows all apps. A filter hint at the top of the results explains what's being shown. If a currently-selected app doesn't match the new context, a **wrong type** pill appears on the selected-app card.

### Changed

- **Tabbed output section** — Result, Token/Assertion Preview, and Rule Preview now share a single tabbed pane below the expression editor. Only one is visible at a time so the layout stays compact. Tabs appear/disappear based on the current context; the pane's max-height + internal scroll keeps the overlay from ballooning.
- **`appuser` is strict** — no longer falls back to `user` in the evaluator (previously `appuser.X` would silently resolve to `user.X`). When there's no assignment, `appuser.*` returns null everywhere. The mock profile only applies when using the mock user.
- **Context-aware picker visibility** — the "Testing app" row is hidden in contexts that don't reference `app`/`appuser` (Group Rules, IdP Attribute Mapping, App Sign-On Policy, Access Certification), recovering vertical space.
- **Compacted controls strip** — padding/margins reduced across the top-of-overlay controls so Quick Insert chips always have room to render.
- **Failing claims are dropped, not stringified** — previously an eval error would show as `<error: ...>` inside the token JSON. Now the claim is silently omitted from the token, matching Okta runtime, and a warning footer under the JSON lists the failing claim names, expressions, and error messages.
- **App search lists apps on empty query** — no more 2-char minimum. Opening the picker immediately shows the tenant's apps, making short-named directory instances (AD, LDAP) discoverable without knowing an exact prefix.

### Fixed

- Layout bug where Quick Insert chips could collapse to zero height when both a real user and a real app were selected.
- Null-safe rendering for apps that expose only a `name` (some directory sources lack `label`).
- `refreshChips` / `rebuildAppControls` / `rebuildUserControls` are now guaranteed to run via `finally` blocks so a mid-flow throw can't leave the UI in a stale state.
- Preserving user's `state.profile.session`/`security`/`device` (from policy presets) across user re-selection.

### Internals

- `state` now tracks `selectedApp`, `appAssignment`, `userSchema`, `appSchema`, `authServers`, `authServerClaims`, `tokenType`, `authServerId`, and `outputTab`.
- New API helpers: `fetchApps`, `fetchAppUser`, `fetchUserById`, `fetchUserSchema`, `fetchAppSchema`, `fetchAuthServers`, `fetchAuthServerClaims`.

## [1.0.0]

Initial release — floating overlay, live evaluator, real user selection, function reference, templates, context-aware warnings, session gating.
