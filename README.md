# Okta Expression Builder

A Chrome / Edge browser extension that injects a floating overlay into the Okta admin console for building, testing, and live-previewing **Okta Expression Language (OEL)** expressions — without leaving the page.

---

## Features

- **Live evaluation** — expressions evaluate in real time against a real or mock user profile
- **Real user testing** — search and select any user in your org; their actual profile attributes and group memberships are loaded automatically
- **Full OEL coverage** — `String.*`, `Arrays.*`, `Time.*`, `Convert.*`, `Iso3166Convert.*`, group functions, manager/directory functions, ternary, Elvis (`?:`), null-coalescing (`??`), `AND`/`OR`, array index `[n]`, collection projection `.![expr]`, Identity Engine method chaining
- **Context-aware** — select where your expression will be used (Profile Mapping, Group Rules, OAuth Claims, SAML, App Sign-On Policy, etc.); context-specific warnings appear when restricted functions are used
- **Variable browser** — switch between `user`, `appuser`, `idpuser`, `org`, `app`, and `access` contexts; each shows a scrollable list of attributes and their current values
- **Templates library** — 60+ curated expressions organized by context (Profile Mapping, Active Directory, App Mapping, Group Rules, HR Integration, Security & Auth, Time & Date, IdP Attribute Mapping)
- **Function reference** — searchable docs for every OEL function with signatures, descriptions, and click-to-use examples
- **Session-aware** — hidden until a valid Okta session is confirmed; closes automatically if the session expires
- **No eval / no CSP issues** — expressions are parsed and evaluated by a hand-written lexer → parser → tree-walker; no `eval()` or `new Function()`

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
3. Select the **Context** (where the expression will be used)
4. Select a **Test User** — search your org by name or email, or use the default mock profile
5. Type an expression and see the result update live

### Keyboard shortcut
`Alt + Shift + O` — toggle the overlay from anywhere on an Okta page

### Tabs

| Tab | What it does |
|---|---|
| **Builder** | Expression editor + live result + quick-insert function/attribute pickers |
| **Reference** | Every OEL function with signature, description, and example |
| **Templates** | Curated expressions filtered by context — click to load in Builder |

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

// Arrays
Arrays.contains(groups, 'Engineering')
Arrays.toCsvString(groups)
user.getGroups('Eng')

// Time
Time.now('UTC', 'YYYY-MM-dd')
Time.fromWindowsToIso8601(user.pwdLastSet)       // AD pwdLastSet → ISO 8601
user.created.parseStringTime().withinDays(30)     // Identity Engine style

// Convert & Country
Convert.toInt(user.employeeNumber)
Iso3166Convert.toName(user.countryCode)

// Groups
isMemberOfGroupName('Engineering')
isMemberOfAnyGroup('Admins', 'IT', 'DevOps')
isMemberOfGroupNameStartsWith('IT_')

// Org
org.name
org.subDomain

// Conditionals
user.department == 'Engineering' ? 'dev' : 'user'
user.nickName ?: user.firstName                   // Elvis operator
user.isMemberOf({'group.profile.name': 'Admins'}) // Identity Engine

// AD / appuser
appuser.sAMAccountName
appuser.memberOf[0]
Arrays.contains(appuser.memberOf, 'CN=Engineering,OU=Groups,DC=corp,DC=com')
findDirectoryUser().sAMAccountName

// IdP
idpuser.email
idpuser.role ?: 'user'
```

---

## Project Structure

```
├── manifest.json      Chrome/Edge extension manifest (MV3)
├── evaluator.js       OEL lexer → parser → interpreter (no eval/CSP issues)
├── content.js         Overlay UI injected into the Okta admin console
├── overlay.css        Okta Odyssey-aligned styles (fully scoped under #oeb-root)
├── icons/
│   └── icon.svg       Extension icon
└── README.md
```

---

## Notes

- **Client-side only** — no expression or user data is sent to any external server
- **Uses your existing Okta session** — API calls to `/api/v1/users`, `/api/v1/org`, and `/api/v1/sessions/me` use the browser's existing admin session cookie; no API token is required
- The evaluator is a JavaScript re-implementation of the OEL/SpEL subset; edge cases in complex regex or date expressions may differ slightly from Okta's server-side engine
