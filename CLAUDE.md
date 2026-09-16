# Okta Expression Builder — working notes

A Chrome/Edge MV3 content script that injects a floating overlay into the Okta admin console for building and live-previewing Okta Expression Language (OEL) expressions against real tenant data.

## Hard constraints — do not break these

These are load-bearing. Violating any one of them breaks the extension or its reason for existing.

- **No build step, no bundler, no dependencies.** This has to stay a folder anyone can `Load unpacked` and read. Four source files, vanilla JS/CSS. Don't add npm, TypeScript, a framework, or a transpile step.
- **No `eval()` and no `new Function()`.** The Okta admin console runs under a strict CSP. That's the entire reason `evaluator.js` is a hand-written lexer → parser → tree-walker instead of a thin wrapper around `eval`. Any "simplification" that reintroduces dynamic code execution will fail at runtime, not at review.
- **Every CSS rule stays scoped under `#oeb-root`.** Unscoped rules leak into Okta's own UI.
- **`manifest.json` declares zero `permissions`.** All API access is same-origin `fetch` with `credentials: 'include'`, riding the existing admin session cookie. Adding a permission changes the install prompt and the trust story — don't do it to solve a problem that same-origin fetch already solves.
- **Nothing leaves the browser.** No external hosts, no telemetry, no CDN.
- **Extension icons must be raster.** Chrome/Edge don't support SVG for extension icons. `icons/icon.svg` is the source; `manifest.json` points at the PNGs.

## Strict OEL fidelity

The evaluator implements **exactly** the functions documented in Okta's two published references — [classic](https://developer.okta.com/docs/reference/okta-expression-language/) and [Identity Engine](https://developer.okta.com/docs/reference/okta-expression-language-in-identity-engine/). Both directions of drift are the same bug: a missing documented function means an expression that works in Okta fails here, and an undocumented one means the overlay green-lights something Okta rejects. **Read the docs, don't infer.** During the Unreleased audit two restriction warnings were written from inference and both were wrong — the docs disallow *explicit app-instance* references in OIDC custom claims (not the generic `app.*` binding, which they list as usable), and they *recommend* `getInternalProperty("status")` in group rules rather than forbidding `user.status`. Six shipped templates warned about themselves before that got checked.

**Absent on purpose** — verify against the docs before "restoring" any of these: `String.match`, `String.splitByRegex`, `Convert.toBool`, `Arrays.unique`, `Arrays.intersection`, `Arrays.union`, `String.trim`, `String.toString`, `Convert.toString`, and the chain aliases `.trim()`, `.len()`, `.startsWith()`, `.endsWith()`. (`String.len(str)`, the namespace form, IS documented — only the chain alias is gone.)

**Documented, so do not remove** — 1.3.0 removed these five as "non-OEL" and was wrong; expressions using them work in Okta: `Arrays.clear` (classic Array functions table) and the chain aliases `.toInteger()`, `.toNumber()`, `.parseUnixTime()`, `.parseWindowsTime()` (Identity Engine conversion + time functions).

**Deprecated-but-documented constructs are implemented, not omitted** — Okta's runtime still accepts them, so a legacy expression pasted into the builder has to behave the way it behaves in Okta. They're visibly flagged instead: the five unqualified string functions (`toUpperCase`, `toLowerCase`, `substring`, `substringBefore`, `substringAfter`) and the `matches` operator. `deprecated` on the `OEL_SPECS` entry carries the replacement note and is the single source for it — `collectDeprecations` reads it off the parsed AST and `evaluate()` returns the notes as `deprecations`, which `runEval` renders in the Result tab. `FUNCTION_REFERENCE` carries its own `deprecated: true` for the Reference-tab badge and the Quick Insert marker. Note that the marker is in Quick Insert rather than autocomplete: autocomplete only fires after a `.`, and every deprecated construct is an unqualified call or an operator, so none can ever appear there.

Adding a function means touching **three** places, or it will half-work:

1. The implementation in the relevant namespace in `evaluator.js`
2. An `OEL_SPECS` entry (`OEL_SPECS:591`) — full signature string + typed params, `optional: true` only where Okta genuinely allows omission
3. A `FUNCTION_REFERENCE` entry (`content.js:444`) — this drives both the Reference tab and autocomplete

`checkCall` (`evaluator.js:784`) enforces arity and arg types against `OEL_SPECS` on every call, and error messages embed the signature. Omitting the spec silently disables that validation.

### Prototype-chain leakage

