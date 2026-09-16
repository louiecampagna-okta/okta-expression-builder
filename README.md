# Okta Expression Builder

A Chrome / Edge browser extension that injects a floating overlay into the Okta admin console for building, testing, and live-previewing **Okta Expression Language (OEL)** expressions — without leaving the page.

---

## Features

### Live evaluation against real tenant data

- **Real user testing** — search and select any user in your org; their actual profile attributes, group memberships, and manager are loaded automatically
- **Real app testing** — search and select any app in your org (including AD, LDAP, and other directory sources); the app's `id`, `label`, `signOnMode`, OIDC `clientId`, and custom `app.profile.*` fields all populate from the real app record
- **Real app-user assignment** — when a user + app are both selected, the extension fetches the actual per-app profile (`/api/v1/apps/{appId}/users/{userId}`). If the user is assigned, `appuser.*` reflects the real app schema and credentials. If unassigned, every `appuser.*` reference evaluates to `null` (matching Okta's real runtime behavior) and a warning pill is shown
- **Real manager profile** — when the selected user has a `managerId`, that manager's profile is fetched so expressions like `getManagerUser(user).email` return real values
- **User + app schemas** — the org's user schema and each app's user schema are fetched in the background, so Quick Insert shows every declared attribute even when the current user has no value for it (nulls are dimmed so populated values stay easy to spot)

### Full expression + token preview

- **Live evaluation** — expressions evaluate in real time against the selected user/app/context
- **Full OEL coverage** — `String.*`, `Arrays.*`, `Time.*`, `Convert.*`, `Iso3166Convert.*`, group functions, manager/directory functions, ternary, Elvis (`?:`), null-coalescing (`??`), `AND`/`OR`, the `matches` operator, array index `[n]`, collection projection `.![expr]`, Identity Engine method chaining
- **Group objects, not just names** — `user.getGroups(...)` returns full group records, so every documented projection works: `user.getGroups({'group.type':'OKTA_GROUP'}).![profile.name]`, `.![id]`, `.![lastMembershipUpdated]`. The plain `groups` string array is unchanged, so `Arrays.contains(groups, 'Engineering')` still reads the way it does in Okta.
- **Deprecated constructs still evaluate** — the five unqualified string functions (`toUpperCase`, `substringBefore`, …) and the `matches` operator are documented as deprecated but still accepted by Okta's runtime, so they're implemented here too. Paste a legacy expression in and it evaluates; the Result tab adds an ⓘ note pointing at the current spelling, and the Reference tab badges them.
- **OAuth-time variables** — `client.*`, `oauth_request.*`, `context.oauth2.*`, `context.device`, `context.session`, `context.security` — Okta claim expressions that reference these now resolve rather than throwing
- **Full token preview** (OAuth Claims context) — pick **ID Token** or **Access Token**, pick **Org Auth Server** or any **Custom Authorization Server**. The extension fetches the server's real claim mappings (`/api/v1/authorizationServers/{id}/claims`) and evaluates every active claim in the current context. What you see IS what Okta would emit at runtime:
  - Claims whose `conditions.scopes` don't match the requested scopes are omitted
  - Claims whose expressions error out are silently dropped (matching Okta) — a warning footer lists which ones and why, so tenant config issues are visible
  - The claim you're currently editing overrides the deployed one on name collision so you can see the effect of your edit
- **SAML assertion preview** (SAML context) — full assertion with NameID + AttributeStatement + your edited attribute
- **Group Rule preview** (Group Rules context) — run the current rule against a sample of real users in your org, see pass/fail counts and a list of matches. Validate a rule before saving it in Okta.

### Context-aware UI

- **Context selector** — Profile Mapping, IdP Attribute Mapping, Group Rules, OAuth Claims, SAML, App Sign-On Policy, Inline Hook, Access Certification. The whole overlay adapts:
  - App picker hides in contexts that don't reference `app`/`appuser`
  - App search results are filtered by sign-on mode (OIDC-only for OAuth Claims, SAML-only for SAML)
  - Policy presets appear only in App Sign-On Policy
  - Token/Assertion preview tab appears only in OAuth Claims + SAML
  - Rule Preview tab appears only in Group Rules
  - Context-specific expression warnings still fire, drawn from the restrictions the docs actually state: `appuser`/`Time.*`/`Convert.*` in Group Rules, `user.status` in Group Rules (use `getInternalProperty("status")`), `Groups.*` outside group claims, explicit app references in OIDC custom claims, `access.scope` in SAML, `DEPROVISIONED` as a `getInternalProperty("status")` value, and version strings compared with `<`/`>` instead of `versionGreaterThan()`
- **Policy presets** — six realistic combos for App Sign-On Policy testing (managed corp + pwd+MFA + low risk, unmanaged BYOD + high risk, Kerberos SSO, etc.) swap `device`/`session`/`security` in one click. Each preset carries the full documented device signal surface — platform, disk encryption, screen lock assurance, the five `integrity*` booleans, Okta Verify / WSC / ZTA provider blocks, `security.behaviors` — not just `managed`/`registered`.

### Editor + Quick Insert

- **Syntax highlighting** — expressions are color-coded in place: strings (green), numbers (orange), keywords like `null`/`AND`/`OR` (purple), namespaces (blue bold), roots (blue), function names (teal), operators/parens (grey). Uses a fixed-width font stack that falls back gracefully across macOS/Windows/Linux.
- **Autocomplete with signature help** — type `.` after `user`, `appuser`, `app`, `String`, `Arrays`, etc. and pick a suggestion. Attribute completions show their live value + type inline (`email → "jane@acme.com"`, `groups → [5 items]`, `middleName → null`). Function completions show their param signature. Accepting a function inserts `()` with the cursor between them and immediately fires signature help (`Groups.contains(app, pattern, limit)` with the current arg highlighted). Arrow keys navigate, Enter/Tab inserts, Esc closes.
- **String method chaining** — after a chain that resolves to a string value (`user.email.`), autocomplete suggests Identity Engine method-style completions (`substringBefore`, `toUpperCase`, `toInteger`, `parseStringTime`, `parseCountryCode`, `versionGreaterThan`, etc.). Chains on a date-time value offer the `withinDays` / `plusHours` / `toZone` family.
- **Variable browser** — switch between `user`, `appuser`, `idpuser`, `org`, `app`, `access`, `device`, `session`, `security`, `login`, `accessRequest`; each shows a scrollable, searchable list of attributes with their current values (populated shown first, schema-declared nulls dimmed below).
- **Templates library** — 100+ curated expressions organized by context, spanning all eight contexts including App Sign-On Policy device/risk signals and Access Certification.
- **Function reference** — searchable docs for every OEL function with signatures, descriptions, and click-to-use examples.

### Correctness

- **Strict OEL coverage** — only constructs documented in Okta's [classic OEL reference](https://developer.okta.com/docs/reference/okta-expression-language/) or its [Identity Engine reference](https://developer.okta.com/docs/reference/okta-expression-language-in-identity-engine/) are implemented. Anything that looks like it should exist but isn't in the docs (`String.match`, `String.trim`, `Arrays.union`, `Arrays.intersection`, `Convert.toString`, the `.trim()`/`.len()` chain methods) is deliberately absent — an overlay that green-lights an expression Okta rejects is the same bug as one that rejects an expression Okta accepts. Constructs the docs mark **deprecated** are the one exception: Okta still runs them, so they're implemented and flagged rather than omitted.
- **Arity + type enforcement** — every OEL function has a typed spec; the interpreter refuses to run a call with missing required args or wrong-type args, and produces errors that include the full signature: `Groups.startsWith(app, pattern, limit) — argument 2 ('pattern') must be string, got integer`.
- **Pagination** — every listing endpoint (users, apps, groups, auth servers, claims) follows Okta's `Link: rel="next"` headers so large tenants get full results rather than the first page.

### Other

- **Session-aware** — hidden until a valid Okta session is confirmed; closes automatically if the session expires
- **No eval / no CSP issues** — expressions are parsed and evaluated by a hand-written lexer → parser → tree-walker; no `eval()` or `new Function()`
- **Nothing leaves your browser** — all API calls use your existing admin session cookie; no external services are contacted

---

## Installation

### Chrome
1. Open **chrome://extensions**
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select this folder

### Edge
1. Open **edge://extensions**
2. Enable **Developer mode**
3. Click **Load unpacked** → select this folder

The extension activates on `*.okta.com`, `*.okta-emea.com`, `*.oktapreview.com`, and `*.okta-gov.com`.

---

## Usage

1. Sign in to your **Okta Admin Console**
2. The **`<> OEL Builder`** pill appears in the bottom-right corner
3. Select the **Context** (where the expression will be used) — the overlay reshapes itself accordingly
4. Select a **Test User** — search your org by name or email, or use the default mock profile
5. If the context references `app`/`appuser`: select a **Test App** — search your org by name or label; assignment status is fetched automatically
6. If the context is App Sign-On Policy: pick a **Policy preset** for device/session/security signals
7. Type an expression — the **Result** tab shows the evaluated value; the **Token / Assertion Preview** tab (OAuth Claims / SAML) shows the full token or assertion; the **Rule Preview** tab (Group Rules) evaluates the rule against real org users

### Keyboard shortcut
`Alt + Shift + O` — toggle the overlay from anywhere on an Okta page

### Top-level tabs

| Tab | What it does |
|---|---|
| **Builder** | Expression editor + live result + Token/Assertion preview + Rule preview + quick-insert function/attribute pickers |
| **Reference** | Every OEL function with signature, description, and example |
| **Templates** | Curated expressions filtered by context — click to load in Builder |

### Builder output tabs (context-aware)

| Tab | Visible in | What it shows |
|---|---|---|
| **Result** | Always | The evaluated value of the current expression + context warnings |
| **Token Preview** | OAuth Claims | Full OIDC token JSON. Pick ID vs Access token and Org vs Custom auth server — the extension fetches that server's real claim mappings and evaluates each. Failing/scope-filtered claims are footnoted below the JSON |
| **Assertion Preview** | SAML | Full SAML assertion (NameID + AttributeStatement) |
| **Rule Preview** | Group Rules | Runs the current expression against a sample of real org users. Shows pass/fail counts + matching users |

---

## Expression Language Quick Reference

```js
// String
String.substringBefore(user.email, '@')
String.substringAfter(user.email, '@')
String.toUpperCase(user.department)
String.stringContains(user.email, 'okta.com')
String.replace(user.displayName, '\\s+', '.')
String.stringSwitch(user.department, 'Other', 'Engineering', 'dev', 'IT', 'ops')
String.substring(user.firstName, 0, 1)             // endIndex required in the namespace form

// Identity Engine method chaining
user.email.substringBefore('@')
user.firstName.substring(0, 1)                     // 1- and 2-arg overloads documented on the method form
user.employeeNumber.toInteger()
user.countryCode.parseCountryCode().toName()
device.profile.osVersion.versionGreaterThan('14.0')

// Arrays — a CSV string may be supplied anywhere an array is expected
Arrays.contains(groups, 'Engineering')
Arrays.contains('a,b,c', 'b')
Arrays.toCsvString(groups)
Arrays.clear(groups)

// Groups — user.getGroups returns full group records, so projections work
user.getGroups({'group.type': 'OKTA_GROUP'}).![profile.name]
user.isMemberOf({'group.profile.name': 'Eng'})     // operator defaults to STARTS_WITH
isMemberOfGroupName('Engineering')
isMemberOfAnyGroup('Admins', 'IT', 'DevOps')
isMemberOfGroupNameStartsWith('IT_')
getFilteredGroups({'00g1a2b3c4d5'}, 'group.name', 100)

// Time
Time.now('UTC', 'YYYY-MM-dd')
Time.fromWindowsToIso8601(user.pwdLastSet)              // AD pwdLastSet → ISO 8601
Time.fromStringToIso8601(user.hireDate, 'MM/dd/yyyy')   // format is required
user.created.parseStringTime().withinDays(30)
user.created.parseStringTime().toZone('Asia/Tokyo')     // real zone shift, not a no-op

// Convert & Country
Convert.toInt(user.employeeNumber)
Iso3166Convert.toName(user.countryCode)

// Org
org.name
org.subDomain

// Conditionals
user.department == 'Engineering' ? 'dev' : 'user'
user.nickName ?: user.firstName                   // Elvis operator

// user.$property vs user.profile.$prop — Identity Engine distinguishes them
user.status                                       // fixed set: id, status, created, lastUpdated, …
user.profile.department                           // anything declared on the profile

// AD / appuser
appuser.sAMAccountName
appuser.memberOf[0]
Arrays.contains(appuser.memberOf, 'CN=Engineering,OU=Groups,DC=corp,DC=com')
findDirectoryUser().sAMAccountName
user.getLinkedObject('manager').lastName

// IdP
idpuser.email
idpuser.role ?: 'user'

// OAuth-time (Custom Authorization Server claim expressions)
client.id
client.name
oauth_request.client_id
oauth_request.scope
context.oauth2.request.scope
context.device.profile.managed

// App Sign-On Policy — Identity Engine device / session / risk signals
device.profile.platform                           // IOS | ANDROID | MACOS | WINDOWS | …
device.profile.integrityJailbreak
device.profile.diskEncryptionType
device.assurance.screenLockType                   // BIOMETRIC | PASSCODE | NONE
device.provider.zta.overall
device.provider.oktaVerify.version.versionGreaterThan('9.20.0')
security.risk.level                               // LOW | MEDIUM | HIGH
Arrays.contains(security.behaviors, 'New IP')
session.amr
login.identifier

// Access Certification
accessRequest.metadata.type
appuser.entitlements.role

// Manager traversal (real profile fetched when the user has a managerId)
getManagerUser(user).email
getManagerUser(user).displayName

// Deprecated but still accepted by Okta — these evaluate and get flagged
toUpperCase(user.department)                      // → String.toUpperCase(...)
substringBefore(user.email, '@')                  // → String.substringBefore(...)
user.login matches '.*@acme.com'                  // whole-string match, hence the leading .*
```

---

## Project Structure

```
├── manifest.json      Chrome/Edge extension manifest (MV3)
├── evaluator.js       OEL lexer → parser → interpreter (no eval/CSP issues)
├── content.js         Overlay UI injected into the Okta admin console
├── overlay.css        Okta Odyssey-aligned styles (fully scoped under #oeb-root)
├── icons/
│   ├── icon.svg       Icon source, full detail → icon48.png + icon128.png
│   ├── icon16.svg     Icon source, retuned for legibility at 16px → icon16.png
│   ├── icon16.png     Toolbar icon
│   ├── icon48.png     Extensions-page icon
│   └── icon128.png    Store / install-dialog icon
├── CHANGELOG.md       Version history
└── README.md
```

---

## Development

The extension is pure vanilla JS + CSS + HTML — no build step, no bundler, no runtime dependencies. To iterate:

1. Clone the repo and open the folder in your editor of choice
2. Load it unpacked in `chrome://extensions` (or `edge://extensions`) with **Developer mode** on
3. Edit any file — reload the extension from `chrome://extensions` and refresh your Okta admin tab to see changes
4. Run a syntax sanity check before committing: `node --check evaluator.js && node --check content.js`

The evaluator is testable headlessly, which beats clicking through the overlay for every change: it assigns a global, so `require('./evaluator.js')` works in plain Node with no DOM stubbing, and `evaluate()` returns `{success, result, error, deprecations}`. `content.js` needs more care — it's one IIFE with DOM access, so lift its data tables out by slicing lines rather than requiring the file, and find the slice boundaries by marker regex, since the tables move on every edit.

Chrome and Edge do **not** support SVG for extension icons — only raster formats. The SVGs are the editable sources; the three PNGs beside them are what `manifest.json` actually references. There are two sources because the artwork is thin-stroked and illegible at 16px, so the toolbar icon uses a retuned variant (lighter background, thicker strokes, brighter accents). After editing either SVG, re-export (macOS, no extra tooling required):

```sh
# 48 + 128 from the full-detail source
qlmanage -t -s 512 -o /tmp/oelicon icons/icon.svg
for s in 48 128; do
  cp /tmp/oelicon/icon.svg.png "icons/icon$s.png"
  sips -Z $s "icons/icon$s.png"
done

# 16 from the small-size source
qlmanage -t -s 512 -o /tmp/oelicon icons/icon16.svg
cp /tmp/oelicon/icon16.svg.png icons/icon16.png
sips -Z 16 icons/icon16.png
```

Rendering at 512 and downsampling gives smoother antialiasing than rendering each size natively. Keep the two sources visually in sync when changing the design.

### Architecture

- `evaluator.js` — self-contained OEL implementation. Hand-written lexer (character-by-character), recursive-descent parser producing a small AST, and tree-walking interpreter. `OEL_SPECS` maps every function name to its full signature + typed parameters; the interpreter consults this at every call for arity + type validation. Exports a single global `OELEvaluator` class. Zero use of `eval()` or `new Function()` so the extension runs under strict CSPs.
- `content.js` — everything UI. Injects an overlay into the admin console DOM, handles user/app/manager/schema fetches, tabbed output rendering, autocomplete + signature help, syntax highlighting, and token/rule preview generation. All styles are scoped under `#oeb-root` to avoid clashing with Okta's own CSS.
- `overlay.css` — token colors, layout, and Okta Odyssey-aligned styling. Every rule is prefixed with `#oeb-root` so nothing leaks out.
- `manifest.json` — MV3 manifest with no permissions declared. The extension only accesses same-origin Okta APIs using the browser's existing admin session cookie.

### Contributing

Bugs and feature requests welcome via GitHub issues. When submitting a PR:

- Keep the file layout — no build tools, no dependencies. This has to stay a load-unpacked extension anyone can inspect.
- If you're adding an OEL function, verify it's in Okta's official OEL reference — [classic](https://developer.okta.com/docs/reference/okta-expression-language/) or [Identity Engine](https://developer.okta.com/docs/reference/okta-expression-language-in-identity-engine/) — and cite where. Adding or removing one means editing **three** places or it half-works: the namespace implementation in `evaluator.js`, its `OEL_SPECS` entry (arity + typed params + full signature string), and its `FUNCTION_REFERENCE` entry in `content.js`.
- Don't remove a function without checking the docs first. Release 1.3.0 removed eleven as "non-OEL" and five of them turned out to be documented; they had to be restored. If the docs mark something deprecated, implement it and set `deprecated` on its spec — don't omit it.
- Any expression you add to `TEMPLATES` or as a `FUNCTION_REFERENCE` example has to evaluate against the shipped mock profile *and* all six policy presets. A silently-`null` example is a bug — if the mock data contradicts the example, fix the data.
- Update `CHANGELOG.md` under an `[Unreleased]` section with a brief note under Added / Changed / Fixed.

---

## Notes

- **Client-side only** — no expression or user data is sent to any external server
- **Uses your existing Okta session** — API calls use the browser's existing admin session cookie; no API token is required. Endpoints hit:
  - `/api/v1/sessions/me` — session gating
  - `/api/v1/org` — org name / subdomain
  - `/api/v1/users?q=...` and `/api/v1/users/{id}` — user search + manager lookup
  - `/api/v1/users/{id}/groups` — group memberships. The full group records are retained, not just their names: `groups` and `groupIds` stay the flat string arrays they've always been, and `id` / `type` / `created` / `lastUpdated` / `lastMembershipUpdated` / `profile.*` are kept alongside so `user.getGroups(...)` criteria and projections resolve against real data
  - `/api/v1/apps?q=...` — app search
  - `/api/v1/apps/{appId}/users/{userId}` — app-user assignment
  - `/api/v1/meta/schemas/user/default` and `/api/v1/meta/schemas/apps/{appId}/default` — declared attribute schemas
  - `/api/v1/authorizationServers` and `/api/v1/authorizationServers/{id}/claims` — full token preview
- The evaluator is a JavaScript re-implementation of the OEL/SpEL subset; edge cases in complex regex or date expressions may differ slightly from Okta's server-side engine
- **Token/Rule preview fidelity** — the preview matches Okta's runtime for the common cases (scope filtering, claim errors dropped, assignment-gated appuser). Some details differ: `iat`/`exp` are fixed epochs so previews are reproducible; group-based claims are approximated locally against the fetched group list

See [CHANGELOG.md](./CHANGELOG.md) for the full history of features and changes.
