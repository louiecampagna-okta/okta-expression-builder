# Changelog

## [Unreleased]

`user.getGroups` is the most capable function in the evaluator and was the least reachable from the editor. Typing `user.getG` completed to nothing, its criteria keys and projection fields were pure memorization, and one of Okta's own documented examples returned the wrong answer. This makes the group syntax discoverable and fixes the fidelity gap underneath it.

### Added

- **`user.` offers its methods alongside its attributes.** `getGroups`, `isMemberOf`, `getInternalProperty` and `getLinkedObject` now autocomplete, and `user.profile` appears as the navigable path it already was. They're listed *ahead* of the profile attributes on purpose: there are four of them against roughly forty attributes, and unlike attributes they have no Quick Insert equivalent, so behind the list cap they'd have stayed invisible. Completion lists can now mix kinds per item rather than being all-attributes or all-functions.
- **Criteria completion inside `getGroups` / `isMemberOf`.** Typing `{'` offers the four documented criteria keys plus `operator`; accepting one writes `': '` and opens the value position, where the completions are **drawn from the live group records** — real group names for `group.profile.name`, real ids for `group.id` (hinted with the group's name), real source ids for `group.source.id`, and the three documented types for `group.type`. Picking a group you're actually in beats typing its name from memory. Works at any criteria depth, including inside a set literal (`{'group.type': {'…`) and in a second criteria object after the comma.
- **Projection completion inside `.![ … ]`.** Offers the seven fields Okta illustrates first, then whatever else the fetched records carry, labelled `on this tenant`. Only fires when the receiver really is a `getGroups()` call — checked by walking the trailing call back to its own open paren, so criteria containing nested parens don't break it and an unrelated array can't pick up group fields.
- **Method chaining on arrays, numbers and past a call.** `groups.`, `session.amr.`, `security.behaviors.`, `appuser.memberOf.` and `access.scope.` offered nothing before; they now offer the documented array methods. Numeric attributes offer the conversion methods. The chain scanner also steps over balanced call parens, so `user.created.parseStringTime().` reaches the date-time methods and `user.countryCode.parseCountryCode().` reaches the country ones — neither was reachable when the trigger was a plain identifier-chain regex.
- **6 new templates** covering `EXACT` vs the default `STARTS_WITH`, OR-within-a-key, two criteria objects ANDed, and group projections as OIDC claims.

### Changed

- **`user.getGroups` records pass through whole.** `toGroupObject` narrowed each fetched group to seven fields, but Okta documents the projection expression as "any group attribute" and points at the List all groups schema — so `.![objectClass]`, or any custom group profile attribute, resolved to `null` here while resolving in Okta. `_links` and `_embedded` are still dropped (transport metadata, and `_links` is bulky); `source.id` is still lifted out of `_links` because criteria read it and Okta reports it only as a link. `groups` and `groupIds` stay the flat string arrays they've always been.
- **Method-completion lists come from the evaluator.** `STRING_METHOD_COMPLETIONS` and `DATETIME_METHOD_COMPLETIONS` were hand-copied mirrors of the alias tables carrying a "keep in sync" comment — stale-able in both directions: a name listed but absent from the table completes into an expression that won't evaluate, and a method added to the table but not to the list stays undiscoverable. `OELEvaluator.METHOD_NAMES` now exposes the real tables and both lists are gone. The group criteria vocabulary and `USER_RECORD_KEYS` are exported the same way, so `content.js` holds no second copy of any of it.
- **`user.profile.` resolves in the picker.** `state.profile.user` is flat, so the namespaced form completed to nothing even though the evaluator supports it. The view is derived by subtracting `OELEvaluator.USER_RECORD_KEYS` — the same set the evaluator subtracts, so the two can't disagree.

### Fixed

- **A documented `getGroups` example returned the wrong answer.** Okta's reference writes `user.getGroups({'group.profile.name': 'Engineering.*'})` and explains the result as groups whose name *starts with* `Engineering`. The matcher did a literal `startsWith('Engineering.*')`, so it matched nothing — the example failed exactly as written. A trailing `.*` is now dropped before the prefix comparison. Deliberately only a trailing `.*` and only under `STARTS_WITH`: the docs never call the value a regular expression, and treating it as one would break a group legitimately named `C++ Devs` or `R&D (EU)`. Under an explicit `'operator': 'EXACT'` the value stays literal. Applies to `isMemberOf` too, which shares the criteria matcher.
- **Signature help was missing for 23 functions.** `SIG_INDEX` skipped any signature whose name didn't start with a capital letter. That was aimed at the 15 placeholder-receiver entries the reference uses to document chain methods (`value.toUpperCase()`, `dateValue.withinDays(n)`), but it also threw out every `user.*` method, all seven `isMemberOf*` / `getFilteredGroups` group functions, the entire manager/directory family and the five deprecated forms. The filter now tests the receiver against the two known placeholders, taking the index from 40 real functions to 63.

### Internals

- `parseCriteriaContext` tracks paren/brace/quote state to locate the caret inside a criteria map and decide key-vs-value position; a value written as a set puts the caret one brace deeper than the map, so the key is read from the parent frame. It only fires inside an open quote — criteria keys contain dots, so an unquoted key can't lex, and completing outside the quotes would insert something unparseable.
- `endsWithCallTo(text, fnName)` and `scanChainBefore(text, dotPos)` both walk backward over balanced parens, skipping string literals. Used for the projection-receiver check and the chain trigger respectively.
- `chainValueType(chain)` answers off the profile for a plain path and falls back to evaluating the chain when it contains a call — cheap, since these are a few tokens, and a wrong answer only means no suggestions.
- `acRank` is stable for equal ranks, so a curated order (documented projection fields ahead of tenant-specific ones) survives filtering.
- Mock `groupObjects` carry `objectClass`, a real Okta group field outside the seven documented for projections — without something outside that set the pass-through behavior can't be exercised offline.
- Verification: 112 templates + 82 reference examples against the shipped profile and all six presets (1358 evaluations, zero failures), plus ~60 autocomplete assertions driving `computeAutocomplete` / `parseCriteriaContext` / `parseProjectionContext` / `acceptAutocomplete` directly, plus every verbatim `getGroups`/`isMemberOf` example from Okta's reference.

## [1.4.0] — 2026-09-16

Full audit of the evaluator against Okta's two published Expression Language references — [classic](https://developer.okta.com/docs/reference/okta-expression-language/) and [Identity Engine](https://developer.okta.com/docs/reference/okta-expression-language-in-identity-engine/). The implementation had drifted in both directions: some documented functions were missing (five of them removed in error by 1.3.0), some undocumented ones still evaluated, and several signatures didn't match the docs. The point of this extension is that an expression behaving here behaves the same way in Okta, so both directions of drift are the same bug.

### Added

- **`user.getGroups()` returns group objects**, so every documented collection projection works: `user.getGroups({'group.type': {'OKTA_GROUP'}}).![profile.name]`. Criteria keys are `group.id`, `group.type`, `group.source.id`, and `group.profile.name`; a list value ORs within a key and extra criteria objects AND together, matching `user.isMemberOf`. Readable per group: `id`, `type`, `created`, `lastUpdated`, `lastMembershipUpdated`, `profile.name`, `profile.description` — deliberately a subset of the raw Okta record rather than the whole thing, so a projection can't reach a field Okta doesn't expose. `groups` (name strings) and `groupIds` are unchanged; `Arrays.contains(groups, 'Engineering')` is documented usage and had to keep its shape.
- **`user.getLinkedObject(primaryName)`** now resolves instead of returning `null`. `manager` is Okta's built-in primary name and reads the already-fetched manager profile; a custom relationship answers `null` because the preview has no data for it.
- **`.parseCountryCode()`** returns a CountryCode object with `.toAlpha2()`, `.toAlpha3()`, `.toNumeric()`, `.toName()`, sharing the `Iso3166Convert` lookup table.
- **`.versionGreaterThan()` / `.versionLessThan()`** — segment-wise version comparison for `device.profile.osVersion` and `device.provider.oktaVerify.version`. Comparing those with `<` / `>` sorts lexically, which reports 14.10 as older than 14.9; the Result tab now warns when it sees that.
- **`user.profile.$prop`** resolves. Identity Engine separates profile attributes from the record-level internals read as `user.$property`; both forms now work, and the profile view is derived by excluding record keys so custom attributes are included automatically.
- **Deprecated-but-documented constructs are implemented and flagged.** The five unqualified string functions (`toUpperCase`, `toLowerCase`, `substring`, `substringBefore`, `substringAfter`) and the `matches` operator. Okta's runtime still accepts them, so a legacy expression pasted into the builder now evaluates the way it does in Okta — but the Reference tab badges them, the Quick Insert list marks them, and the Result tab names the current spelling. `matches` uses Java `String.matches` semantics (the pattern must match the whole value), so the documented `user.login matches '.*@example.com'` needs its leading `.*`.
- **Full Identity Engine binding surface.** The mock profile now populates every documented attribute rather than the four it had: `device.id`, `device.assurance.screenLockType`, `device.caller.*`, the twenty `device.profile.*` fields, `device.provider.*` (Okta Verify version, WSC firewall/auto-update, ZTA score, Device Access), `security.behaviors`, `session.id`, `login.identifier`, `accessRequest.*`, and `appuser.entitlements.*`. All of it is browsable in Quick Insert — nested signals are flattened to dotted leaf paths — and all six App Sign-On policy presets set it coherently.
- **New restriction warnings**, each from a documented Okta limitation: `Groups.*` in a property mapping; `Convert.*`/`Time.*`/`Iso3166Convert.*` and runtime signals in a group rule (only `String`, `Arrays`, and `user` are permitted there); `user.status` in a group rule (Okta recommends `getInternalProperty("status")`); `DEPROVISIONED` as a `getInternalProperty("status")` value, which is never one of the seven supported values; `access.scope` and `app.*` in a SAML app; a named app instance in an OAuth/OIDC custom claim; and a version compared with `<` / `>`.
- **17 new templates** covering the Identity Engine signals — 13 under App Sign-On Policy (disk encryption, screen lock strength, the `integrity*` booleans, minimum OS version, Okta Verify freshness, secure hardware, WSC firewall, ZTA score, platform, anomalous behavior, new country, `login.identifier`, and a combined posture check) and 4 under Access Certification (entitlement value, named license, grant-only operations, request type).
- **Inline list literals.** SpEL spells an inline list `{a, b}` and an inline map `{'k': v}` with the same braces, so the parser now decides per entry at the first colon instead of assuming a map. That's what makes `getFilteredGroups({'00g1a2b3c4d5','00g6e7f8g9h0'}, 'group.name', 100)` parse — the docs' own example passes a brace list — and what makes a list-valued criterion like `{'group.type': {'OKTA_GROUP'}}` work. Mixing the two forms inside one pair of braces is a parse error rather than a silent half-read.
- **Chainable results render as values.** A `DateTime` or `CountryCode` in the Result tab used to dump its object shape through `JSON.stringify`. `DateTime` now renders as its timestamp, and `CountryCode` renders as its alpha-2 with a note naming the methods to chain — the object is an intermediate, and an expression ending on one is usually unfinished rather than wrong.
- **Method chaining on numeric values.** A number-typed profile attribute gets its own allow list (`.toInteger()`, `.toNumber()`, `.parseUnixTime()`, `.parseWindowsTime()`), for the same reason strings have one: `Number.prototype` carries `.toFixed`/`.toPrecision`/`.toString`, which would otherwise evaluate here as though they were OEL.
- **Unsupported criteria keys are an error that names the alternatives.** `user.getGroups({'group.bogus': 'x'})` and `getFilteredGroups(..., 'group.bogus', ...)` report the supported key list instead of quietly matching nothing — a criteria typo otherwise reads as "the user isn't in that group."

### Changed

- **`evaluate()` returns a fourth field, `deprecations`** — an array of notes about deprecated constructs the expression uses, collected from the parsed AST so a construct in an untaken ternary branch still reports.
- **`Arrays.*` accept CSV strings** wherever an array is expected, per "CSV strings may be supplied as input to all `Arrays*` functions." Previously they rejected the string with a type error.
- **`user.isMemberOf`'s `operator` defaults to `STARTS_WITH`**, not `EXACT`, matching the docs; it applies only to `group.profile.name`.
- **`Time.fromStringToIso8601(time, format)`** takes its required `format` argument. Without it the input fell through to loose date parsing and a non-ISO string like `01/02/2024` came back as the wrong day.
- **`.parseStringTime(format)`** honors the format argument instead of ignoring it.
- **`.toZone(zoneId)`** actually converts, via `Intl.DateTimeFormat`. It was `return this` — a silent no-op. An unknown zone is now an expression error rather than a quiet fallback to UTC.
- **`getFilteredGroups(allowList, group_expression, limit)`** requires all three arguments, same precedent as 1.3.0's `Groups.*` `limit`.
- **`String.substring` requires all three arguments** in the namespace form, which is how classic documents it. The 1- and 2-argument overloads stay on the method form (`user.email.substring(4)`), which Identity Engine documents separately.
- **`Groups.contains`/`startsWith`/`endsWith` are labeled legacy** in the Reference tab — the docs point at `user.getGroups` with a projection, and these only work in group-claim expressions.
- **Access Certification shows the app picker.** Its `vars` gained `appuser`, without which `appuser.entitlements.*` couldn't be exercised.
- **Method chaining on a primitive is a gate, not a fallback.** Native JS methods used to be reachable on string and array values because the alias table was consulted only after a direct property read missed — so `user.email.padStart(20)`, `.charAt(0)`, `.concat(...)` all evaluated as though they were OEL, and the aliases whose names collide with a native one (`.substring`, `.toUpperCase`) were shadowed by the native version's arity. The allow list is now checked first and is the complete set; anything else reports `'.padStart(...)' is not an Okta Expression Language method on a string`.
- **`Time.now(zoneId)` honors its zone.** The argument was accepted and ignored, so every result came back in UTC regardless. An unknown zone is now an expression error, matching `.toZone()`.
- **`Arrays.*` compare by string value.** A CSV input can only ever yield strings, so `Arrays.contains('1,2,3', 1)` has to match the way Okta's does; `Arrays.remove` follows the same rule.
- **Three group-rule templates use `user.getInternalProperty('status')`** rather than `user.status`, which is the form Okta documents for rule conditions — and, since this release warns about the attribute form, the form that keeps the shipped templates from warning about themselves.
- **Unknown-function errors name OEL.** `'String.toString' is not an Okta Expression Language function` rather than `'toString' is not a function on object` — the old wording read like an internal JS failure for what is really a "that isn't OEL" answer.

### Fixed

- **1.3.0 removed five documented functions in error.** `Arrays.clear` (classic Array functions table) and the method-chain aliases `.toInteger()`, `.toNumber()`, `.parseUnixTime()`, `.parseWindowsTime()` (Identity Engine conversion + time functions) are all in Okta's reference. Expressions using them worked in Okta and failed here. Restored. The other six of 1.3.0's eleven removals were correct and stay out: `String.match`, `String.splitByRegex`, `Convert.toBool`, `Arrays.unique`, `Arrays.intersection`, `Arrays.union`.
- **Undocumented functions removed** — the inverse failure, where the overlay green-lit something Okta rejects: `String.trim`, `String.toString`, `Convert.toString`, and the chain aliases `.trim()`, `.len()`, `.startsWith()`, `.endsWith()`. `String.len(str)` (namespace form) is documented and stays; only the chain alias is gone. This breaks any saved expression that used one — deliberately, because the alternative is the builder disagreeing with the runtime.
- **Prototype-chain leakage in method dispatch.** Methods on the objects the evaluator defines were looked up with a plain property read, so `DateTime.now().hasOwnProperty('_d')`, `.valueOf()`, and `user.countryCode.parseCountryCode().constructor` all evaluated as though they were OEL. Lookup now walks the prototype chain but stops at `Object.prototype`. Same class of bug as the `own()` fix: `Iso3166Convert.toName('constructor')` reported the country name as `Object`, because a function carries a `.name`.
- **Quoted literals in a date format pattern came out quoted.** Formatting was a chain of `String.replace` calls, which has three separate consequences. Joda's single-quote escape wasn't understood, so the standard `"yyyy-MM-dd'T'HH:mm:ss"` emitted `2021-06-15'T'10:00:00` with the quotes still in it. `Z` wasn't a token at all — harmless while everything formatted in UTC and a literal `Z` was accidentally correct, but wrong the moment `.toZone()` started working, so it's a real token now. And `String.replace` with a string needle only replaces the first occurrence, so a pattern naming the same token twice (`'MM/dd/yyyy — MM'`) substituted one and left the other. Formatting and parsing are both token walks now, sharing one pattern vocabulary.
- **Two shipped examples silently evaluated to `null`,** because the mock profile contradicted them rather than because the evaluator was wrong. `Convert.toInt(user.employeeNumber)` and `.toInteger()` read `employeeNumber: 'EMP42'`, which correctly converts to nothing; it's now `'100042'`. `Time.fromStringToIso8601(user.hireDate, 'MM/dd/yyyy')` read `hireDate: '2021-06-15'`, which that format can't parse; `hireDate` is now `'06/15/2021'`, which is also what it's meant to stand in for — an HR-system-sourced string, the reason the function takes a format at all. An example that returns `null` teaches the reader the function is broken.
- **Extension icon now renders.** `manifest.json` pointed all icon sizes (and the toolbar `action` icon) at `icons/icon.svg`, but Chrome and Edge don't support SVG for extension icons — only raster formats. Both surfaces fell back to the default placeholder. Added `icons/icon16.png`, `icons/icon48.png`, and `icons/icon128.png`, exported from the existing SVG, and repointed the manifest at them. `icon.svg` stays in the repo as the editable source; the README documents the re-export command.
- **Toolbar icon legibility at 16px.** The artwork's 7/128 stroke width renders below one pixel at 16px, so the braces disappeared into the dark background and the icon read as a featureless dark square. Added `icons/icon16.svg`, a size-specific variant — lighter background gradient, stroke width 13, brighter cyan/green, larger accent dot — which now sources `icon16.png`. `icon48.png` and `icon128.png` still come from the full-detail `icon.svg`.

### Internals

- **Three named guards against prototype-chain leakage**, the dominant bug class here — found four separate times during the audit. `own(map, key)` for any lookup keyed by a user-supplied identifier; the `*_METHOD_ALIASES` tables as allow lists for primitive receivers; `findMethod(obj, name)` for a non-primitive receiver, walking the chain but stopping at `Object.prototype` so namespace literals (own properties) and the evaluator's own classes (prototype methods) both dispatch while `Object.prototype` stays unreachable. A new lookup has to use one of them.
- **Joda pattern support is table-driven.** `DATE_TOKENS` / `PARSE_TOKENS` are ordered longest-first within each casing so no token is shadowed, and both walks share the single-quote literal rule. `zonedParts` reads calendar fields either in UTC or through `Intl.DateTimeFormat` with `longOffset`, which is what lets `.toZone()` shift the wall-clock reading while leaving the instant alone; the zone rides along through arithmetic, so `.toZone(z).plusDays(1)` stays in `z`.
- **`collectDeprecations(ast)`** walks the parsed tree generically rather than hooking evaluation, which is why an untaken ternary branch still reports. Notes live on the `OEL_SPECS` entry's `deprecated` field — a string, not a boolean, so the replacement text has one home and can't drift from the flag. The `matches` operator has no spec entry (it's an operator, not a call), so its note sits beside the table as `MATCHES_DEPRECATION`.
- **`matches` is a keyword only in operator position.** Unlike `AND`/`OR`/`not` it's a lowercase word that's entirely plausible as a profile attribute or a group-name key, so the lexer checks whether the previous token was a `.` — otherwise `user.matches` would be a parse error instead of a null read.
- **`AT.CSVARR`** is a distinct arg type rather than `AT.ANY`, so `Arrays.*` params accept an array or a comma-separated string and still reject an integer with a useful message.
- **`OEL_SPECS` entries for the user-object methods** (`user.isMemberOf`, `user.getGroups`, `user.getLinkedObject`, `user.getInternalProperty`). The variadic implementations have a JS `Function.length` of 0, so the fallback arity check couldn't catch a bare `user.isMemberOf()` — it returned `false` silently instead of reporting the signature.
- **Signal bases + `mergeSignals`.** `BASE_DEVICE`/`BASE_SESSION`/`BASE_SECURITY`/`BASE_LOGIN` hold the full documented surface and the six policy presets are deltas over them, so a preset can't accidentally leave a documented binding undefined. `DEFAULT_PROFILE` reuses the same bases.
- **`flattenAttrs`** turns nested signal objects into dotted leaf paths for Quick Insert, so `device.provider.oktaVerify.version` is browsable without a per-object special case.
- **`toGroupObject`** normalizes a fetched Okta group down to the fields `user.getGroups` exposes, deriving `source.id` from `_links.source.href`. Deliberately a subset of the raw record so a projection can't reach a field Okta doesn't expose. Threaded through as `profile.groupObjects` alongside the existing `groups`/`groupIds` arrays; when it's absent (mock profile, or a caller passing only the flat arrays) the evaluator synthesizes minimal records so name/id criteria still behave.
- **Restriction entries accept an `fn` predicate** in addition to a `pattern` regex. The named-app-instance check in OAuth Claims needs one: the app roots come from the live profile, so a fixed regex would go stale as more are added.
- **New CSS classes**, all still scoped under `#oeb-root`: `.r-hint` (the chainable-object note), `.warn-dep` (neutral rather than amber — amber means Okta rejects the expression, and a deprecated construct evaluates there just as it does here), `.ref-dep` / `.ref-fn-dep` (Reference-tab badge).
- **Added `CLAUDE.md`** — working notes covering the load-bearing constraints (no build step, no `eval`, zero manifest permissions, CSS scoping), the three-places rule for adding a function, the prototype-leakage guards, the context system's five call sites, and how to test both files headlessly.
- Verification for this release: 106 templates + 82 reference examples evaluated against the shipped profile and all six policy presets — 1316 evaluations, zero failures, zero unexpected deprecations, and zero templates tripping a restriction in their own context. Every entry flagged deprecated does report one.

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