The dominant bug class in this evaluator, found four separate times. Any map indexed by a user-supplied identifier leaks `Object.prototype`; any primitive receiver leaks `String`/`Array`/`Number.prototype`. Without guards, `Iso3166Convert.toName('constructor')` reports the country name as `Object` (a function carries a `.name`), `String.toString(x)` answers `"[object Object]"`, and `user.email.padStart(20)` evaluates as though it were OEL.

Three guards, and a new lookup has to use one of them:

- **`own(map, key)`** — own-property read. Every lookup keyed by a user-supplied identifier.
- **The `*_METHOD_ALIASES` tables** — allow lists for primitive receivers. A method not in the table is rejected rather than falling through to the native one.
- **`findMethod(obj, name)` (`evaluator.js:751`)** — walks the prototype chain for a non-primitive receiver but stops at `Object.prototype`, so namespace literals (own properties) and the classes defined here (`OELDateTime`, `OELCountryCode`, prototype methods) both dispatch while `Object.prototype` stays unreachable.

## File map

| File | Contents |
|---|---|
| `manifest.json` | MV3 manifest. No permissions. Injects `evaluator.js` + `content.js` + `overlay.css` at `document_end` on Okta domains. |
| `evaluator.js` (1358 ln) | Self-contained OEL engine. IIFE exporting a single global `OELEvaluator` (`evaluator.js:1332`). |
| `content.js` (3156 ln) | All UI, all Okta API calls, autocomplete, highlighting, previews. One big IIFE. |
| `overlay.css` (696 ln) | Okta Odyssey-aligned styles, all under `#oeb-root`. |

### evaluator.js landmarks

`OELDateTime:89` · `Lexer:189` · `Parser:284` (recursive descent: ternary → elvis → or → and → eq → rel → add → mul → unary → postfix → primary; `matches` is an infix rule in `parseRel`) · `OELCountryCode:485` · `STRING_METHOD_ALIASES:518` / `NUMBER_METHOD_ALIASES:556` / `ARRAY_METHOD_ALIASES:564` (Identity Engine method chaining — allow lists, not fallbacks) · `OEL_SPECS:591` · `collectDeprecations:718` · `findMethod:751` · `checkCall:784` · `Interpreter:806` · `buildContext:971` · `OELEvaluator:1332`

### content.js landmarks

`LS:12` (localStorage keys) · `CONTEXTS:22` · `BASE_DEVICE:139` / `mergeSignals:197` (signal bases the presets are deltas over) · `POLICY_PRESETS:210` · `DEFAULT_PROFILE:301` · `FUNCTION_REFERENCE:444` · `TEMPLATES:586` · `GLOBAL_RESTRICTIONS:740` / `getWarnings:756` · `state:766` · `flattenAttrs:854` · `buildVarTabs:901` · `runEval:1166` · token preview `evaluateAuthServerClaims:1254`, `renderTokenPreview:1334` · syntax highlighting `highlightOEL:1471` · `runGroupRulePreview:1555` · fetch layer `parseNextLink:1781`, `fetchPaginated:1802`, `toGroupObject:1842` and the `fetch*` functions through ~2200 · autocomplete `computeAutocomplete:2511`, `acceptAutocomplete:2673` · signature help `parseSignature:2729`, `SIG_INDEX:2759`, `parseCallContext:2777` · `checkSession:3076` · `init:3099`

Line numbers drift — grep the identifier rather than trusting the number.

## Context system

`CONTEXTS` (`content.js:22`) is the spine of the UI. Eight ids: `profile_mapping`, `idp_attr_mapping`, `group_rules`, `oauth_claims`, `saml`, `app_sign_on`, `inline_hook`, `access_cert`. Each declares the `vars` available in it, and that drives:

- which variable tabs appear in Quick Insert (`buildVarTabs:901`)
- whether the app picker shows at all (`contextUsesApp:1683`)
- app search filtering by sign-on mode (`contextAppFilter:2206` — OIDC-only for OAuth Claims, SAML-only for SAML)
- which output tabs exist (`updateOutputTabs:1716` — Token Preview for `oauth_claims`/`saml`, Rule Preview for `group_rules`)
- context-specific expression warnings (`getWarnings:756`)

Adding a context means updating `CONTEXTS` and then checking each of those call sites. `vars` is also what makes a binding reachable: Access Certification only shows the app picker because its `vars` includes `appuser`, without which `appuser.entitlements.*` can't be exercised at all.

A `vars` entry additionally has to be registered in four sets or it half-works — `ALL_VARS` (in `buildVarTabs`), `HL_ROOTS:1467` (syntax highlighting), `AC_ROOTS:2443` (autocomplete), and `DEFAULT_PROFILE` (so there's something to browse).

### Warnings vs. deprecations

Two separate mechanisms rendering into the same box, with different meanings — don't merge them:

- **Restrictions** (`getWarnings`) are per-context or global regex/predicate rules meaning *Okta rejects this here*. Amber ⚠. Every one traces to a documented limitation. `GLOBAL_RESTRICTIONS:740` holds the context-independent ones.
- **Deprecations** come from the evaluator's `deprecated` specs and mean *Okta still accepts this, but there's a current spelling*. Neutral ⓘ.

`/tmp`-style check worth repeating after touching either: no shipped template may warn in its own context, and every restriction should fire on the offending form while staying silent on the correct one.

## The `-admin` subdomain problem

Some tenants serve the admin console from `tenant-admin.okta.com` while the API/issuer live at `tenant.okta.com`. Two places compensate, and both are easy to regress:

- **`parseNextLink:1477`** strips pagination `Link: rel="next"` URLs down to `pathname + search` so the browser resolves them against the current admin origin. Okta returns absolute URLs pointing at the non-admin host; following them verbatim is a cross-origin rejection.
- **`renderTokenPreview`** builds the `iss` claim from `hostname.replace(/-admin\./, '.')` — real tokens are issued from the user-facing host.

Use `fetchPaginated(url, {maxPages})` for any new listing endpoint rather than a bare `fetch`. Every caller caps `maxPages` so a huge tenant can't spin forever.

## Preview fidelity — deliberate divergences

The token/rule previews aim to match Okta's runtime, including its unhelpful behaviors:

- Claims whose `conditions.scopes` don't match requested scopes are **omitted**
- Claims whose expressions error are **silently dropped** (as Okta does), then listed in a warning footer so tenant misconfig stays visible
- Unassigned user+app → every `appuser.*` evaluates to `null`, matching real runtime, plus a warning pill

Known intentional differences: `iat`/`exp` are a fixed epoch (`1735689600`) so previews are reproducible, and group-based claims are approximated locally against the fetched group list. Don't "fix" these without a reason — reproducibility is the point.

## Verifying a change

There are no tests. The check before committing is:

```sh
node --check evaluator.js && node --check content.js
```

The evaluator is headlessly testable, which is worth using rather than clicking through the overlay for every change: the IIFE assigns `global.OELEvaluator`, so `require('./evaluator.js')` works in plain Node with no stubbing. `evaluate()` returns `{success, result, error, deprecations}` — the field is `result`, not `value`.

`content.js` can be tested too, though it needs more care: it's one IIFE with DOM access, so lift the data tables out by slicing lines into `new Function` with a `window`/`esc` stub rather than requiring the file. **Find the slice boundaries by marker regex, not by line number** — the tables move on every edit, and a stale slice surfaces as a confusing `SyntaxError` instead of a test failure. Testing against the real `DEFAULT_PROFILE` and `POLICY_PRESETS` rather than a hand-written mock is the point: a hand-written mock silently passes expressions that reference bindings the shipped profile doesn't populate.

Three checks worth re-running after any evaluator or table change: every shipped `TEMPLATES.expr` and `FUNCTION_REFERENCE.ex` evaluates (against the real profile *and* each of the six presets); no shipped template trips a restriction in its own context; and no non-deprecated expression reports a deprecation.

Then reload the extension at `chrome://extensions` and hard-refresh the Okta admin tab. Overlay state persists in `localStorage` under the `oeb_*` keys (`LS:12`) — clear those when testing first-run behavior.

Re-exporting icons (macOS, no extra tooling). **Two sources**: `icon.svg` is the full-detail artwork and feeds 48/128; `icon16.svg` is a retuned variant (lighter background, stroke 7→13, brighter accents, larger dot) that feeds the 16px toolbar icon, because the original's sub-pixel strokes vanish at that size. Keep them visually in sync.

```sh
qlmanage -t -s 512 -o /tmp/oelicon icons/icon.svg
for s in 48 128; do cp /tmp/oelicon/icon.svg.png "icons/icon$s.png"; sips -Z $s "icons/icon$s.png"; done

qlmanage -t -s 512 -o /tmp/oelicon icons/icon16.svg
cp /tmp/oelicon/icon16.svg.png icons/icon16.png && sips -Z 16 icons/icon16.png
```

Render at 512 and downsample — it antialiases better than rendering each size natively. Judge a 16px icon by viewing it at actual size; upscaled previews hide exactly the problem you're checking for.

## Conventions

- Update `CHANGELOG.md` under `[Unreleased]` (Added / Changed / Fixed / Internals) as you go; releases roll that into a version heading.
- Releases are tracked in the CHANGELOG only — the repo has no git tags.
- Okta API endpoints in use are enumerated at the bottom of `README.md`; keep that list current when adding a call.
