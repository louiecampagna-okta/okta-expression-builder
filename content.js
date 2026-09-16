/**
 * Okta Expression Builder — Content Script
 * Three-tab overlay: Builder · Reference · Templates
 * Toggle: Alt+Shift+O  or click the pill.
 */

(function () {
  'use strict';
  if (document.getElementById('oeb-root')) return;

  // ── Storage keys ──────────────────────────────────────────────
  const LS = {
    VISIBLE:'oeb_visible', MIN:'oeb_min', TAB:'oeb_tab',
    CTX:'oeb_ctx', EXPR:'oeb_expr', POS:'oeb_pos',
    TOKEN_TYPE:'oeb_token_type', AUTH_SERVER:'oeb_auth_server',
  };

  // ── OEL Contexts ─────────────────────────────────────────────
  // Matches where expressions are entered in the Okta admin console
  // `vars` = context objects available in this expression context.
  // Used to drive the variable-switcher chip tabs in Quick Insert.
  const CONTEXTS = [
    {
      id: 'profile_mapping',
      label: 'Profile Mapping',
      desc: 'Profile editor — map attributes between Okta user profile and an app profile',
      vars: ['user', 'appuser', 'org'],
      restrictions: [
        { pattern: /\bGroups\./, msg: 'Groups.* functions only work in group-claim expressions on an authorization server — they cannot be used in a property mapping' },
      ],
    },
    {
      id: 'idp_attr_mapping',
      label: 'IdP Attribute Mapping',
      desc: 'Map attributes from an external Identity Provider (SAML/OIDC IdP) into the Okta user profile',
      vars: ['user', 'idpuser', 'org'],
      restrictions: [
        { pattern: /\bappuser\./, msg: 'appuser is not available in IdP attribute mapping — use idpuser to reference incoming IdP attributes' },
        { pattern: /\bGroups\./,  msg: 'Groups.* functions only work in group-claim expressions on an authorization server — they cannot be used in an attribute mapping' },
      ],
    },
    {
      id: 'group_rules',
      label: 'Group Rules',
      desc: 'Dynamic group membership criteria',
      vars: ['user'],
      // Group rules accept only String.*, Arrays.*, and user expressions.
      // Everything below is documented as rejected — Okta's own example of an
      // invalid rule is `Convert.toInt("2018") == user.yearJoined`.
      restrictions: [
        { pattern: /\bTime\./,    msg: 'Time functions are not available in Group Rules — only String, Arrays, and user expressions are permitted' },
        { pattern: /\bConvert\./, msg: 'Convert functions are not available in Group Rules — only String, Arrays, and user expressions are permitted. Compare as strings instead of converting' },
        { pattern: /\bIso3166Convert\./, msg: 'Iso3166Convert functions are not available in Group Rules — only String, Arrays, and user expressions are permitted' },
        { pattern: /\bGroups\./,  msg: 'Groups.* functions only work in group-claim expressions on an authorization server — they cannot be used in a group rule' },
        { pattern: /\bappuser\./, msg: 'appuser is not available in Group Rules' },
        { pattern: /\bidpuser\./, msg: 'idpuser is not available in Group Rules' },
        { pattern: /\bdevice\.|\bsession\.|\bsecurity\.|\blogin\./,
          msg: 'Sign-in runtime signals (device, session, security, login) are not available in Group Rules — group membership is evaluated outside a sign-in' },
        // Not an error — the docs recommend the function form for group rules
        // rather than forbidding the attribute.
        { pattern: /\buser\.status\b(?!\s*\.)/,
          msg: 'Prefer user.getInternalProperty("status") in Group Rules — Okta documents that form for rule conditions' },
        { pattern: /getManager|getAssistant|findDirectory|hasDirectory|findWorkday|hasWorkday/,
          msg: 'Manager and Directory functions are not available in Group Rules' },
      ],
    },
    {
      id: 'oauth_claims',
      label: 'OAuth 2.0 / OIDC Claims',
      desc: 'Customize token claims — requires a custom authorization server (not the org authorization server)',
      vars: ['user', 'appuser', 'org', 'app', 'access'],
      restrictions: [
        { fn: (e) => e.length > 1024, msg: 'Expression exceeds the 1024-character limit for OAuth claims' },
        // "Explicit references to apps aren't supported for OAuth 2.0/OIDC
        // custom claims." That's about naming an app *instance*
        // (`active_directory.sAMAccountName`); the generic `app.*` binding is
        // documented as usable here, so it's deliberately not flagged. The
        // named-app roots come from the profile so this stays accurate as more
        // are added.
        { fn: (e) => Object.keys((state.profile && state.profile.apps) || {})
                       .some(k => new RegExp(`\\b${k}\\.`).test(e)),
          msg: 'Explicit references to a named app instance are not supported in OAuth/OIDC custom claims — the claim is evaluated for whichever client requested the token. Use appuser.* or client.*' },
      ],
    },
    {
      id: 'saml',
      label: 'SAML Attribute Statements',
      desc: 'Customize SAML response attribute values for an application',
      vars: ['user', 'appuser', 'org'],
      restrictions: [
        // `access.*` and `app.*` are OAuth/OIDC claim bindings; the docs state
        // those expressions don't work for SAML 2.0 apps. They resolve to null
        // rather than erroring, which is exactly why they need flagging.
        { pattern: /\baccess\./,
          msg: "access.* is an OAuth 2.0 binding and doesn't work for SAML apps — scopes do not exist in a SAML assertion flow" },
        { pattern: /\bapp\./,
          msg: "app.* claim expressions don't work for SAML 2.0 apps — reference the user or appuser profile instead" },
        { pattern: /\bGroups\./,
          msg: 'Groups.* functions only work in group-claim expressions on an authorization server — for SAML group attributes use isMemberOfGroupName / getFilteredGroups' },
      ],
    },
    {
      id: 'app_sign_on',
      label: 'App Sign-On Policy',
      desc: 'Authentication and authorization policy conditions (Identity Engine)',
      vars: ['user', 'device', 'security', 'session', 'login'],
      restrictions: [
        { pattern: /\buser\.status\b(?!\s*\.)/, msg: 'Use user.getInternalProperty("status") — direct user.status access is not supported in policy expressions' },
      ],
    },
    {
      id: 'inline_hook',
      label: 'Inline Hook',
      desc: 'Dynamic decision logic injected into authentication flows',
      vars: ['user', 'org', 'app'],
      restrictions: [],
    },
    {
      id: 'access_cert',
      label: 'Access Certification',
      desc: 'Identity Governance — user eligibility rules for certification campaigns',
      vars: ['user', 'org', 'appuser', 'accessRequest'],
      restrictions: [],
    },
  ];

  // ── Identity Engine runtime signals ───────────────────────────
  // device.*, session.*, security.*, and login.* are populated by Okta during a
  // real sign-in. Nothing in the API can return them, so they're mocked — but
  // mocked across the whole documented surface, because a policy expression that
  // reads `device.profile.diskEncryptionType` needs *something* there or it
  // silently evaluates to null and the author can't tell a typo from a
  // legitimately-absent signal.
  //
  // A managed, registered, healthy corporate Mac. The six POLICY_PRESETS below
  // are deltas over this base rather than standalone objects: a preset only
  // differs in a handful of signals, and duplicating thirty fields six times is
  // how they'd drift apart.
  const BASE_DEVICE = {
    id: 'guo4a5u7JHHhjXrEK0g4',
    // Screen-lock strength as assessed by Okta Verify: NONE, PASSCODE, BIOMETRIC.
    assurance: { screenLockType: 'BIOMETRIC' },
    // Device-bound credential the caller presented, used by Device Access rules.
    caller: {
      binaryIdentifier:  'com.okta.mobile',
      bindingType:       'DEVICE_BOUND',
      validationStatus:  'VALID',
    },
    profile: {
      displayName:   "Jane's MacBook Pro",
      manufacturer:  'Apple',
      model:         'MacBookPro18,3',
      serialNumber:  'C02XY1ZZ4J8N',
      udid:          'D1F2A3B4-C5D6-7E8F-9A0B-1C2D3E4F5A6B',
      // Windows-only identifiers; null on a Mac, which is the point — the
      // documented binding exists but the platform doesn't populate it.
      sid:               null,
      tpmPublicKeyHash:  null,
      // Mobile-only identifiers, likewise null here.
      imei: null, meid: null,
      osVersion:          '14.5.1',
      platform:           'MACOS',      // IOS, ANDROID, WINDOWS, MACOS, CHROMEOS
      diskEncryptionType: 'FULL',       // NONE, USER, FULL, ALL_INTERNAL_VOLUMES, SYSTEM_VOLUME
      managed:               true,
      registered:            true,
      secureHardwarePresent: true,
      // Android/iOS integrity signals. All false on a healthy device; each one
      // turning true is a distinct tampering indicator.
      integrityDebug:      false,
      integrityEmulator:   false,
      integrityHook:       false,
      integrityJailbreak:  false,
      integrityRepackage:  false,
    },
    // Signals contributed by device-integration partners.
    provider: {
      oktaVerify:   { version: '9.24.0' },
      // Windows Security Center.
      wsc:          { fireWall: 'ON', autoUpdateSettings: 'ON' },
      // Zero Trust Assessment score from a partner (e.g. CrowdStrike), 0–100.
      zta:          { overall: 92 },
      // Okta Device Access — whether the desktop is joined to management.
      deviceAccess: { joined: true },
    },
  };

  const BASE_SESSION  = { id: '102X_bLDdgQTM6O0iBqCLDPFA', amr: ['pwd', 'mfa'] };
  // `behaviors` lists the behavior-detection rules that fired on this sign-in.
  // An array so `Arrays.contains(security.behaviors, 'New IP')` works.
  const BASE_SECURITY = { risk: { level: 'LOW' }, behaviors: [] };
  // What the user actually typed at the sign-in widget, before Okta resolves it
  // to a user — so it can differ from user.login (an alias, or a phone number).
  const BASE_LOGIN    = { identifier: 'jane.doe@acme.com' };

  // Deep-merges one level of nesting, which is all these signal objects have.
  // Object.assign would replace `profile` wholesale and drop the other 20 fields.
  function mergeSignals(base, delta) {
    const out = { ...base };
    for (const [k, v] of Object.entries(delta || {})) {
      out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base[k])
        ? mergeSignals(base[k], v)
        : v;
    }
    return out;
  }

  // ── Policy presets ────────────────────────────────────────────
  // Preset combinations for App Sign-On Policy expressions. Each lists only the
  // signals that distinguish it; everything else comes from the bases above.
  const POLICY_PRESETS = [
    {
      id: 'managed-mfa-low',
      label: 'Managed corp device · pwd+MFA · low risk',
      device:   {},
      session:  { amr: ['pwd', 'mfa'] },
      security: { risk: { level: 'LOW' } },
    },
    {
      id: 'unmanaged-pwd-low',
      label: 'Unmanaged personal device · pwd only · low risk',
      device:   { profile: { managed: false, registered: false, platform: 'IOS',
                             displayName: "Jane's iPhone", manufacturer: 'Apple',
                             model: 'iPhone15,2', osVersion: '17.5.1',
                             serialNumber: null, secureHardwarePresent: false,
                             diskEncryptionType: 'NONE' },
                  assurance: { screenLockType: 'PASSCODE' },
                  provider: { deviceAccess: { joined: false }, zta: { overall: 41 } } },
      session:  { amr: ['pwd'] },
      security: { risk: { level: 'LOW' } },
    },
    {
      id: 'managed-webauthn-low',
      label: 'Managed corp device · pwd+WebAuthn · low risk',
      device:   { profile: { platform: 'WINDOWS', displayName: 'ACME-W11-0421',
                             manufacturer: 'Dell', model: 'Latitude 7440',
                             osVersion: '10.0.22631', sid: 'S-1-5-21-1004336348-1177238915-682003330-512',
                             tpmPublicKeyHash: 'x9Kq2vLm8fT4wR1s', udid: null } },
      session:  { amr: ['pwd', 'hwk'] },
      security: { risk: { level: 'LOW' } },
    },
    {
      id: 'registered-mfa-medium',
      label: 'Registered BYOD · pwd+MFA · medium risk',
      device:   { profile: { managed: false, registered: true, platform: 'ANDROID',
                             displayName: 'Pixel 8', manufacturer: 'Google',
                             model: 'Pixel 8', osVersion: '14', udid: null,
                             imei: '350000000000001', meid: null,
                             diskEncryptionType: 'USER' },
                  provider: { zta: { overall: 68 }, deviceAccess: { joined: false } } },
      session:  { amr: ['pwd', 'mfa'] },
      security: { risk: { level: 'MEDIUM' }, behaviors: ['New Device'] },
    },
    {
      id: 'unmanaged-pwd-high',
      label: 'Unmanaged device · pwd only · high risk',
      device:   { profile: { managed: false, registered: false, platform: 'IOS',
                             displayName: null, serialNumber: null, udid: null,
                             osVersion: '16.3', secureHardwarePresent: false,
                             diskEncryptionType: 'NONE',
                             // Jailbroken — the signal a high-risk rule exists for.
                             integrityJailbreak: true },
                  assurance: { screenLockType: 'NONE' },
                  caller: { validationStatus: 'INVALID' },
                  provider: { zta: { overall: 12 }, deviceAccess: { joined: false } } },
      session:  { amr: ['pwd'] },
      security: { risk: { level: 'HIGH' },
                  behaviors: ['New IP', 'New Country', 'Velocity'] },
    },
    {
      id: 'kerberos-managed-low',
      label: 'Managed device · Kerberos SSO · low risk',
      device:   { profile: { platform: 'WINDOWS', displayName: 'ACME-W11-0099',
                             manufacturer: 'Lenovo', model: 'ThinkPad X1',
                             osVersion: '10.0.22631', sid: 'S-1-5-21-1004336348-1177238915-682003330-513',
                             tpmPublicKeyHash: 'p3Rt7yUi1oPa5sDf', udid: null } },
      session:  { amr: ['kba'] },
      security: { risk: { level: 'LOW' } },
    },
  ];

  function buildPolicyPresetOptions() {
    return POLICY_PRESETS.map((p, i) =>
      `<option value="${p.id}"${i===0?' selected':''}>${esc(p.label)}</option>`
    ).join('');
  }

  function applyPolicyPreset(id) {
    const p = POLICY_PRESETS.find(x => x.id === id) || POLICY_PRESETS[0];
    state.profile = {
      ...state.profile,
      device:   mergeSignals(BASE_DEVICE,   p.device),
      session:  mergeSignals(BASE_SESSION,  p.session),
      security: mergeSignals(BASE_SECURITY, p.security),
    };
    state.evaluator = new OELEvaluator(state.profile);
    refreshChips();
    scheduleEval();
  }

  // ── Default mock profile ──────────────────────────────────────
  const DEFAULT_PROFILE = {
    user: {
      // Core
      id: '00u1a2b3c4d5e6f7g8h9', login: 'jane.doe@acme.com',
      email: 'jane.doe@acme.com',   secondEmail: null,
      firstName: 'Jane',  lastName: 'Doe', middleInitial: 'M',
      displayName: 'Jane Doe',  nickName: null,
      title: 'Senior Engineer',  userType: 'Employee',
      organization: 'Acme Corp', division: 'Technology',
      department: 'Engineering', costCenter: 'ENG-001',
      // Numeric so the documented Convert.toInt / .toInteger examples return a
      // value instead of the null a non-numeric string correctly produces.
      employeeNumber: '100042',
      mobilePhone: '+1-555-0100', primaryPhone: '+1-555-0200',
      streetAddress: '123 Main St', city: 'San Francisco',
      state: 'CA', zipCode: '94105', countryCode: 'US',
      preferredLanguage: 'en-US', locale: 'en_US',
      timezone: 'America/Los_Angeles',
      status: 'ACTIVE',
      created: '2021-06-01T00:00:00.000Z',
      activated: '2021-06-01T00:00:00.000Z',
      lastLogin: '2024-03-15T08:30:00.000Z',
      lastUpdated: '2024-03-15T08:30:00.000Z',
      passwordChanged: '2024-01-10T12:00:00.000Z',
      // Manager
      manager: 'Bob Smith', managerId: '00u9a8b7c6d5',
      managerEmail: 'bob.smith@acme.com',
      // Common custom / AD-mapped
      samAccountName: 'jdoe', workerType: 'Employee',
      // Deliberately NOT ISO: hireDate stands in for an HR-system-sourced string,
      // which is the whole reason Time.fromStringToIso8601 takes a format. With an
      // ISO value here the documented 'MM/dd/yyyy' example parses to null.
      hireDate: '06/15/2021', jobCode: 'SWE-SR', jobLevel: 'L4',
      pwdLastSet: '133520736000000000',
    },
    appuser: {
      // Active Directory attributes (AD as source scenario)
      sAMAccountName: 'jdoe',
      userPrincipalName: 'jane.doe@corp.acme.com',
      mail: 'jane.doe@acme.com',
      givenName: 'Jane', sn: 'Doe', cn: 'Jane Doe',
      displayName: 'Doe, Jane',
      distinguishedName: 'CN=Jane Doe,OU=Engineering,DC=corp,DC=acme,DC=com',
      department: 'Engineering', title: 'Senior Engineer',
      company: 'Acme Corp', telephoneNumber: '+1-555-0200',
      manager: 'CN=Bob Smith,OU=Engineering,DC=corp,DC=acme,DC=com',
      memberOf: [
        'CN=Engineering,OU=Groups,DC=corp,DC=acme,DC=com',
        'CN=Domain Users,CN=Users,DC=corp,DC=acme,DC=com',
        'CN=VPN Access,OU=Groups,DC=corp,DC=acme,DC=com',
      ],
      employeeID: 'EMP42', employeeType: 'FTE',
      accountEnabled: true,
      extensionAttribute1: 'EXT001', extensionAttribute2: null,
      // Governance entitlement values for this app assignment, addressed by
      // attribute name (`appuser.entitlements.role`). Multi-value entitlements
      // arrive as arrays, single-value as scalars — both shapes appear here so
      // Arrays.* against an entitlement can be tried out.
      entitlements: {
        role:       'Contributor',
        licenses:   ['Professional', 'Analytics Add-on'],
        costCenter: 'ENG-001',
      },
    },
    apps: {
      active_directory: {
        sAMAccountName: 'jdoe',
        userPrincipalName: 'jane.doe@corp.acme.com',
        mail: 'jane.doe@acme.com',
      },
    },
    org: {
      // Derived at runtime from the current Okta domain; fetchOrgInfo() will
      // replace name with the real org name from /api/v1/org once it resolves.
      name:      window.location.hostname.split('.')[0],
      subDomain: window.location.hostname.split('.')[0],
    },
    groups:   ['Engineering', 'All Employees', 'US Employees', 'Okta Users', 'VPN Access'],
    groupIds: ['00g1','00g2','00g3','00g4','00g5'],
    // Group records for the mock user, matching what toGroupObject() produces
    // from the real /groups fetch. `user.getGroups()` criteria read group.type
    // and group.source.id, so the mock needs a mix: BUILT_IN for Okta's own
    // "Everyone"-style groups and APP_GROUP for a directory-sourced one, or the
    // documented criteria examples would all match everything.
    groupObjects: [
      { id:'00g1', type:'OKTA_GROUP', created:'2023-01-15T00:00:00.000Z', lastUpdated:'2023-01-15T00:00:00.000Z',
        lastMembershipUpdated:'2024-06-01T00:00:00.000Z', profile:{ name:'Engineering',    description:'Engineering department' } },
      { id:'00g2', type:'BUILT_IN',   created:'2022-03-01T00:00:00.000Z', lastUpdated:'2022-03-01T00:00:00.000Z',
        lastMembershipUpdated:'2024-06-01T00:00:00.000Z', profile:{ name:'All Employees',  description:'Everyone in the org' } },
      { id:'00g3', type:'OKTA_GROUP', created:'2023-02-01T00:00:00.000Z', lastUpdated:'2023-02-01T00:00:00.000Z',
        lastMembershipUpdated:'2024-05-01T00:00:00.000Z', profile:{ name:'US Employees',   description:'US-based staff' } },
      { id:'00g4', type:'APP_GROUP',  created:'2023-04-10T00:00:00.000Z', lastUpdated:'2023-04-10T00:00:00.000Z',
        lastMembershipUpdated:'2024-04-10T00:00:00.000Z', profile:{ name:'Okta Users',     description:'Synced from AD' },
        source:{ id:'0oaadinstance01' } },
      { id:'00g5', type:'OKTA_GROUP', created:'2023-06-20T00:00:00.000Z', lastUpdated:'2023-06-20T00:00:00.000Z',
        lastMembershipUpdated:'2024-03-15T00:00:00.000Z', profile:{ name:'VPN Access',     description:'VPN entitlement' } },
    ],
    session:  BASE_SESSION,
    security: BASE_SECURITY,
    device:   BASE_DEVICE,
    login:    BASE_LOGIN,

    // Identity Governance access-request bindings, used in Access Certification
    // eligibility rules. `operation` is the request being evaluated; the
    // authenticator block identifies which authenticator it concerns.
    accessRequest: {
      operation:     'GRANT',
      authenticator: { id: 'aut1a2b3c4d5e6f7g8h9', key: 'okta_verify' },
      metadata:      { type: 'APP_ACCESS' },
    },

    // idpuser — attributes from an external Identity Provider (SAML or OIDC IdP).
    // Available in IdP Attribute Mapping rules; represents the incoming IdP assertion.
    idpuser: {
      externalId:       'idp-external-12345',
      login:            'jane.doe@external-corp.com',
      email:            'jane.doe@external-corp.com',
      firstName:        'Jane',
      lastName:         'Doe',
      displayName:      'Jane Doe',
      department:       'Engineering',
      title:            'Senior Engineer',
      role:             'admin',
      groups:           'Engineering,IT,All-Staff',
      employeeId:       'EXT-42',
      mobilePhone:      '+1-555-9999',
      // Custom SAML / OIDC attributes sent by the external IdP
      customAttribute1: 'value1',
      customAttribute2: null,
    },

    // app — the application object (available in OAuth Claims, SAML, Inline Hooks).
    app: {
      id:        '0oa1a2b3c4d5e6f7g8h9',
      clientId:  'abc123def456ghi789',
      profile: {
        label:          'My Application',
        customProperty: 'custom-value',
      },
    },

    // access — OAuth 2.0 access request context (available in OAuth Claims).
    access: {
      scope: ['openid', 'profile', 'email', 'groups'],
    },
  };

  // ── Function Reference ────────────────────────────────────────
  const FUNCTION_REFERENCE = [
    {
      ns: 'String', color: '#1662dd',
      fns: [
        { sig:'String.len(str)',                              desc:'Character length of a string.',                                            ex:"String.len(user.firstName)" },
        { sig:'String.append(str, suffix)',                   desc:'Concatenates suffix to str.',                                             ex:"String.append(user.firstName, '_admin')" },
        { sig:'String.join(sep, str1, str2, ...)',            desc:'Joins strings with a separator.',                                         ex:"String.join('.', user.firstName, user.lastName)" },
        { sig:'String.toUpperCase(str)',                      desc:'Converts to uppercase.',                                                   ex:"String.toUpperCase(user.department)" },
        { sig:'String.toLowerCase(str)',                      desc:'Converts to lowercase.',                                                   ex:"String.toLowerCase(user.email)" },
        { sig:'String.substring(input, startIndex, endIndex)', desc:'Extracts a substring by index (0-based, end exclusive). All three arguments are required in the namespace form; the method form value.substring(start) accepts one.', ex:"String.substring(user.firstName, 0, 1)" },
        { sig:'String.substringBefore(str, delimiter)',       desc:'Returns the part of str before the first delimiter.',                      ex:"String.substringBefore(user.email, '@')" },
        { sig:'String.substringAfter(str, delimiter)',        desc:'Returns the part of str after the first delimiter.',                       ex:"String.substringAfter(user.email, '@')" },
        { sig:'String.replace(str, pattern, replacement)',    desc:'Replaces all regex matches (global).',                                     ex:"String.replace(user.displayName, '\\\\s+', '.')" },
        { sig:'String.replaceFirst(str, pattern, replacement)',desc:'Replaces the first regex match only.',                                    ex:"String.replaceFirst(user.login, '@.*', '')" },
        { sig:'String.stringContains(str, substring)',        desc:'True if str contains the substring.',                                      ex:"String.stringContains(user.email, 'acme.com')" },
        { sig:'String.startsWith(str, prefix)',               desc:'True if str starts with prefix.',                                          ex:"String.startsWith(user.userType, 'Emp')" },
        { sig:'String.removeSpaces(str)',                     desc:'Removes all whitespace characters.',                                        ex:"String.removeSpaces(user.displayName)" },
        { sig:'String.stringSwitch(input, default, k1, v1, ...)',desc:'Returns v1 if input==k1, else next pair, else default.',               ex:"String.stringSwitch(user.department,'Other','Engineering','dev')" },
        { sig:'value.toUpperCase()',                          desc:'Identity Engine method style — same as String.toUpperCase.',               ex:"user.department.toUpperCase()" },
        { sig:'value.toLowerCase()',                          desc:'Identity Engine method style — same as String.toLowerCase.',               ex:"user.firstName.toLowerCase()" },
        { sig:'value.substringBefore(delimiter)',             desc:'Identity Engine method style — same as String.substringBefore.',           ex:"user.email.substringBefore('@')" },
        { sig:'value.substringAfter(delimiter)',              desc:'Identity Engine method style — same as String.substringAfter.',            ex:"user.email.substringAfter('@')" },
      ],
    },
    {
      ns: 'Arrays', color: '#00853b',
      fns: [
        { sig:'Arrays.contains(array, element)',       desc:'True if array contains element. Every Arrays.* function also accepts a comma-separated string wherever an array is expected.', ex:"Arrays.contains(groups, 'Engineering')" },
        { sig:'Arrays.size(array)',                    desc:'Number of elements.',                                      ex:"Arrays.size(groups)" },
        { sig:'Arrays.isEmpty(array)',                 desc:'True if array is null or empty.',                          ex:"Arrays.isEmpty(groups)" },
        { sig:'Arrays.add(array, element)',            desc:'Returns new array with element appended.',                 ex:"Arrays.add(groups, 'NewGroup')" },
        { sig:'Arrays.remove(array, element)',         desc:'Returns new array with element removed.',                  ex:"Arrays.remove(groups, 'Engineering')" },
        { sig:'Arrays.get(array, index)',              desc:'Returns element at index (0-based).',                      ex:"Arrays.get(groups, 0)" },
        { sig:'Arrays.clear(array)',                   desc:'Returns an empty array.',                                  ex:"Arrays.clear(groups)" },
        { sig:'Arrays.toCsvString(array)',             desc:'Converts array to a comma-separated string.',              ex:"Arrays.toCsvString(groups)" },
        { sig:'Arrays.flatten(...values)',             desc:'Flattens nested arrays into one flat array.',              ex:"Arrays.flatten([[1,2],[3,4]])" },
        { sig:'collection.![expression]',             desc:'SpEL projection — maps each element and returns a new array.\nExample: user.getGroups().![profile.name]', ex:"user.getGroups().![profile.name]" },
      ],
    },
    {
      ns: 'Time', color: '#bc6b00',
      fns: [
        { sig:"Time.now([tz[, format]])",              desc:"Returns current time. Optional tz (e.g. 'EST') and format (YYYY-MM-dd HH:mm:ss).", ex:"Time.now('UTC', 'YYYY-MM-dd')" },
        { sig:'Time.fromUnixToIso8601(unix)',          desc:'Converts Unix epoch seconds to ISO 8601.',                ex:"Time.fromUnixToIso8601(1700000000)" },
        { sig:'Time.fromIso8601ToUnix(iso)',           desc:'Converts ISO 8601 string to Unix epoch seconds.',         ex:"Time.fromIso8601ToUnix(user.passwordChanged)" },
        { sig:'Time.fromWindowsToIso8601(filetime)',   desc:'Converts Windows FILETIME (AD pwdLastSet) to ISO 8601.', ex:"Time.fromWindowsToIso8601(user.pwdLastSet)" },
        { sig:'Time.fromIso8601ToWindows(iso)',        desc:'Converts ISO 8601 to Windows FILETIME.',                  ex:"Time.fromIso8601ToWindows(user.lastLogin)" },
        { sig:'Time.fromStringToIso8601(time, format)', desc:'Parses a date string to ISO 8601. The format describes how to read the input (Joda-style: yyyy, MM, dd, HH, mm, ss, SSS) and is required.', ex:"Time.fromStringToIso8601(user.hireDate, 'MM/dd/yyyy')" },
        { sig:'Time.fromIso8601ToString(iso, format)', desc:'Formats an ISO 8601 string with a custom format.',        ex:"Time.fromIso8601ToString(user.lastLogin, 'YYYY-MM-dd')" },
        { sig:'DateTime.now()',                        desc:'Identity Engine — returns a ZonedDateTime object for method chaining.', ex:"DateTime.now().toString('YYYY-MM-dd')" },
        { sig:'dateValue.withinDays(n)',               desc:'Identity Engine — true if the date is within n days of now.', ex:"user.created.parseStringTime().withinDays(30)" },
        { sig:'dateValue.plusDays(n)',                 desc:'Identity Engine — returns a new datetime n days in the future.', ex:"user.created.parseStringTime().plusDays(90).toString()" },
        { sig:'dateValue.parseStringTime([format])',    desc:'Identity Engine — parses a date string to a ZonedDateTime. Reads ISO 8601 with no argument, or a Joda pattern when given one.', ex:"user.created.parseStringTime().withinDays(90)" },
        { sig:'value.parseUnixTime()',                 desc:'Identity Engine — parses Unix epoch seconds to a ZonedDateTime.', ex:"user.lastLogin.parseStringTime().toUnix().parseUnixTime().toString()" },
        { sig:'value.parseWindowsTime()',              desc:'Identity Engine — parses a Windows FILETIME (AD pwdLastSet) to a ZonedDateTime.', ex:"user.pwdLastSet.parseWindowsTime().withinDays(90)" },
        { sig:'dateValue.toZone(zoneId)',              desc:'Identity Engine — reads the same instant in another IANA time zone, e.g. Asia/Tokyo.', ex:"DateTime.now().toZone('Asia/Tokyo').toString('yyyy-MM-dd HH:mm')" },
      ],
    },
    {
      ns: 'Convert', color: '#6200cc',
      fns: [
        { sig:'Convert.toInt(value)',   desc:'Converts to integer.',       ex:"Convert.toInt(user.employeeNumber)" },
        { sig:'Convert.toNum(value)',   desc:'Converts to decimal number.', ex:"Convert.toNum('3.14')" },
        { sig:'value.toInteger()',      desc:'Identity Engine method style — converts to integer.',        ex:"user.employeeNumber.toInteger()" },
        { sig:'value.toNumber()',       desc:'Identity Engine method style — converts to decimal number.', ex:"user.employeeNumber.toNumber()" },
      ],
    },
    {
      ns: 'Iso3166Convert', color: '#d50000',
      fns: [
        { sig:'Iso3166Convert.toAlpha2(value)',  desc:'Converts country code/name to 2-letter ISO code (e.g. "US").',   ex:"Iso3166Convert.toAlpha2(user.countryCode)" },
        { sig:'Iso3166Convert.toAlpha3(value)',  desc:'Converts to 3-letter ISO code (e.g. "USA").',                    ex:"Iso3166Convert.toAlpha3(user.countryCode)" },
        { sig:'Iso3166Convert.toNumeric(value)', desc:'Converts to numeric ISO code (e.g. "840").',                     ex:"Iso3166Convert.toNumeric('US')" },
        { sig:'Iso3166Convert.toName(value)',    desc:'Converts to country name (e.g. "United States").',               ex:"Iso3166Convert.toName(user.countryCode)" },
        { sig:'value.parseCountryCode()',        desc:'Identity Engine method style — returns a CountryCode object. Chain .toAlpha2(), .toAlpha3(), .toNumeric(), or .toName() off it.', ex:"user.countryCode.parseCountryCode().toName()" },
      ],
    },
    {
      ns: 'Version', color: '#0a7f6d',
      fns: [
        { sig:'value.versionGreaterThan(other)', desc:'Identity Engine — compares two version strings segment by segment. Use these instead of < / > on a version, which compares lexically and reports 14.10 as older than 14.9.', ex:"device.profile.osVersion.versionGreaterThan('14.0')" },
        { sig:'value.versionLessThan(other)',    desc:'Identity Engine — true when the version is older than other. Missing segments count as zero, so 14 equals 14.0.0.', ex:"device.provider.oktaVerify.version.versionLessThan('5.0.0')" },
      ],
    },
    {
      ns: 'Groups & User', color: '#1662dd',
      fns: [
        { sig:'isMemberOfGroupName(name)',                    desc:'True if user is in the named Okta group (includes AD-synced groups).', ex:"isMemberOfGroupName('Engineering')" },
        { sig:'isMemberOfGroup(groupId)',                     desc:'True if user is in the Okta group with this ID.',  ex:"isMemberOfGroup('00g1a2b3c4d5')" },
        { sig:'isMemberOfAnyGroup(id1, id2, ...)',            desc:'True if user is in any of the listed groups.',     ex:"isMemberOfAnyGroup('Engineering', 'IT', 'DevOps')" },
        { sig:'isMemberOfGroupNameStartsWith(prefix)',        desc:'True if user is in a group whose name starts with prefix.', ex:"isMemberOfGroupNameStartsWith('IT_')" },
        { sig:'isMemberOfGroupNameContains(substring)',       desc:'True if user is in a group whose name contains substring.', ex:"isMemberOfGroupNameContains('Admin')" },
        { sig:'isMemberOfGroupNameRegex(regex)',              desc:'True if user is in a group whose name matches the regex.', ex:"isMemberOfGroupNameRegex('^IT.*Users$')" },
        { sig:'getFilteredGroups(allowList, group_expression, limit)', desc:"Returns a field from each group in the allowList (a list of group IDs) that the user belongs to. group_expression is one of group.id, group.name, group.description. All three arguments are required.", ex:"getFilteredGroups({'00g1','00g2'}, 'group.name', 10)" },
        { sig:"user.getGroups(criteria[, ...])", desc:"Returns the user's matching groups as group objects, so projections work. Criteria keys: group.id, group.type, group.source.id, group.profile.name. A list value matches any of its entries (OR); extra criteria objects must all match (AND). Readable per group: id, type, created, lastUpdated, lastMembershipUpdated, profile.name, profile.description.", ex:"user.getGroups({'group.type': {'OKTA_GROUP'}}).![profile.name]" },
        { sig:"user.isMemberOf(criteria[, ...])", desc:"Identity Engine — checks membership with a criteria object. Same keys as getGroups. 'operator' applies only to group.profile.name and defaults to STARTS_WITH; the other option is EXACT.", ex:"user.isMemberOf({'group.profile.name': 'Engineering'})" },
        { sig:'user.getInternalProperty(name)',               desc:"Returns an internal Okta user property ('id', 'status', 'created', etc.).", ex:"user.getInternalProperty('status')" },
        { sig:"Groups.contains(app, pattern, limit)",         desc:'Returns groups from the app whose name contains pattern. Legacy — works only in group-claim expressions, not in property mappings; user.getGroups with a projection is the current form.', ex:"Groups.contains('OKTA', 'Eng', 10)" },
        { sig:"Groups.startsWith(app, pattern, limit)",       desc:'Returns groups from the app whose name starts with pattern. Legacy — group claims only.', ex:"Groups.startsWith('OKTA', 'IT_', 10)" },
        { sig:"Groups.endsWith(app, pattern, limit)",         desc:'Returns groups from the app whose name ends with pattern. Legacy — group claims only.', ex:"Groups.endsWith('OKTA', '_Admins', 10)" },
      ],
    },
    {
      ns: 'Manager & Directory', color: '#bc6b00',
      fns: [
        { sig:"getManagerUser('active_directory')",                  desc:"Returns the manager's Okta user object. Source must be 'active_directory'.", ex:"getManagerUser('active_directory').email" },
        { sig:"getManagerAppUser('active_directory', 'active_directory')", desc:"Returns the manager's AD app user object.", ex:"getManagerAppUser('active_directory', 'active_directory').sAMAccountName" },
        { sig:"getAssistantUser('active_directory')",                desc:"Returns the assistant's Okta user object.",   ex:"getAssistantUser('active_directory').firstName" },
        { sig:'hasDirectoryUser()',                                   desc:'True if the user has an Active Directory assignment.', ex:"hasDirectoryUser() ? findDirectoryUser().sAMAccountName : 'N/A'" },
        { sig:'findDirectoryUser()',                                  desc:'Returns the AD app user object (or null).',   ex:"findDirectoryUser().sAMAccountName" },
        { sig:'hasWorkdayUser()',                                     desc:'True if the user has a Workday assignment.',  ex:"hasWorkdayUser() ? findWorkdayUser().employeeID : null" },
        { sig:'findWorkdayUser()',                                    desc:'Returns the Workday app user object (or null).', ex:"findWorkdayUser().employeeID" },
        { sig:'user.getLinkedObject(primaryName)',                    desc:"Returns the user on the other side of a linked-object relationship. 'manager' is Okta's built-in primary name and resolves against the fetched manager profile; a custom relationship evaluates to null here because the preview has no data for it.", ex:"user.getLinkedObject('manager').email" },
      ],
    },
    {
      ns: 'Organization', color: '#546be7',
      fns: [
        { sig:'org.name',      desc:'The name of the Okta organization.',      ex:"org.name" },
        { sig:'org.subDomain', desc:'The subdomain of the Okta organization. Useful for building org-specific URLs or routing logic.', ex:"org.subDomain" },
      ],
    },
    // Still in Okta's reference and still accepted by its runtime, so they're
    // implemented — a legacy expression pasted into the builder has to behave
    // the way it behaves in Okta. `deprecated: true` is what puts the badge on
    // the entry and the marker in the Quick Insert list; the Result tab's notice
    // comes from the evaluator, which carries the same flag on its specs.
    {
      ns: 'Deprecated', color: '#6e6e78', deprecated: true,
      fns: [
        { sig:'toUpperCase(str)',                        deprecated:true, desc:'Deprecated unqualified form of String.toUpperCase.', ex:"toUpperCase(user.department)" },
        { sig:'toLowerCase(str)',                        deprecated:true, desc:'Deprecated unqualified form of String.toLowerCase.', ex:"toLowerCase(user.email)" },
        { sig:'substring(input, startIndex, endIndex)',   deprecated:true, desc:'Deprecated unqualified form of String.substring.', ex:"substring(user.firstName, 0, 1)" },
        { sig:'substringBefore(str, delimiter)',          deprecated:true, desc:'Deprecated unqualified form of String.substringBefore.', ex:"substringBefore(user.email, '@')" },
        { sig:'substringAfter(str, delimiter)',           deprecated:true, desc:'Deprecated unqualified form of String.substringAfter.', ex:"substringAfter(user.email, '@')" },
        { sig:"value matches 'regex'",                    deprecated:true, desc:'Deprecated operator. True when the regex matches the WHOLE value, so a fragment needs its own .* on both sides. A null value is false.', ex:"user.login matches '.*@acme.com'" },
      ],
    },
  ];

  // ── Templates ─────────────────────────────────────────────────
  // Organized by OEL context to match the Builder's Context selector.
  const TEMPLATES = [
    // ── Profile Mapping ─────────────────────────────────────────
    { ctx:'profile_mapping', tag:'String',  name:'Email → username',          desc:'Extracts the local-part of the email address.',                      expr:"String.substringBefore(user.email, '@')" },
    { ctx:'profile_mapping', tag:'String',  name:'First.Last login',           desc:'Lowercase dot-separated first and last name.',                       expr:"String.toLowerCase(user.firstName) + '.' + String.toLowerCase(user.lastName)" },
    { ctx:'profile_mapping', tag:'String',  name:'First initial + last name',  desc:'Classic sAMAccountName-style lowercase username.',                   expr:"String.toLowerCase(String.substring(user.firstName, 0, 1) + user.lastName)" },
    { ctx:'profile_mapping', tag:'String',  name:'Full name',                  desc:'firstName + space + lastName.',                                       expr:"user.firstName + ' ' + user.lastName" },
    { ctx:'profile_mapping', tag:'String',  name:'Last, First format',         desc:'Display name as "Doe, Jane".',                                        expr:"user.lastName + ', ' + user.firstName" },
    { ctx:'profile_mapping', tag:'String',  name:'Email domain',               desc:'Extracts the domain portion of the email address.',                   expr:"String.substringAfter(user.email, '@')" },
    { ctx:'profile_mapping', tag:'String',  name:'Uppercase department',       desc:'Department name in uppercase.',                                        expr:"String.toUpperCase(user.department)" },
    { ctx:'profile_mapping', tag:'Operator',name:'Null-safe login fallback',   desc:'Uses login, falling back to email if null (Elvis operator).',          expr:"user.login ?: user.email" },
    { ctx:'profile_mapping', tag:'Arrays',  name:'Groups as CSV',              desc:'All Okta group memberships as a comma-separated string.',              expr:"Arrays.toCsvString(groups)" },
    { ctx:'profile_mapping', tag:'Convert', name:'Employee number → integer',  desc:'Converts the employeeNumber string to an integer.',                   expr:"Convert.toInt(user.employeeNumber)" },
    { ctx:'profile_mapping', tag:'Time',    name:'AD pwdLastSet → ISO 8601',   desc:'Converts Windows FILETIME (AD pwdLastSet) to ISO 8601.',               expr:"Time.fromWindowsToIso8601(user.pwdLastSet)" },
    { ctx:'profile_mapping', tag:'Time',    name:'Hire date → ISO 8601',       desc:'Normalizes the hireDate string from an HR system to ISO 8601.',        expr:"Time.fromStringToIso8601(user.hireDate, 'MM/dd/yyyy')" },
    { ctx:'profile_mapping', tag:'Country', name:'Country code → name',        desc:'Converts a 2-letter country code to its full country name.',           expr:"Iso3166Convert.toName(user.countryCode)" },
    { ctx:'profile_mapping', tag:'org',     name:'Organization name',          desc:'The name of the Okta organization.',                                  expr:"org.name" },
    { ctx:'profile_mapping', tag:'org',     name:'Org subdomain',              desc:'The subdomain of the Okta organization.',                             expr:"org.subDomain" },
    // AD Source: reading appuser attributes (AD → Okta import)
    { ctx:'profile_mapping', tag:'AD Source', name:'Map AD mail → Okta email',    desc:'Maps the AD mail attribute to the Okta email during import.',        expr:"appuser.mail" },
    { ctx:'profile_mapping', tag:'AD Source', name:'AD UPN → Okta login',         desc:'Maps the AD userPrincipalName as the Okta login.',                   expr:"appuser.userPrincipalName" },
    { ctx:'profile_mapping', tag:'AD Source', name:'Combine AD givenName + sn',   desc:'Builds displayName from AD given name and surname.',                  expr:"appuser.givenName + ' ' + appuser.sn" },
    { ctx:'profile_mapping', tag:'AD Source', name:'Check AD memberOf DN',        desc:'Checks if the appuser memberOf array contains a specific group DN.', expr:"Arrays.contains(appuser.memberOf, 'CN=Engineering,OU=Groups,DC=corp,DC=acme,DC=com')" },
    { ctx:'profile_mapping', tag:'AD Source', name:'Extract group name from DN',  desc:'Parses the CN (group name) from the first memberOf DN.',             expr:"String.substringBefore(String.substringAfter(appuser.memberOf[0], 'CN='), ',')" },
    { ctx:'profile_mapping', tag:'AD Source', name:'extensionAttribute fallback', desc:'extensionAttribute1 with employeeID as fallback.',                   expr:"appuser.extensionAttribute1 ?: appuser.employeeID" },
    { ctx:'profile_mapping', tag:'AD Source', name:'findDirectoryUser() reference',desc:'Returns the AD user object explicitly for use in import rules.',    expr:"findDirectoryUser().sAMAccountName" },
    // AD Target: building attributes to push to AD
    { ctx:'profile_mapping', tag:'AD Target', name:'Set AD sAMAccountName',       desc:'Builds a first-initial + last-name lowercase username.',              expr:"String.toLowerCase(String.substring(user.firstName, 0, 1) + user.lastName)" },
    { ctx:'profile_mapping', tag:'AD Target', name:'Set AD userPrincipalName',    desc:'Maps the Okta login as the AD UPN.',                                  expr:"user.login" },
    { ctx:'profile_mapping', tag:'AD Target', name:'Set AD displayName',          desc:'Formats "Last, First" for the AD displayName.',                      expr:"user.lastName + ', ' + user.firstName" },
    { ctx:'profile_mapping', tag:'AD Target', name:'Set AD telephoneNumber',      desc:'Uses primaryPhone, falls back to mobilePhone.',                       expr:"user.primaryPhone ?: user.mobilePhone" },
    { ctx:'profile_mapping', tag:'AD Target', name:'Set AD pwdLastSet (ISO→Win)', desc:'Converts ISO 8601 to Windows FILETIME for AD.',                       expr:"Time.fromIso8601ToWindows(user.passwordChanged)" },
    // Manager chain
    { ctx:'profile_mapping', tag:'Manager',   name:'Manager email',              desc:"Retrieves the manager's email from Active Directory.",                 expr:"getManagerUser('active_directory').email" },
    { ctx:'profile_mapping', tag:'Manager',   name:'Manager AD sAMAccountName',  desc:"Gets the manager's AD username.",                                     expr:"getManagerAppUser('active_directory', 'active_directory').sAMAccountName" },
    { ctx:'profile_mapping', tag:'Workday',   name:'Workday employeeID',         desc:'Returns the Workday employee ID if user has a Workday assignment.',    expr:"hasWorkdayUser() ? findWorkdayUser().employeeID : user.employeeNumber" },

    // ── Group Rules ──────────────────────────────────────────────
    { ctx:'group_rules', tag:'Dept',      name:'Engineering department',    desc:'Matches all Engineering department users.',                           expr:"user.department == 'Engineering'" },
    { ctx:'group_rules', tag:'Status',    name:'Active employees',          desc:'Matches active users who are employees (not contractors).',           expr:"user.getInternalProperty('status') == 'ACTIVE' AND user.workerType == 'Employee'" },
    { ctx:'group_rules', tag:'Location',  name:'US-based users',            desc:'Matches active users in the United States.',                          expr:"user.countryCode == 'US' AND user.getInternalProperty('status') == 'ACTIVE'" },
    { ctx:'group_rules', tag:'Type',      name:'Contractors and vendors',   desc:'Matches users whose type is Contractor or Vendor.',                   expr:"user.workerType == 'Contractor' OR user.workerType == 'Vendor'" },
    { ctx:'group_rules', tag:'Title',     name:'Senior staff by title',     desc:'Matches Senior, Director, or VP title keywords.',                     expr:"String.stringContains(user.title, 'Senior') OR String.stringContains(user.title, 'Director') OR String.stringContains(user.title, 'VP')" },
    { ctx:'group_rules', tag:'Dept',      name:'Multi-department team',     desc:'Matches Engineering, IT, or DevOps.',                                 expr:"user.department == 'Engineering' OR user.department == 'IT' OR user.department == 'DevOps'" },
    { ctx:'group_rules', tag:'Cost',      name:'Cost center prefix',        desc:'Matches users whose cost center starts with ENG.',                    expr:"String.stringContains(user.costCenter, 'ENG')" },
    { ctx:'group_rules', tag:'Manager',   name:'Has a manager',             desc:'Matches users who have a managerId assigned.',                         expr:"user.managerId != null" },
    { ctx:'group_rules', tag:'AD Group',  name:'AD-synced group by name',   desc:'AD groups synced to Okta appear as Okta groups — check by name.',    expr:"isMemberOfGroupName('Domain Admins')" },
    { ctx:'group_rules', tag:'AD Group',  name:'Group name prefix match',   desc:'Matches users in any group whose name starts with a prefix.',          expr:"isMemberOfGroupNameStartsWith('IT_')" },
    { ctx:'group_rules', tag:'AD Group',  name:'Group name contains',       desc:'Matches users in any group whose name contains a substring.',          expr:"isMemberOfGroupNameContains('Admin')" },
    { ctx:'group_rules', tag:'Combined',  name:'Dept + active + country',   desc:'Combines multiple criteria with AND.',                                 expr:"user.department == 'Engineering' AND user.getInternalProperty('status') == 'ACTIVE' AND user.countryCode == 'US'" },
    { ctx:'group_rules', tag:'Combined',  name:'Admin groups check',        desc:'Matches users in any admin-related Okta group.',                       expr:"isMemberOfAnyGroup('Super Admins', 'IT Admins', 'Okta Admins', 'Domain Admins')" },

    // ── OAuth 2.0 / OIDC Claims ──────────────────────────────────
    { ctx:'oauth_claims', tag:'User',     name:'Email claim',               desc:'Returns the user email for an ID/access token claim.',                expr:"user.email" },
    { ctx:'oauth_claims', tag:'User',     name:'Display name',              desc:'Full name for the name claim.',                                        expr:"user.firstName + ' ' + user.lastName" },
    { ctx:'oauth_claims', tag:'User',     name:'Department claim',          desc:'User department attribute.',                                           expr:"user.department" },
    { ctx:'oauth_claims', tag:'Groups',   name:'Groups as CSV',             desc:'All group memberships as a CSV string for a groups claim.',             expr:"Arrays.toCsvString(groups)" },
    { ctx:'oauth_claims', tag:'App',      name:'App client ID',             desc:'The OAuth 2.0 client ID of the requesting application.',               expr:"app.clientId" },
    { ctx:'oauth_claims', tag:'Condition',name:'Role from group membership',desc:'Returns "admin" or "user" based on group membership.',                 expr:"isMemberOfGroupName('Admins') ? 'admin' : 'user'" },
    { ctx:'oauth_claims', tag:'appuser',  name:'App-specific role',         desc:'Returns role from the app user profile, fallback to "user".',           expr:"appuser.role ?: 'user'" },
    { ctx:'oauth_claims', tag:'appuser',  name:'appuser attr fallback',     desc:'Gets a value from appuser, falls back to user profile.',                expr:"appuser.employeeNumber ?: user.employeeNumber" },
    { ctx:'oauth_claims', tag:'org',      name:'Org name claim',            desc:'Returns the Okta organization name as a token claim.',                  expr:"org.name" },
    { ctx:'oauth_claims', tag:'org',      name:'Org subdomain claim',       desc:'Returns the org subdomain — useful for tenant-aware applications.',      expr:"org.subDomain" },

    // ── SAML Attribute Statements ────────────────────────────────
    { ctx:'saml', tag:'NameID',   name:'Email NameID',                      desc:'Standard email-format NameID for SAML assertions.',                   expr:"user.email" },
    { ctx:'saml', tag:'User',     name:'First name',                        desc:'firstName attribute for SAML.',                                        expr:"user.firstName" },
    { ctx:'saml', tag:'User',     name:'Display name',                      desc:'Full name for SAML displayName attribute.',                            expr:"user.firstName + ' ' + user.lastName" },
    { ctx:'saml', tag:'Groups',   name:'Groups as CSV',                     desc:'Group memberships for a multi-value SAML groups attribute.',            expr:"Arrays.toCsvString(groups)" },
    { ctx:'saml', tag:'appuser',  name:'SAML role from appuser',            desc:'Role from the app user profile with fallback.',                         expr:"appuser.role ?: 'user'" },
    { ctx:'saml', tag:'Condition',name:'Conditional role mapping',          desc:'Maps department to a SAML role value.',                                 expr:"user.department == 'Engineering' ? 'developer' : user.department == 'IT' ? 'operator' : 'viewer'" },
    { ctx:'saml', tag:'org',     name:'SAML org name attribute',           desc:'Passes the Okta organization name as a SAML attribute.',               expr:"org.name" },
    { ctx:'saml', tag:'org',     name:'SAML org subdomain attribute',      desc:'Passes the org subdomain — useful for multi-tenant SAML apps.',        expr:"org.subDomain" },

    // ── App Sign-On Policy (Identity Engine) ─────────────────────
    { ctx:'app_sign_on', tag:'Status',  name:'Active user check',           desc:'True when the user account is active.',                                expr:"user.getInternalProperty('status') == 'ACTIVE'" },
    { ctx:'app_sign_on', tag:'Groups',  name:'Group membership check',      desc:'True when user is in a specific group.',                               expr:"user.isMemberOf({'group.profile.name': 'Engineering'})" },
    { ctx:'app_sign_on', tag:'Group',   name:'Group name starts with',      desc:'Checks group name with STARTS_WITH operator.',                         expr:"user.isMemberOf({'group.profile.name': 'IT', 'operator': 'STARTS_WITH'})" },
    { ctx:'app_sign_on', tag:'Device',  name:'Managed device check',        desc:'True when request comes from a managed device.',                       expr:"device.profile.managed == true" },
    { ctx:'app_sign_on', tag:'Device',  name:'Registered device check',     desc:'True when device is registered with Okta.',                            expr:"device.profile.registered == true" },
    { ctx:'app_sign_on', tag:'Session', name:'MFA completed',               desc:'True when MFA was performed in this session.',                         expr:"Arrays.contains(session.amr, 'mfa')" },
    { ctx:'app_sign_on', tag:'Session', name:'Hardware key used',           desc:'True when a FIDO2/YubiKey hardware authenticator was used.',            expr:"Arrays.contains(session.amr, 'hwk')" },
    { ctx:'app_sign_on', tag:'Session', name:'Smart card used',             desc:'True when a PIV/CAC smart card was used.',                             expr:"Arrays.contains(session.amr, 'sc')" },
    { ctx:'app_sign_on', tag:'Risk',    name:'High-risk session check',     desc:'True when the risk level is HIGH.',                                    expr:"security.risk.level == 'HIGH'" },
    { ctx:'app_sign_on', tag:'Time',    name:'New user (created recently)', desc:'True when the user was created within the last 30 days.',              expr:"user.created.parseStringTime().withinDays(30)" },
    { ctx:'app_sign_on', tag:'Time',    name:'Password recently changed',   desc:'True when password was changed in the last 7 days.',                   expr:"user.passwordChanged.parseStringTime().withinDays(7)" },
    { ctx:'app_sign_on', tag:'Combined',name:'MFA + admin group',           desc:'Requires both MFA and admin group membership.',                        expr:"Arrays.contains(session.amr, 'mfa') AND user.isMemberOf({'group.profile.name': 'Admins'})" },
    { ctx:'app_sign_on', tag:'Device',  name:'Disk encryption required',    desc:'True when the volume is fully encrypted. Values: NONE, USER, FULL, ALL_INTERNAL_VOLUMES, SYSTEM_VOLUME.', expr:"device.profile.diskEncryptionType == 'FULL'" },
    { ctx:'app_sign_on', tag:'Device',  name:'Screen lock strength',        desc:'True when the device locks with biometrics rather than a passcode or nothing.', expr:"device.assurance.screenLockType == 'BIOMETRIC'" },
    { ctx:'app_sign_on', tag:'Device',  name:'Device integrity intact',     desc:'Blocks jailbroken, rooted, emulated, hooked, or repackaged devices.',   expr:"device.profile.integrityJailbreak == false AND device.profile.integrityEmulator == false AND device.profile.integrityHook == false AND device.profile.integrityRepackage == false" },
    { ctx:'app_sign_on', tag:'Device',  name:'Minimum OS version',          desc:'Segment-wise version compare. Do not use < or > on a version — 14.10 sorts before 14.9 lexically.', expr:"device.profile.osVersion.versionGreaterThan('14.0.0')" },
    { ctx:'app_sign_on', tag:'Device',  name:'Okta Verify up to date',      desc:'True when the Okta Verify build is at or past the required version.',   expr:"device.provider.oktaVerify.version.versionLessThan('9.0.0') == false" },
    { ctx:'app_sign_on', tag:'Device',  name:'Secure hardware present',     desc:'True when the device has a TPM or secure enclave.',                     expr:"device.profile.secureHardwarePresent == true" },
    { ctx:'app_sign_on', tag:'Device',  name:'Windows firewall on',         desc:'Windows Security Center signal. Only populated on Windows.',            expr:"device.provider.wsc.fireWall == 'ON'" },
    { ctx:'app_sign_on', tag:'Device',  name:'Zero Trust score threshold',  desc:'Partner-supplied Zero Trust Assessment score, 0-100.',                  expr:"device.provider.zta.overall > 70" },
    { ctx:'app_sign_on', tag:'Device',  name:'Platform check',              desc:'True on corporate desktop platforms. Values: IOS, ANDROID, WINDOWS, MACOS, CHROMEOS.', expr:"device.profile.platform == 'MACOS' OR device.profile.platform == 'WINDOWS'" },
    { ctx:'app_sign_on', tag:'Risk',    name:'No anomalous behavior',       desc:'True when no behavior-detection rule fired on this sign-in.',           expr:"Arrays.isEmpty(security.behaviors)" },
    { ctx:'app_sign_on', tag:'Risk',    name:'New country detected',        desc:'True when Okta flagged the sign-in as from a new country.',             expr:"Arrays.contains(security.behaviors, 'New Country')" },
    { ctx:'app_sign_on', tag:'Login',   name:'Sign-in identifier domain',   desc:'Reads what the user typed at the widget, which can differ from user.login.', expr:"String.substringAfter(login.identifier, '@') == 'acme.com'" },
    { ctx:'app_sign_on', tag:'Combined',name:'Managed + encrypted + MFA',   desc:'Full corporate-device posture check.',                                  expr:"device.profile.managed == true AND device.profile.diskEncryptionType == 'FULL' AND Arrays.contains(session.amr, 'mfa')" },
    { ctx:'access_cert', tag:'Entitlement', name:'Entitlement value check', desc:'Reads a governance entitlement on the app assignment.',                 expr:"appuser.entitlements.role == 'Contributor'" },
    { ctx:'access_cert', tag:'Entitlement', name:'Has a named license',     desc:'True when a multi-valued entitlement contains the value.',              expr:"Arrays.contains(appuser.entitlements.licenses, 'Professional')" },
    { ctx:'access_cert', tag:'Request',     name:'Grant operations only',   desc:'Restricts the rule to access grants.',                                  expr:"accessRequest.operation == 'GRANT'" },
    { ctx:'access_cert', tag:'Request',     name:'Request type check',      desc:'Reads the kind of access being certified.',                             expr:"accessRequest.metadata.type == 'APP_ACCESS'" },

    // ── IdP Attribute Mapping ────────────────────────────────────
    // These map attributes FROM an external SAML/OIDC IdP (idpuser) INTO the Okta profile.
    { ctx:'idp_attr_mapping', tag:'idpuser', name:'Map IdP email → Okta email',        desc:'Maps the email from the external IdP assertion to the Okta email attribute.',        expr:"idpuser.email" },
    { ctx:'idp_attr_mapping', tag:'idpuser', name:'Map IdP login',                     desc:'Maps the IdP login/subject to the Okta login.',                                      expr:"idpuser.login" },
    { ctx:'idp_attr_mapping', tag:'idpuser', name:'Map IdP first name',                desc:'Maps the firstName attribute from the IdP assertion.',                                expr:"idpuser.firstName" },
    { ctx:'idp_attr_mapping', tag:'idpuser', name:'Map IdP last name',                 desc:'Maps the lastName attribute from the IdP assertion.',                                 expr:"idpuser.lastName" },
    { ctx:'idp_attr_mapping', tag:'idpuser', name:'Map IdP displayName',               desc:'Maps the displayName from the IdP to the Okta displayName.',                         expr:"idpuser.displayName" },
    { ctx:'idp_attr_mapping', tag:'idpuser', name:'Map IdP department',                desc:'Maps the department custom attribute from the IdP assertion.',                        expr:"idpuser.department" },
    { ctx:'idp_attr_mapping', tag:'idpuser', name:'Map IdP role',                      desc:'Maps a custom role attribute sent by the external IdP.',                              expr:"idpuser.role" },
    { ctx:'idp_attr_mapping', tag:'idpuser', name:'IdP email → username (prefix)',     desc:'Extracts the local-part of the IdP email as the Okta username.',                     expr:"String.substringBefore(idpuser.email, '@')" },
    { ctx:'idp_attr_mapping', tag:'idpuser', name:'IdP employeeId with fallback',      desc:'Uses the IdP employeeId, falling back to the idpuser externalId.',                   expr:"idpuser.employeeId ?: idpuser.externalId" },
    { ctx:'idp_attr_mapping', tag:'idpuser', name:'Normalize IdP email domain',        desc:'Forces the IdP email domain to a canonical org domain.',                              expr:"String.substringBefore(idpuser.email, '@') + '@acme.com'" },
    { ctx:'idp_attr_mapping', tag:'idpuser', name:'IdP groups as CSV',                 desc:'Maps the IdP groups attribute (often a CSV string from SAML).',                      expr:"idpuser.groups" },
    { ctx:'idp_attr_mapping', tag:'idpuser', name:'Combine IdP first + last name',     desc:'Builds fullName from IdP first and last name attributes.',                            expr:"idpuser.firstName + ' ' + idpuser.lastName" },
    { ctx:'idp_attr_mapping', tag:'idpuser', name:'Conditional: IdP role → Okta type', desc:'Maps an IdP role attribute to an Okta userType.',                                   expr:"idpuser.role == 'admin' ? 'Administrator' : idpuser.role == 'manager' ? 'Manager' : 'Employee'" },
    { ctx:'idp_attr_mapping', tag:'idpuser', name:'IdP customAttribute fallback',      desc:'Uses a custom IdP attribute, falling back to a default value.',                      expr:"idpuser.customAttribute1 ?: 'default-value'" },
    { ctx:'idp_attr_mapping', tag:'user',    name:'Preserve existing Okta email',      desc:'Keeps the existing Okta email if already set, otherwise uses the IdP email.',        expr:"user.email ?: idpuser.email" },
    { ctx:'idp_attr_mapping', tag:'user',    name:'Merge IdP dept with existing',      desc:'Uses the IdP department if provided, falls back to the current Okta value.',         expr:"idpuser.department ?: user.department" },
  ];

  // ── Utilities ─────────────────────────────────────────────────
  function ls(k, d)  { try { const v=localStorage.getItem(k); return v!==null?JSON.parse(v):d; } catch { return d; } }
  function sl(k, v)  { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  function esc(s)    { return s==null?'':String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function inits(f,l){ return ((f||'').charAt(0)+(l||'').charAt(0)).toUpperCase()||'?'; }

  function fmtResult(v) {
    if (v===null||v===undefined) return '<span class="r-null">null</span>';
    if (typeof v==='boolean')    return `<span class="r-bool">${v}</span>`;
    if (typeof v==='number')     return `<span class="r-num">${v}</span>`;
    if (v instanceof Array)      return `<span class="r-arr">[${v.map(fmtResult).join(', ')}]</span>`;
    // A ZonedDateTime from DateTime.now() / .parseStringTime() is an object, but
    // JSON.stringify would dump its internals ({"_d":…,"_zone":…}) instead of the
    // timestamp. Render what Okta would emit if the expression stopped here.
    if (v && v._isOELDateTime)   return `<span class="r-str">"${esc(v.toString())}"</span>`;
    // Same for a CountryCode from .parseCountryCode() — an expression that stops
    // there is incomplete (Okta expects a .toName()/.toAlpha2() to follow), so
    // show the alpha-2 form plus a nudge rather than the wrapper's guts.
    if (v && v._isOELCountryCode) {
      const a2 = v.toAlpha2();
      return a2 === null
        ? '<span class="r-null">null</span> <span class="r-hint">— unrecognized country</span>'
        : `<span class="r-str">"${esc(a2)}"</span> <span class="r-hint">— CountryCode; chain .toName() / .toAlpha3() / .toNumeric()</span>`;
    }
    if (typeof v==='object')     return `<span class="r-obj">${esc(JSON.stringify(v,null,2))}</span>`;
    return `<span class="r-str">"${esc(String(v))}"</span>`;
  }

  // Restrictions Okta documents that don't belong to any one context, so they're
  // checked on top of the active context's own list.
  const GLOBAL_RESTRICTIONS = [
    {
      // Okta's supported getInternalProperty("status") values don't include
      // DEPROVISIONED — a deprovisioned user has no active session to evaluate
      // against, so this comparison is never true rather than being an error.
      pattern: /getInternalProperty\s*\(\s*['"]status['"]\s*\)[^)]*?['"]DEPROVISIONED['"]|['"]DEPROVISIONED['"][^)]*?getInternalProperty\s*\(\s*['"]status['"]\s*\)/,
      msg: 'DEPROVISIONED is not a supported value for getInternalProperty("status") — this condition never matches. Supported values include ACTIVE, STAGED, PROVISIONED, RECOVERY, LOCKED_OUT, PASSWORD_EXPIRED, SUSPENDED',
    },
    {
      // Version strings compared with the relational operators sort lexically,
      // so 14.10 reads as older than 14.9 and 9 as newer than 10.
      pattern: /(?:osVersion|oktaVerify\.version)\s*(?:<=|>=|<|>)|(?:<=|>=|<|>)\s*[^\s]*(?:osVersion|oktaVerify\.version)/,
      msg: 'Comparing a version with < or > sorts it as a string, so 14.10 reads as older than 14.9. Use versionGreaterThan() / versionLessThan() instead',
    },
  ];

  function getWarnings(expr, ctxId) {
    if (!expr || !ctxId) return [];
    const ctx = CONTEXTS.find(c => c.id === ctxId);
    if (!ctx) return [];
    return [...ctx.restrictions, ...GLOBAL_RESTRICTIONS]
      .filter(r => r.pattern ? r.pattern.test(expr) : (r.fn && r.fn(expr)))
      .map(r => r.msg);
  }

  // ── State ─────────────────────────────────────────────────────
  const state = {
    visible:    ls(LS.VISIBLE, false),
    minimized:  ls(LS.MIN,     false),
    tab:        ls(LS.TAB,     'builder'),
    ctx:        ls(LS.CTX,     'profile_mapping'),
    expr:       ls(LS.EXPR,    "String.substringBefore(user.email, '@')"),
    pos:        ls(LS.POS,     { x:null, y:null }),
    profile:    DEFAULT_PROFILE,
    evaluator:  null,
    evalTimer:     null,
    searchTimer:   null,
    sessionPollId: null,
    selectedUser: null,
    selectedApp:  null,   // { id, label, name, signOnMode, status, clientId, appProfile }
    appAssignment: 'unknown',  // 'unknown' | 'assigned' | 'unassigned'
    appSearchTimer: null,
    userSchema:    null,  // { attrName: null } — declared attributes on the org's user profile
    appSchema:     null,  // { attrName: null } — declared attributes on the selected app's user schema
    authServers:   [],    // { id, name, audiences, ... } — populated on init
    authServerClaims: {}, // { [authServerId]: [claim, ...] } — cached per server
    tokenType:  ls(LS.TOKEN_TYPE,   'id'),      // 'id' | 'access'
    authServerId: ls(LS.AUTH_SERVER, 'default'), // auth server to use for preview
    outputTab: 'result',  // 'result' | 'token' | 'rule' — which output-pane is showing
    chipVar:    'user',   // which object's attributes to show in Quick Insert chips
    searchOpen: false,
    isDragging: false, dragStart: {mx:0,my:0,ox:0,oy:0},
    isResizing: false, resizeStart:{mx:0,my:0,w:0,h:0},
  };
  state.evaluator = new OELEvaluator(state.profile);

  // ── Reference HTML ────────────────────────────────────────────
  function buildRefHTML() {
    return FUNCTION_REFERENCE.map(ns => `
      <div class="ref-ns">
        <div class="ref-ns-hd" style="--c:${ns.color}">
          <span class="ref-ns-dot" style="background:${ns.color}"></span>
          <span class="ref-ns-name">${esc(ns.ns)}</span>
          <span class="ref-ns-count">${ns.fns.length}</span>
        </div>
        ${ns.fns.map(fn => `
          <div class="ref-fn${fn.deprecated ? ' ref-fn-dep' : ''}" data-insert="${esc(fn.ex)}">
            <code class="ref-sig">${esc(fn.sig)}</code>${fn.deprecated ? '<span class="ref-dep">deprecated</span>' : ''}
            <p class="ref-desc">${esc(fn.desc)}</p>
            <code class="ref-ex">${esc(fn.ex)}</code>
          </div>`).join('')}
      </div>`).join('');
  }

  // ── Templates HTML ────────────────────────────────────────────
  function buildTplHTML(filterCtx) {
    const ctxIds = [...new Set(TEMPLATES.map(t => t.ctx))];
    return ctxIds.map(cid => {
      const ctxObj = CONTEXTS.find(c => c.id === cid);
      const items  = TEMPLATES.filter(t => t.ctx === cid && (!filterCtx || filterCtx === cid));
      if (!items.length) return '';
      return `
        <div class="tpl-group">
          <div class="tpl-group-hd">
            <span class="tpl-group-name">${esc(ctxObj?.label || cid)}</span>
            <span class="tpl-group-count">${items.length}</span>
          </div>
          ${items.map(t => `
            <div class="tpl-item" data-expr="${esc(t.expr)}">
              <div class="tpl-row">
                <span class="tpl-name">${esc(t.name)}</span>
                <span class="tpl-tag">${esc(t.tag)}</span>
              </div>
              <p class="tpl-desc">${esc(t.desc)}</p>
              <code class="tpl-expr">${esc(t.expr)}</code>
            </div>`).join('')}
        </div>`;
    }).join('');
  }

  function buildContextOptions() {
    return CONTEXTS.map(c => `<option value="${c.id}"${state.ctx===c.id?' selected':''}>${esc(c.label)}</option>`).join('');
  }

  // Build a scrollable attribute list for any profile variable (user, appuser, idpuser, etc.)
  // For user + appuser we merge in the org's schema so every DECLARED attribute is listed,
  // even if the currently selected user has no value for it.
  // Flatten nested signal objects to dotted leaf paths, so the Identity Engine
  // roots are browsable: `device` has to offer `profile.platform` and
  // `provider.zta.overall`, not a `profile` row that reads "[object Object]".
  // Arrays stay whole — `session.amr` is the expression an author wants, not
  // `session.amr.0`. Depth is capped because the deepest documented path is
  // three segments (`device.provider.oktaVerify.version`) and a cycle in a
  // fetched record shouldn't be able to hang the picker.
  function flattenAttrs(obj, prefix = '', depth = 0, out = {}) {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'function') continue;
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v) && depth < 3) {
        // An object with no readable leaves still deserves a row, otherwise it
        // vanishes from the picker entirely.
        if (Object.keys(v).length) { flattenAttrs(v, path, depth + 1, out); continue; }
      }
      out[path] = v;
    }
    return out;
  }

  function buildChips(varName) {
    const populated = state.profile[varName] || {};
    let base = {};
    if (varName === 'user'    && state.userSchema) base = state.userSchema;
    if (varName === 'appuser' && state.appSchema)  base = state.appSchema;
    // Populated values override the null placeholders from the schema.
    const merged = { ...base, ...populated };
    const entries = Object.entries(flattenAttrs(merged));
    if (!entries.length) {
      return `<div class="attr-empty">No attributes for <code>${esc(varName)}</code></div>`;
    }
    // Sort so populated attributes appear before null placeholders.
    entries.sort((a, b) => {
      const aHas = a[1] !== null && a[1] !== undefined;
      const bHas = b[1] !== null && b[1] !== undefined;
      if (aHas !== bHas) return aHas ? -1 : 1;
      return a[0].localeCompare(b[0]);
    });
    return entries.map(([k, v]) => {
      const raw = v === null || v === undefined ? 'null'
                : Array.isArray(v)              ? `[${v.length} items]`
                : typeof v === 'boolean'        ? String(v)
                : String(v);
      const display = raw.length > 40 ? raw.substring(0, 40) + '…' : raw;
      const dim     = (v === null || v === undefined) ? ' attr-row-null' : '';
      return `<button class="attr-row${dim}" data-insert="${esc(varName)}.${esc(k)}">
        <span class="attr-key">${esc(k)}</span>
        <span class="attr-val">${esc(display)}</span>
      </button>`;
    }).join('');
  }

  // Which var-tab buttons to show depends on the active context's `vars` list
  function buildVarTabs() {
    const ctx = CONTEXTS.find(c => c.id === state.ctx) || CONTEXTS[0];
    const available = ctx.vars || ['user'];
    // Only show the tabs for vars that exist in the current context. Order is
    // the tab order, so profile roots come before the Identity Engine runtime
    // signals — those only appear in the two contexts that can read them.
    const ALL_VARS = ['user', 'appuser', 'idpuser', 'org', 'app', 'access',
                      'device', 'session', 'security', 'login', 'accessRequest'];
    return ALL_VARS.filter(v => available.includes(v)).map(v =>
      `<button class="var-tab${state.chipVar === v ? ' var-tab-on' : ''}" data-var="${v}">${v}</button>`
    ).join('');
  }

  // Quick Insert picker. A deprecated entry is marked here rather than in
  // autocomplete: autocomplete only fires after a '.', and every deprecated
  // construct is either an unqualified call or an operator, so none of them can
  // ever appear in that list. This dropdown is the picker they DO appear in, so
  // it's where the marker has to be for a user to see it before choosing.
  // A <option> can't carry styling reliably across platforms, hence the suffix.
  function buildFnOptions() {
    return FUNCTION_REFERENCE.map(ns =>
      `<optgroup label="${esc(ns.ns)}">${
        ns.fns.map(fn => {
          const name = fn.sig.split('(')[0];
          return `<option value="${esc(fn.ex)}" title="${esc(fn.sig)}${fn.deprecated ? ' — deprecated' : ''}">${
            esc(name)}${fn.deprecated ? ' (deprecated)' : ''}</option>`;
        }).join('')
      }</optgroup>`
    ).join('');
  }

  // ── Main HTML ─────────────────────────────────────────────────
  function createHTML() {
    const activeCtx = CONTEXTS.find(c => c.id === state.ctx) || CONTEXTS[0];
    const tab = (id, icon, label) =>
      `<button class="tab${state.tab===id?' tab-on':''}" data-tab="${id}">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
        ${label}
      </button>`;

    const userLine = state.selectedUser
      ? `<div class="user-selected">
           <div class="avatar">${esc(inits(state.selectedUser.profile.firstName, state.selectedUser.profile.lastName))}</div>
           <div class="user-info">
             <span class="user-name">${esc([state.selectedUser.profile.firstName, state.selectedUser.profile.lastName].filter(Boolean).join(' ') || state.selectedUser.profile.login)}</span>
             <span class="user-email">${esc(state.selectedUser.profile.email||state.selectedUser.profile.login)}</span>
           </div>
           <button id="user-change" class="btn-xs btn-ghost">Change</button>
         </div>`
      : `<button id="user-search-btn" class="user-empty-btn">
           <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
           Using mock user — click to search org
         </button>`;

    const appLine = buildAppLineHTML();

    return `<div id="oeb-root">

  <!-- Both pill and overlay start hidden; init() reveals them only after confirming a valid session -->
  <button id="oeb-pill" class="pill hidden${state.visible?' pill-on':''}" title="Okta Expression Builder  (Alt+Shift+O)">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
    OEL Builder
  </button>

  <div id="oeb-overlay" class="overlay hidden${state.minimized?' min':''}">

    <div id="oeb-bar" class="bar">
      <div class="bar-title">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.9)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        Okta Expression Builder
      </div>
      <div class="bar-actions">
        <button id="oeb-close" class="bar-btn" title="Close (Alt+Shift+O to reopen)">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/>
          </svg>
        </button>
      </div>
    </div>

    <div class="tabs">
      ${tab('builder',   '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',                                           'Builder')}
      ${tab('reference', '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>', 'Reference')}
      ${tab('templates', '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',  'Templates')}
    </div>

    <!-- ══ BUILDER ══════════════════════════════════════════════ -->
    <div id="pane-builder" class="pane${state.tab==='builder'?' pane-on':''}">

      <!-- Context + User controls -->
      <div class="controls-strip">
        <div class="ctrl-row">
          <label class="ctrl-label">Context</label>
          <select id="ctx-select" class="ctrl-select" title="${esc(activeCtx.desc)}">
            ${buildContextOptions()}
          </select>
        </div>
        <div class="ctrl-row">
          <label class="ctrl-label">Testing as</label>
          <div class="user-ctrl">
            ${userLine}
          </div>
        </div>
        <!-- Inline user search panel (hidden by default) -->
        <div id="user-search-panel" class="user-search-panel hidden">
          <div class="user-search-row">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input id="user-query" class="user-query-input" type="text" placeholder="Search by name or email…" autocomplete="off">
            <div id="user-spinner" class="spinner hidden"></div>
            <button id="user-cancel" class="btn-xs btn-ghost">Cancel</button>
          </div>
          <div id="user-results" class="user-results"></div>
          <div id="user-api-err" class="user-api-err hidden"></div>
        </div>
        <div class="ctrl-row">
          <label class="ctrl-label">Testing app</label>
          <div class="app-ctrl">
            ${appLine}
          </div>
        </div>
        <!-- Inline app search panel (hidden by default) -->
        <div id="app-search-panel" class="user-search-panel hidden">
          <div class="user-search-row">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input id="app-query" class="user-query-input" type="text" placeholder="Search apps by name or label (incl. AD, LDAP)…" autocomplete="off">
            <div id="app-spinner" class="spinner hidden"></div>
            <button id="app-cancel" class="btn-xs btn-ghost">Cancel</button>
          </div>
          <div id="app-results" class="user-results"></div>
          <div id="app-api-err" class="user-api-err hidden"></div>
        </div>
        <!-- Policy presets — only shown when context is App Sign-On Policy -->
        <div class="ctrl-row" id="policy-preset-row">
          <label class="ctrl-label">Policy</label>
          <select id="policy-preset" class="ctrl-select" title="Preset for device/session/security context in App Sign-On Policy testing">
            ${buildPolicyPresetOptions()}
          </select>
        </div>
      </div>

      <!-- Expression editor -->
      <div class="section expr-section">
        <div class="section-hd">
          <span class="section-title">Expression</span>
          <div class="spacer"></div>
          <button id="btn-copy"  class="btn-sm">Copy</button>
          <button id="btn-clear" class="btn-sm btn-ghost">Clear</button>
        </div>
        <div class="expr-wrap">
          <pre id="expr-highlight" class="expr-ta expr-highlight" aria-hidden="true"></pre>
          <textarea id="expr-input" class="expr-ta expr-input-overlay" spellcheck="false" autocomplete="off"
            placeholder="Enter an OEL expression…&#10;e.g.  String.substringBefore(user.email, '@')"
          >${esc(state.expr)}</textarea>
          <div id="sig-popup" class="sig-popup hidden"></div>
          <div id="ac-popup"  class="ac-popup hidden"></div>
        </div>
      </div>

      <!-- Combined output: Result + Token Preview + Rule Preview.
           Tabs appear conditionally based on context so the box stays compact. -->
      <div class="section output-section">
        <div class="output-tabs" id="output-tabs">
          <button class="output-tab output-tab-on" data-otab="result" id="otab-result">Result <span id="result-badge" class="badge"></span></button>
          <button class="output-tab hidden" data-otab="token"  id="otab-token">Token Preview</button>
          <button class="output-tab hidden" data-otab="rule"   id="otab-rule">Rule Preview</button>
        </div>

        <div class="output-pane" id="opane-result">
          <div id="result-box" class="result-box">
            <span class="placeholder">Type an expression above to evaluate it…</span>
          </div>
          <div id="warnings-box" class="warnings-box hidden"></div>
        </div>

        <div class="output-pane hidden" id="opane-token">
          <div class="output-pane-hd">
            <select id="token-type-select" class="btn-sm token-select" title="Which token to preview">
              <option value="id"${state.tokenType==='id'?' selected':''}>ID Token</option>
              <option value="access"${state.tokenType==='access'?' selected':''}>Access Token</option>
            </select>
            <select id="auth-server-select" class="btn-sm token-select" title="Which authorization server's claims to include">
              <option value="default">Org Authorization Server</option>
            </select>
            <input id="token-claim-name" class="btn-sm token-name-input" type="text" placeholder="claim name" value="customClaim" spellcheck="false" autocomplete="off" />
            <span class="spacer"></span>
            <span class="token-title" id="token-section-title">Token Preview</span>
          </div>
          <pre id="token-preview" class="token-preview"></pre>
          <div id="token-eval-errors" class="token-eval-errors hidden"></div>
        </div>

        <div class="output-pane hidden" id="opane-rule">
          <div class="output-pane-hd">
            <button id="group-rule-run" class="btn-sm">Run against org</button>
            <div id="group-rule-spinner" class="spinner hidden"></div>
            <span class="spacer"></span>
            <div id="group-rule-summary" class="group-rule-summary hidden"></div>
          </div>
          <div id="group-rule-results" class="group-rule-results"></div>
          <div id="group-rule-err" class="user-api-err hidden"></div>
        </div>
      </div>

      <!-- Quick insert -->
      <div class="section insert-section">
        <div class="section-hd">
          <span class="section-title">Quick Insert</span>
          <select id="fn-select" class="fn-select">
            <option value="">— insert a function —</option>
            ${buildFnOptions()}
          </select>
        </div>
        <div class="var-tabs" id="var-tabs">
          <span class="var-tab-label">Variable:</span>
          ${buildVarTabs()}
        </div>
        <div id="attr-chips" class="attr-list">${buildChips(state.chipVar)}</div>
      </div>

    </div><!-- /builder -->

    <!-- ══ REFERENCE ════════════════════════════════════════════ -->
    <div id="pane-reference" class="pane${state.tab==='reference'?' pane-on':''}">
      <div class="search-bar">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input id="ref-search" class="search-input" type="text" placeholder="Search functions…" autocomplete="off">
      </div>
      <div id="ref-list" class="ref-list">${buildRefHTML()}</div>
    </div>

    <!-- ══ TEMPLATES ════════════════════════════════════════════ -->
    <div id="pane-templates" class="pane${state.tab==='templates'?' pane-on':''}">
      <div class="tpl-filter-bar">
        <button class="tpl-filter-btn tpl-filter-on" data-ctx="">All</button>
        ${CONTEXTS.map(c => `<button class="tpl-filter-btn" data-ctx="${c.id}">${esc(c.label)}</button>`).join('')}
      </div>
      <div id="tpl-list" class="tpl-list">${buildTplHTML()}</div>
    </div>

    <div id="oeb-resize" class="resize-handle"></div>
  </div>
</div>`;
  }

  // ── Inject ────────────────────────────────────────────────────
  function inject() {
    const w = document.createElement('div');
    w.innerHTML = createHTML();
    document.body.appendChild(w.firstElementChild);
    positionOverlay();
  }

  function positionOverlay() {
    const ov = document.getElementById('oeb-overlay'); if (!ov) return;
    const {x, y} = state.pos;
    if (x !== null && y !== null) {
      ov.style.left = `${clampX(x)}px`; ov.style.top = `${clampY(y)}px`;
      ov.style.right = 'auto'; ov.style.bottom = 'auto';
    }
  }

  const clampX = x => Math.max(8, Math.min(x, window.innerWidth  - (document.getElementById('oeb-overlay')?.offsetWidth  || 680) - 8));
  const clampY = y => Math.max(8, Math.min(y, window.innerHeight - 44));

  // ── Eval ──────────────────────────────────────────────────────
  function runEval() {
    const ta    = document.getElementById('expr-input');
    const box   = document.getElementById('result-box');
    const badge = document.getElementById('result-badge');
    const warn  = document.getElementById('warnings-box');
    if (!ta || !box || !badge) return;

    const expr = ta.value.trim();
    sl(LS.EXPR, ta.value); state.expr = ta.value;

    if (!expr) {
      box.innerHTML = '<span class="placeholder">Type an expression above to evaluate it…</span>';
      badge.textContent = ''; badge.className = 'badge';
      if (warn) { warn.innerHTML = ''; warn.classList.add('hidden'); }
      return;
    }

    const res = state.evaluator.evaluate(expr, state.profile);

    if (res.success) {
      box.innerHTML = fmtResult(res.result);
      badge.textContent = '✓ valid'; badge.className = 'badge badge-ok';
    } else if (res.error) {
      box.innerHTML = `<span class="r-err">${esc(res.error)}</span>`;
      badge.textContent = '✗ error'; badge.className = 'badge badge-err';
    }

    // Context warnings, then deprecation notices. Deprecations come from the
    // evaluator (which reads them off the parsed AST, so a construct in an
    // untaken ternary branch still reports) rather than from a regex here —
    // the `deprecated` flag on OEL_SPECS is the one source for them. They're
    // styled apart from the ⚠ restrictions because the meaning differs: a
    // restriction means Okta rejects this, a deprecation means Okta still
    // accepts it but there's a current spelling.
    const ws   = getWarnings(expr, state.ctx);
    const deps = res.deprecations || [];
    if (warn) {
      const rows = [
        ...ws.map(w   => `<div class="warn-item">⚠ ${esc(w)}</div>`),
        ...deps.map(d => `<div class="warn-item warn-dep">ⓘ ${esc(d)}</div>`),
      ];
      if (rows.length) {
        warn.innerHTML = rows.join('');
        warn.classList.remove('hidden');
      } else {
        warn.innerHTML = ''; warn.classList.add('hidden');
      }
    }

    renderTokenPreview(res.success ? res.result : null, !!res.error);
  }

  // Claim names Okta ACTUALLY emits in tokens. Sourced from Okta's OIDC
  // reference docs — NOT from generic OIDC standards. Some OIDC-standard
  // names (unique_name, client_id) are deliberately absent because Okta
  // doesn't emit them; likewise some Okta-specific names appear here that
  // are not in the OIDC spec.
  // See: developer.okta.com/docs/reference/api/oidc/#tokens-and-claims
  const OKTA_ID_TOKEN_CLAIMS = new Set([
    // Always emitted
    'ver', 'jti', 'iss', 'aud', 'iat', 'exp', 'amr', 'idp', 'nonce', 'auth_time', 'sub',
    // With `profile` scope
    'name', 'preferred_username', 'nickname', 'given_name', 'middle_name',
    'family_name', 'profile', 'zoneinfo', 'locale', 'updated_at',
    'birthdate', 'gender', 'picture', 'website',
    // With `email` scope
    'email', 'email_verified',
    // With `address` scope
    'address',
    // With `phone` scope
    'phone_number', 'phone_number_verified',
    // With `groups` scope (if configured)
    'groups',
  ]);
  const OKTA_ACCESS_TOKEN_CLAIMS = new Set([
    'ver', 'jti', 'iss', 'aud', 'iat', 'exp', 'cid', 'uid', 'scp', 'sub', 'auth_time',
    'groups',
  ]);

  // Evaluate every claim configured on the selected authorization server that
  // WOULD actually be included in a real token given the current context.
  // Filtering matches Okta's runtime: status=ACTIVE, correct claimType for the
  // token, and at least one of the claim's required scopes is in the requested
  // scope list (or the claim has no scope condition).
  // Returns { values, errors, skipped }:
  //   values:  { name: evaluatedValue }              — what makes it into the token
  //   errors:  [{ name, expr, message }]             — evaluated but threw; OMITTED from token
  //   skipped: [{ name, requiredScopes }]            — filtered out by scope condition
  function evaluateAuthServerClaims(claims, tokenType) {
    if (!claims || !claims.length) return { values: {}, errors: [], skipped: [] };
    const wantType = tokenType === 'id' ? 'IDENTITY' : 'RESOURCE';
    const requested = new Set(state.profile.access?.scope || []);
    const evaluator = new OELEvaluator(state.profile);
    const values  = {};
    const errors  = [];
    const skipped = [];

    const okList = tokenType === 'id' ? OKTA_ID_TOKEN_CLAIMS : OKTA_ACCESS_TOKEN_CLAIMS;
    // Okta-system-generated claims. These are populated by Okta from the
    // user/app/org context — the API may return them as claim records with
    // OEL expressions, but their value is determined by Okta at runtime, not
    // by any tenant expression. Base owns them; evaluation must not override.
    // (Access token `sub` = user's login; ID token `sub` = user's Okta ID.)
    const BASE_OWNED = new Set(['sub', 'iss', 'aud', 'iat', 'exp', 'jti', 'ver', 'cid', 'uid', 'scp', 'auth_time', 'idp', 'amr']);
    for (const c of claims) {
      if (!c || typeof c.name !== 'string') continue;
      if (!c.claimType || !c.valueType)     continue;
      // Strict: only names that Okta documents as being emitted for this
      // token type make it through. Okta returns many records from the
      // claims endpoint that it never emits (policy/internal/legacy AD
      // claim records like `restriction_criteria`, `unique_name`, etc.) —
      // this list is what actually lands in a real Okta token.
      if (!okList.has(c.name)) continue;
      // Skip claims Okta owns end-to-end so tenant-authored records can't
      // clobber the correct base values (e.g. access-token sub = user.login).
      if (BASE_OWNED.has(c.name)) continue;
      if (c.status !== 'ACTIVE') continue;
      if (c.claimType !== wantType) continue;

      // Inclusion rule (matches Okta runtime):
      //   include IF alwaysIncludeInToken === true
      //   OR      IF conditions.scopes has at least one match with requested scopes
      //   OTHERWISE skip
      // Previously we only checked conditions.scopes, which wrongly included
      // claims with alwaysIncludeInToken=false AND empty scope conditions —
      // those never appear in a real token.
      const reqScopes = c.conditions?.scopes || [];
      const alwaysInclude = c.alwaysIncludeInToken === true;
      const scopeMatched  = reqScopes.some(s => requested.has(s));
      if (!alwaysInclude && !scopeMatched) {
        // Only report as "skipped by scope" if it has scope conditions the user
        // could satisfy — otherwise the claim is simply not eligible and
        // there's nothing actionable for the user to know.
        if (reqScopes.length) skipped.push({ name: c.name, requiredScopes: reqScopes });
        continue;
      }

      if (c.valueType === 'EXPRESSION' && c.value) {
        const res = evaluator.evaluate(c.value, state.profile);
        if (res.success) {
          values[c.name] = res.result;
        }
        // Failing claims are silently dropped (matching Okta runtime). We
        // deliberately do NOT surface them in the UI — the Okta claims API
        // returns internal / placeholder claims that most tenants don't
        // recognize, and showing errors for them just confuses users.
        // Devs debugging their own tenant-authored claims can inspect the
        // full response in DevTools instead.
      } else if (c.valueType === 'GROUPS' && c.group_filter_type) {
        const groups = state.profile.groups || [];
        const pat = c.value || '';
        let filtered = groups;
        if (c.group_filter_type === 'STARTS_WITH')  filtered = groups.filter(g => g.startsWith(pat));
        else if (c.group_filter_type === 'CONTAINS') filtered = groups.filter(g => g.includes(pat));
        else if (c.group_filter_type === 'EQUALS')   filtered = groups.filter(g => g === pat);
        else if (c.group_filter_type === 'REGEX')    { try { const re = new RegExp(pat); filtered = groups.filter(g => re.test(g)); } catch {} }
        values[c.name] = filtered;
      }
      // SYSTEM claims are populated by the base-claims block; don't shadow them.
    }
    return { values, errors, skipped };
  }

  // Render a JWT-style / SAML-style preview. For OIDC we now build a full
  // token: base OIDC claims + all evaluated auth-server claims + the claim
  // currently being edited (whose expression result wins on name collision).
  // Rendering is skipped when the token pane isn't relevant to the current
  // context — the tab itself is already hidden by updateOutputTabs.
  function renderTokenPreview(exprResult, hadError) {
    const pre     = document.getElementById('token-preview');
    const title   = document.getElementById('token-section-title');
    if (!pre || !title) return;
    if (state.ctx !== 'oauth_claims' && state.ctx !== 'saml') return;

    const claimEl = document.getElementById('token-claim-name');
    const rawName = (claimEl?.value || '').trim();
    const claimName = rawName || 'customClaim';
    const editedValue = hadError ? '<expression error>' : (exprResult === undefined ? null : exprResult);

    if (state.ctx === 'saml') {
      // SAML preview stays simple — the auth-server / token-type controls only
      // apply to OIDC. Keep the previous behavior.
      title.textContent = 'SAML Assertion Preview';
      const p = state.profile;
      const attrs = {
        [claimName]: editedValue,
        email:       p.user?.email || null,
        firstName:   p.user?.firstName || null,
        lastName:    p.user?.lastName || null,
      };
      const attrLines = Object.entries(attrs).map(([k, v]) =>
        `    <saml:Attribute Name="${k}"><saml:AttributeValue>${v == null ? '' : String(v)}</saml:AttributeValue></saml:Attribute>`
      ).join('\n');
      const nameId = p.user?.login || p.user?.email || 'unknown';
      pre.textContent =
`<saml:Assertion>
  <saml:Subject>
    <saml:NameID Format="emailAddress">${nameId}</saml:NameID>
  </saml:Subject>
  <saml:AttributeStatement>
${attrLines}
  </saml:AttributeStatement>
</saml:Assertion>`;
      return;
    }

    // OIDC preview — build a full token based on token type + auth server.
    const p          = state.profile;
    const now        = 1735689600;
    const authServer = state.authServers.find(s => s.id === state.authServerId);
    const claims     = state.authServerClaims[state.authServerId] || [];
    const isOrgServer = state.authServerId === 'default' || /org authorization server/i.test(authServer?.name || '');
    // Okta issues tokens from the user-facing domain (tenant.okta.com), NOT
    // the admin domain the extension runs on (tenant-admin.okta.com). Strip
    // the "-admin" so `iss` matches what a real token would carry.
    const tokenHost = window.location.hostname.replace(/-admin\./, '.');
    const issuer    = isOrgServer
      ? `https://${tokenHost}`
      : authServer?.issuer || `https://${tokenHost}/oauth2/${state.authServerId}`;

    // Base claims Okta always includes in an ID token issued from its auth
    // servers. These aren't stored as configurable claim records — Okta
    // populates them from the user + app + org context at runtime.
    // `idp` is the Okta org's ID (00o...), not the URL — that's what Okta
    // emits when the user authenticates via Okta directly rather than through
    // an external federated identity provider.
    const baseIdToken = {
      sub:                p.user?.id || p.user?.login || null,
      iss:                issuer,
      aud:                p.app?.clientId || null,
      iat:                now,
      exp:                now + 3600,
      auth_time:          now,
      amr:                p.session?.amr || [],
      idp:                p.org?.id || null,
      name:               p.user?.displayName || null,
      email:              p.user?.email || null,
      preferred_username: p.user?.login || null,
    };
    const baseAccessToken = {
      ver:     1,
      jti:     'AT.preview',
      iss:     issuer,
      aud:     isOrgServer ? p.app?.clientId : (authServer?.audiences?.[0] || null),
      iat:     now,
      exp:     now + 3600,
      cid:     p.app?.clientId || null,
      uid:     p.user?.id || null,
      scp:     p.access?.scope || [],
      // Okta access token sub = the user's login (username). Not the id,
      // not the email — the login. Explicit here so it's clear.
      sub:     p.user?.login || null,
      auth_time: now,
    };

    const base = state.tokenType === 'id' ? baseIdToken : baseAccessToken;
    // Evaluated existing claims come from the selected auth server.
    const { values: evaluated, errors: evalErrors, skipped: skippedByScope } =
      evaluateAuthServerClaims(claims, state.tokenType);
    // The currently-edited claim wins on name collision so the user sees the
    // effect of their edit relative to the deployed configuration.
    const token = { ...base, ...evaluated, [claimName]: editedValue };

    // Title reflects both dimensions so the user can never lose track of what
    // they're looking at.
    const tokenLabel = state.tokenType === 'id' ? 'ID Token' : 'Access Token';
    const svrLabel   = isOrgServer ? 'Org Authorization Server' : `Custom: ${authServer?.name || state.authServerId}`;
    title.textContent = `${tokenLabel} Preview · ${svrLabel}`;
    pre.textContent = JSON.stringify(token, null, 2);

    // Footer shows only scope-filtered claims — that's an actionable signal
    // (add a scope to see them). Eval errors are silently dropped so the
    // preview matches Okta runtime without surfacing noise from claims the
    // tenant didn't author.
    const errFoot = document.getElementById('token-eval-errors');
    if (errFoot) {
      if (skippedByScope.length) {
        const skipRows = skippedByScope.map(s =>
          `<div class="token-err-row"><code class="token-err-name">${esc(s.name)}</code>` +
          `<span class="token-err-msg">requires scope: ${esc(s.requiredScopes.join(', '))}</span></div>`
        ).join('');
        errFoot.innerHTML =
          `<div class="token-info-hd">ⓘ ${skippedByScope.length} claim${skippedByScope.length===1?'':'s'} filtered out by scope conditions (requested scopes: ${esc([...(state.profile.access?.scope||[])].join(', ') || '(none)')}):</div>${skipRows}`;
        errFoot.classList.remove('hidden');
      } else {
        errFoot.innerHTML = '';
        errFoot.classList.add('hidden');
      }
    }
  }

  const scheduleEval = () => { clearTimeout(state.evalTimer); state.evalTimer = setTimeout(runEval, 180); };

  // ── Syntax highlighting ───────────────────────────────────────
  // Overlay approach: the visible <pre id="expr-highlight"> renders colored
  // tokens; a transparent-colored <textarea> sits on top so the browser still
  // handles selection, IME, caret, and accessibility. Both elements share the
  // exact same font, padding, and box model so tokens align perfectly with
  // the invisible characters in the textarea.
  const HL_KEYWORDS   = new Set(['null', 'true', 'false', 'AND', 'OR', 'and', 'or']);
  const HL_NAMESPACES = new Set(['String', 'Arrays', 'Time', 'Convert', 'Iso3166Convert', 'DateTime', 'Groups']);
  const HL_ROOTS      = new Set(['user', 'appuser', 'idpuser', 'app', 'access', 'org', 'device', 'session', 'security', 'groups', 'groupIds', 'client', 'oauth_request', 'context', 'login', 'accessRequest']);

  // Simple hand-rolled tokenizer sufficient for coloring. NOT the evaluator's
  // parser — that one handles precedence + AST; this one just yields spans.
  function highlightOEL(src) {
    const out = [];
    let i = 0;
    const push = (cls, text) => out.push({ cls, text });
    while (i < src.length) {
      const ch = src[i];
      // Whitespace
      if (/\s/.test(ch)) { push('', ch); i++; continue; }
      // String literals (single or double quoted, with escape handling)
      if (ch === '"' || ch === "'") {
        const quote = ch;
        let j = i + 1;
        while (j < src.length && src[j] !== quote) {
          if (src[j] === '\\' && j + 1 < src.length) j += 2;
          else j++;
        }
        if (j < src.length) j++;   // include closing quote
        push('hl-str', src.substring(i, j));
        i = j; continue;
      }
      // Numbers
      if (/\d/.test(ch)) {
        let j = i + 1;
        while (j < src.length && /[\d.]/.test(src[j])) j++;
        push('hl-num', src.substring(i, j));
        i = j; continue;
      }
      // Identifiers (including namespaces, keywords, functions, roots)
      if (/[A-Za-z_]/.test(ch)) {
        let j = i + 1;
        while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
        const word = src.substring(i, j);
        let cls;
        // `matches` is the deprecated relational operator, except directly after
        // a '.', where it's a property name. Same rule the evaluator's lexer
        // applies, so the coloring can't contradict the parse.
        if (word === 'matches') {
          let k = i - 1;
          while (k >= 0 && /\s/.test(src[k])) k--;
          cls = src[k] === '.' ? 'hl-ident' : 'hl-kw';
        }
        else if (HL_KEYWORDS.has(word))   cls = 'hl-kw';
        else if (HL_NAMESPACES.has(word)) cls = 'hl-ns';
        else if (HL_ROOTS.has(word))      cls = 'hl-root';
        else if (src[j] === '(')          cls = 'hl-fn';     // followed by ( → function call
        else                              cls = 'hl-ident';
        push(cls, word);
        i = j; continue;
      }
      // Operators & punctuation
      if (/[+\-*/%=!<>&|^~?:.,;()\[\]{}]/.test(ch)) {
        // Grab multi-char operators like ?:, ??, ==, !=, <=, >=, &&, ||, .!, ...
        let j = i + 1;
        const two = src.substring(i, i + 2);
        if (['?:', '??', '==', '!=', '<=', '>=', '&&', '||', '.!'].includes(two)) j = i + 2;
        const tok = src.substring(i, j);
        const cls = /[()\[\]{}]/.test(ch) ? 'hl-paren' : 'hl-op';
        push(cls, tok);
        i = j; continue;
      }
      // Fallback: unknown char, emit plain
      push('', ch); i++;
    }
    // Trailing newline so the pre always has at least one line-height worth of
    // trailing space (matches the textarea's behavior for a trailing empty line).
    return out.map(t => t.cls ? `<span class="${t.cls}">${esc(t.text)}</span>` : esc(t.text)).join('') + '\n';
  }

  function renderHighlight() {
    const ta = document.getElementById('expr-input');
    const pre = document.getElementById('expr-highlight');
    if (!ta || !pre) return;
    pre.innerHTML = highlightOEL(ta.value);
    // Sync scroll offset so long expressions align.
    pre.scrollTop  = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  }

  // ── Group Rule preview: run expression across a sample of real users ──
  // Only enabled in the group_rules context. Fetches up to N users, evaluates
  // the current expression against each one's profile + groups, and shows
  // pass/fail counts plus a scrollable list of matches. Intent: validate that
  // a rule captures the right users BEFORE saving it in Okta.
  const GROUP_RULE_SAMPLE_SIZE = 100;   // covers 4 pages of 25 users each via Link:next
  async function runGroupRulePreview() {
    const btn     = document.getElementById('group-rule-run');
    const sp      = document.getElementById('group-rule-spinner');
    const errEl   = document.getElementById('group-rule-err');
    const sumEl   = document.getElementById('group-rule-summary');
    const listEl  = document.getElementById('group-rule-results');
    if (!btn) return;

    const expr = document.getElementById('expr-input')?.value.trim();
    if (!expr) return;

    btn.disabled = true;
    sp?.classList.remove('hidden');
    errEl?.classList.add('hidden');
    if (sumEl) sumEl.classList.add('hidden');
    if (listEl) listEl.innerHTML = '';

    try {
      // Paginated so the rule preview scales with tenant size.
      const users = await fetchPaginated(`/api/v1/users?limit=25`, { maxPages: GROUP_RULE_SAMPLE_SIZE / 25 });

      // Group fetches in parallel (bounded — the sample is small).
      const withGroups = await Promise.all(users.map(async u => {
        try {
          const gr = await fetch(`/api/v1/users/${u.id}/groups?limit=200`, {
            credentials:'include', headers:{'Accept':'application/json'},
          });
          const gs = gr.ok ? await gr.json() : [];
          return { user: u, groups: gs.map(g => g.profile.name), groupIds: gs.map(g => g.id),
                   groupObjects: gs.map(toGroupObject) };
        } catch { return { user: u, groups: [], groupIds: [], groupObjects: [] }; }
      }));

      // Evaluate per user with a synthesized profile matching what the main
      // evaluator expects. Reuses the ONE evaluator to avoid re-parsing.
      const evaluator = new OELEvaluator({});
      const matches = [];
      let passed = 0, failed = 0, errored = 0;
      for (const {user, groups, groupIds, groupObjects} of withGroups) {
        const perProfile = {
          user:     { ...user.profile, id: user.id, status: user.status,
                       created: user.created, lastLogin: user.lastLogin },
          appuser:  {},
          idpuser:  {},
          org:      state.profile.org,
          app:      DEFAULT_PROFILE.app,
          access:   DEFAULT_PROFILE.access,
          groups, groupIds, groupObjects,
          session:  DEFAULT_PROFILE.session,
          security: DEFAULT_PROFILE.security,
          device:   DEFAULT_PROFILE.device,
        };
        const res = evaluator.evaluate(expr, perProfile);
        if (!res.success) { errored++; continue; }
        if (res.result === true) { passed++; matches.push(user); }
        else                     { failed++; }
      }

      if (sumEl) {
        sumEl.innerHTML =
          `<span class="gr-stat gr-pass">${passed} match${passed===1?'':'es'}</span>` +
          `<span class="gr-stat gr-fail">${failed} no match</span>` +
          (errored ? `<span class="gr-stat gr-err">${errored} error</span>` : '') +
          `<span class="gr-note">sampled ${withGroups.length} of ${withGroups.length === GROUP_RULE_SAMPLE_SIZE ? 'first' : 'all'} users</span>`;
        sumEl.classList.remove('hidden');
      }
      if (listEl) {
        if (!matches.length) {
          listEl.innerHTML = '<div class="no-results">No users in the sample matched this rule.</div>';
        } else {
          listEl.innerHTML = matches.map(u => {
            const name = [u.profile.firstName, u.profile.lastName].filter(Boolean).join(' ') || u.profile.login;
            const dept = u.profile.department ? ` · ${esc(u.profile.department)}` : '';
            return `<div class="gr-user">
              <div class="avatar ava-sm">${esc(inits(u.profile.firstName, u.profile.lastName))}</div>
              <div class="result-info">
                <div class="result-name">${esc(name)}</div>
                <div class="result-sub">${esc(u.profile.email||u.profile.login)}${dept}</div>
              </div>
            </div>`;
          }).join('');
        }
      }
    } catch (e) {
      if (errEl) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
    } finally {
      btn.disabled = false;
      sp?.classList.add('hidden');
    }
  }

  // ── Tabs ──────────────────────────────────────────────────────
  function switchTab(name) {
    state.tab = name; sl(LS.TAB, name);
    document.querySelectorAll('.tab').forEach(t  => t.classList.toggle('tab-on', t.dataset.tab === name));
    document.querySelectorAll('.pane').forEach(p => p.classList.toggle('pane-on', p.id === `pane-${name}`));
  }

  // ── Show / hide ───────────────────────────────────────────────
  function show() {
    state.visible = true; state.minimized = false;
    sl(LS.VISIBLE, true); sl(LS.MIN, false);
    document.getElementById('oeb-overlay')?.classList.remove('hidden','min');
    document.getElementById('oeb-pill')?.classList.add('pill-on');
    scheduleEval();
  }
  function hide() {
    state.visible = false; sl(LS.VISIBLE, false);
    document.getElementById('oeb-overlay')?.classList.add('hidden');
    document.getElementById('oeb-pill')?.classList.remove('pill-on');
  }
  function minimize() {
    state.minimized = !state.minimized; sl(LS.MIN, state.minimized);
    document.getElementById('oeb-overlay')?.classList.toggle('min', state.minimized);
  }

  // ── Context switch ────────────────────────────────────────────
  function switchContext(id) {
    state.ctx = id; sl(LS.CTX, id);
    refreshChips();   // rebuilds var-tabs for the new context
    updateAppPickerVisibility();
    scheduleEval();
  }

  // The app picker is only useful in contexts whose expression scope actually
  // includes app or appuser. Group Rules, IdP Attribute Mapping, App Sign-On
  // Policy, and Access Certification don't reference either — hiding the row
  // there recovers ~40px of vertical space for the Quick Insert chips.
  function contextUsesApp() {
    const ctx = CONTEXTS.find(c => c.id === state.ctx) || CONTEXTS[0];
    const vars = ctx.vars || ['user'];
    return vars.includes('app') || vars.includes('appuser');
  }
  function updateAppPickerVisibility() {
    const row   = document.querySelector('.app-ctrl')?.closest('.ctrl-row');
    const panel = document.getElementById('app-search-panel');
    const show  = contextUsesApp();
    if (row)   row.classList.toggle('hidden', !show);
    if (!show && panel) panel.classList.add('hidden');   // also collapse the search panel if open

    // Re-render the selected-app card so its "wrong type" pill updates.
    rebuildAppControls();
    // If the search panel is open, re-run the last query so results are re-filtered
    // for the new context.
    if (panel && !panel.classList.contains('hidden')) {
      const q = document.getElementById('app-query')?.value.trim() || '';
      scheduleAppSearch(q);
    }

    // Policy preset row only makes sense in App Sign-On Policy context.
    const presetRow = document.getElementById('policy-preset-row');
    if (presetRow) presetRow.classList.toggle('hidden', state.ctx !== 'app_sign_on');

    // Output-section tabs — show only those relevant to the current context.
    updateOutputTabs();
  }

  // Show/hide output tabs based on context, and switch to a still-visible tab
  // if the currently selected one is no longer available. Also relabels the
  // token tab + inner controls so SAML sees "Assertion Preview / attribute
  // name" and doesn't see the OIDC-specific token-type / auth-server pickers.
  function updateOutputTabs() {
    const tokenTab = document.getElementById('otab-token');
    const ruleTab  = document.getElementById('otab-rule');
    const showToken = state.ctx === 'oauth_claims' || state.ctx === 'saml';
    const showRule  = state.ctx === 'group_rules';
    if (tokenTab) tokenTab.classList.toggle('hidden', !showToken);
    if (ruleTab)  ruleTab.classList.toggle('hidden',  !showRule);

    // OIDC-only controls: token type + auth server. Hide entirely in SAML.
    const isSaml = state.ctx === 'saml';
    const tokenTypeSel = document.getElementById('token-type-select');
    const authSrvSel   = document.getElementById('auth-server-select');
    if (tokenTypeSel) tokenTypeSel.classList.toggle('hidden', isSaml);
    if (authSrvSel)   authSrvSel.classList.toggle('hidden',   isSaml);

    // Relabel the tab + placeholder text to match the artifact being previewed.
    if (tokenTab) {
      tokenTab.textContent = isSaml ? 'Assertion Preview' : 'Token Preview';
    }
    const claimName = document.getElementById('token-claim-name');
    if (claimName) {
      claimName.placeholder = isSaml ? 'attribute name' : 'claim name';
      // Update default only when the input is still holding the other mode's default.
      if (claimName.value === 'customClaim' && isSaml)      claimName.value = 'customAttribute';
      if (claimName.value === 'customAttribute' && !isSaml) claimName.value = 'customClaim';
    }

    // If the current tab has been hidden, fall back to 'result'.
    if (state.outputTab === 'token' && !showToken) state.outputTab = 'result';
    if (state.outputTab === 'rule'  && !showRule)  state.outputTab = 'result';
    setOutputTab(state.outputTab);
  }

  function setOutputTab(name) {
    state.outputTab = name;
    document.querySelectorAll('.output-tab').forEach(b =>
      b.classList.toggle('output-tab-on', b.dataset.otab === name));
    document.querySelectorAll('.output-pane').forEach(p =>
      p.classList.toggle('hidden', p.id !== `opane-${name}`));
    // Refresh dynamic content on tab switch so the pane reflects the latest state.
    if (name === 'token') scheduleEval();
  }

  // ── User search ───────────────────────────────────────────────
  function openUserSearch() {
    state.searchOpen = true;
    document.getElementById('user-search-panel')?.classList.remove('hidden');
    document.getElementById('user-query')?.focus();
  }
  function closeUserSearch() {
    state.searchOpen = false;
    document.getElementById('user-search-panel')?.classList.add('hidden');
    document.getElementById('user-results').innerHTML = '';
    document.getElementById('user-query').value = '';
    document.getElementById('user-api-err')?.classList.add('hidden');
  }

  // Extract the `next` page URL (if any) from an Okta response's Link header.
  // Okta uses standard RFC 5988 Link headers: `Link: <url>; rel="next", <url>; rel="self"`.
  //
  // IMPORTANT: Okta returns absolute URLs pointing at the org's *user-facing*
  // domain (e.g. https://tenant.okta.com), but the admin console runs on
  // tenant-admin.okta.com. Following the absolute URL triggers CORS and gets
  // rejected. We strip the URL to just its path+query so the browser resolves
  // it relative to the current admin origin (which does have a valid session).
  function parseNextLink(resp) {
    const raw = resp.headers.get('link') || resp.headers.get('Link');
    if (!raw) return null;
    for (const part of raw.split(',')) {
      const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
      if (m) {
        try {
          const u = new URL(m[1]);
          return u.pathname + u.search;
        } catch {
          return m[1];   // not a valid URL — hand back verbatim
        }
      }
    }
    return null;
  }

  // Follow Link: next headers up to `maxPages` pages, concatenating results.
  // Okta returns arrays for the endpoints we use, so we can flat-map safely.
  // maxPages caps runaway loops on huge tenants — the UI is designed around
  // interactive search, not full-tenant scans.
  async function fetchPaginated(url, { maxPages = 5, onProgress } = {}) {
    const opts = { credentials:'include', headers:{'Accept':'application/json'} };
    let next  = url;
    let pages = 0;
    let all   = [];
    while (next && pages < maxPages) {
      const r = await fetch(next, opts);
      if (r.status===401||r.status===403) throw new Error('Not authorised — make sure you are signed in to the Okta Admin Console.');
      if (!r.ok) throw new Error(`Okta API ${r.status}: ${r.statusText}`);
      const chunk = await r.json();
      if (!Array.isArray(chunk)) return chunk;   // non-list endpoint — bail out
      all = all.concat(chunk);
      onProgress?.(all.length, pages + 1);
      next = parseNextLink(r);
      pages++;
    }
    return all;
  }

  async function fetchUsers(q) {
    // Search endpoint. Bumped page size to 25; up to 4 pages = ~100 candidates
    // — plenty for the picker without stalling on huge tenants.
    return fetchPaginated(`/api/v1/users?limit=25&q=${encodeURIComponent(q)}`, { maxPages: 4 });
  }

  async function fetchUserGroups(uid) {
    // Follow pagination so users in >200 groups still get their full list.
    return fetchPaginated(`/api/v1/users/${uid}/groups?limit=200`, { maxPages: 10 });
  }

  // Okta group record → the shape `user.getGroups()` returns. Deliberately a
  // subset, not the raw record: the fields below are exactly the ones Okta
  // documents as readable from a group object (projection keys id, type,
  // created, lastUpdated, lastMembershipUpdated, profile.name,
  // profile.description — plus source.id for criteria matching). Passing the
  // record through whole would let `.![_links.source.href]` and `.![objectClass]`
  // evaluate here against a surface Okta doesn't expose.
  //
  // `source.id` isn't a field on the API record; for an app group Okta returns
  // the originating app instance as a link, so derive the id from its href.
  function toGroupObject(g) {
    const href = g._links && g._links.source && g._links.source.href;
    const srcId = href ? String(href).split('/').filter(Boolean).pop() : null;
    return {
      id:                     g.id,
      type:                   g.type,
      created:                g.created ?? null,
      lastUpdated:            g.lastUpdated ?? null,
      lastMembershipUpdated:  g.lastMembershipUpdated ?? null,
      profile: {
        name:        g.profile ? g.profile.name : null,
        description: g.profile ? (g.profile.description ?? null) : null,
      },
      ...(srcId ? { source: { id: srcId } } : {}),
    };
  }

  // Fetch a single user by id. Used to resolve manager profiles so expressions
  // like getManagerUser(user).email return real values rather than a derived
  // best-guess split of user.manager.
  async function fetchUserById(uid) {
    if (!uid) return null;
    try {
      const r = await fetch(`/api/v1/users/${encodeURIComponent(uid)}`, {
        credentials:'include', headers:{'Accept':'application/json'},
      });
      if (!r.ok) return null;
      const j = await r.json();
      return { ...j.profile, id: j.id, status: j.status };
    } catch { return null; }
  }

  async function fetchApps(q) {
    // Okta's /api/v1/apps `q` is a starts-with filter on label/name/user-visible name (case-insensitive).
    // When no query is provided we list the tenant's apps so directory sources (AD, LDAP)
    // — which have names like `active_directory`, `ldap_interface` and often no label
    // that starts with what the user would type — are still discoverable.
    // Paginated: 4 pages × 50 = up to 200 apps for tenants with many apps.
    const query = q ? `&q=${encodeURIComponent(q)}` : '';
    return fetchPaginated(`/api/v1/apps?limit=50${query}`, { maxPages: 4 });
  }

  async function fetchAppUser(appId, userId) {
    // Returns the app-user assignment profile (real appuser attributes) or null when
    // the user isn't assigned to this app (404 is the expected "unassigned" response).
    const r = await fetch(`/api/v1/apps/${appId}/users/${userId}`, {
      credentials:'include', headers:{'Accept':'application/json'},
    });
    if (r.status === 404) return null;
    if (r.status===401||r.status===403) throw new Error('Not authorised — make sure you are signed in to the Okta Admin Console.');
    if (!r.ok) throw new Error(`App-user fetch error: ${r.status}`);
    return r.json();
  }

  // Fetch the Okta user schema — reveals all declared attributes on the org's
  // user profile (custom fields), so Quick Insert can show what CAN be
  // referenced rather than only what happens to have a value on the picked user.
  async function fetchUserSchema() {
    try {
      const r = await fetch('/api/v1/meta/schemas/user/default', {
        credentials:'include', headers:{'Accept':'application/json'},
      });
      if (!r.ok) return null;
      const j = await r.json();
      // Merge base + custom properties into a flat name→null map.
      const props = {
        ...(j.definitions?.base?.properties   || {}),
        ...(j.definitions?.custom?.properties || {}),
      };
      const attrs = {};
      for (const name of Object.keys(props)) attrs[name] = null;
      return attrs;
    } catch { return null; }
  }

  async function fetchAppSchema(appId) {
    try {
      const r = await fetch(`/api/v1/meta/schemas/apps/${appId}/default`, {
        credentials:'include', headers:{'Accept':'application/json'},
      });
      if (!r.ok) return null;
      const j = await r.json();
      const props = {
        ...(j.definitions?.base?.properties   || {}),
        ...(j.definitions?.custom?.properties || {}),
      };
      const attrs = {};
      for (const name of Object.keys(props)) attrs[name] = null;
      return attrs;
    } catch { return null; }
  }

  // Authorization servers — includes the org auth server ("default") plus any
  // custom ones the tenant has set up. Used to drive the token-preview picker
  // and to fetch each server's claim mappings.
  async function fetchAuthServers() {
    try {
      const list = await fetchPaginated('/api/v1/authorizationServers?limit=100', { maxPages: 5 });
      if (!Array.isArray(list)) return [];
      // Ensure the org auth server is present. Different tenants surface it
      // differently — some include an entry with id="default" in the list,
      // some don't. Add a synthetic entry if it's missing.
      const hasOrg = list.some(s => s.id === 'default' || /org authorization server/i.test(s.name || ''));
      if (!hasOrg) {
        const tokenHost = window.location.hostname.replace(/-admin\./, '.');
        list.unshift({ id: 'default', name: 'Org Authorization Server', audiences: [`https://${tokenHost}`], _synthetic: true });
      }
      return list;
    } catch { return []; }
  }

  async function fetchAuthServerClaims(authServerId) {
    if (!authServerId) return [];
    try {
      const list = await fetchPaginated(
        `/api/v1/authorizationServers/${encodeURIComponent(authServerId)}/claims?limit=200`,
        { maxPages: 5 }
      );
      return Array.isArray(list) ? list : [];
    } catch { return []; }
  }

  async function fetchOrgInfo() {
    try {
      const r = await fetch('/api/v1/org', {
        credentials:'include', headers:{'Accept':'application/json'},
      });
      if (!r.ok) return;
      const data = await r.json();
      // Update the org context in the active profile with real values.
      // `id` (the 00o... org identifier) is what Okta emits as the `idp` claim
      // in ID tokens when the user authenticates via Okta directly.
      const org = {
        id:        data.id        || state.profile.org.id,
        name:      data.name      || state.profile.org.name,
        subDomain: data.subdomain || window.location.hostname.split('.')[0],
      };
      state.profile = { ...state.profile, org };
      state.evaluator = new OELEvaluator(state.profile);
      refreshChips();
      if (state.visible) scheduleEval();
    } catch { /* non-critical — org context is nice-to-have */ }
  }

  function renderResults(users) {
    const el = document.getElementById('user-results');
    if (!el) return;
    if (!users.length) { el.innerHTML = '<div class="no-results">No users found</div>'; return; }
    el.innerHTML = users.map(u => {
      const name = [u.profile.firstName, u.profile.lastName].filter(Boolean).join(' ') || u.profile.login;
      const sc   = u.status==='ACTIVE' ? 'status-active' : 'status-other';
      const dept = u.profile.department ? ` · ${esc(u.profile.department)}` : '';
      return `<button class="user-result" data-u="${esc(JSON.stringify(u))}">
        <div class="avatar ava-sm">${esc(inits(u.profile.firstName, u.profile.lastName))}</div>
        <div class="result-info">
          <div class="result-name">${esc(name)}</div>
          <div class="result-sub">${esc(u.profile.email||u.profile.login)}<span class="status-pill ${sc}">${esc(u.status)}</span>${dept}</div>
        </div>
      </button>`;
    }).join('');
  }

  async function selectUser(u) {
    const sp = document.getElementById('user-spinner');
    if (sp) sp.classList.remove('hidden');
    try {
      const groups  = await fetchUserGroups(u.id);
      const rp      = u.profile; // real Okta profile attributes

      // ── user: the real Okta user profile ──────────────────────
      const realUser = {
        ...rp,
        id:              u.id,
        status:          u.status,
        created:         u.created,
        activated:       u.activated,
        lastLogin:       u.lastLogin,
        lastUpdated:     u.lastUpdated,
        passwordChanged: u.passwordChanged,
        statusChanged:   u.statusChanged,
      };

      // ── appuser: a real user's appuser is meaningful only in the context
      // of an assigned application. Without a valid app assignment we can't
      // fabricate values (they'd be lies that don't reflect any real app's
      // schema), so appuser is null-shaped. When an app IS selected below
      // we replace this with the real assignment data.
      const realAppuser = emptyAppuser();

      // ── idpuser: what an external IdP would send for this person.
      // We use the real Okta attributes (since they often match what the IdP sent),
      // plus the custom IdP attributes from the default mock.
      const realIdpuser = {
        ...DEFAULT_PROFILE.idpuser,  // keep any custom IdP-specific attributes
        externalId:  u.id,
        login:       rp.login || rp.email,
        email:       rp.email,
        firstName:   rp.firstName,
        lastName:    rp.lastName,
        displayName: [rp.firstName, rp.lastName].filter(Boolean).join(' '),
        department:  rp.department,
        title:       rp.title,
        mobilePhone: rp.mobilePhone,
      };

      state.profile = {
        user:     realUser,
        appuser:  realAppuser,
        idpuser:  realIdpuser,
        apps:     DEFAULT_PROFILE.apps,
        app:      state.selectedApp ? state.profile.app : DEFAULT_PROFILE.app,
        access:   DEFAULT_PROFILE.access,
        manager:  null,   // will be filled below if the user has a managerId
        // Use org info already populated by fetchOrgInfo (real name + subdomain)
        org: state.profile.org,
        groups:   groups.map(g => g.profile.name),
        groupIds: groups.map(g => g.id),
        // Full records alongside the two flat arrays, not instead of them:
        // `Arrays.contains(groups, 'Engineering')` is documented usage and reads
        // the name array, while `user.getGroups()` criteria need group.type and
        // group.source.id, and its projections need real objects.
        groupObjects: groups.map(toGroupObject),
        session:  state.profile.session  || DEFAULT_PROFILE.session,
        security: state.profile.security || DEFAULT_PROFILE.security,
        device:   state.profile.device   || DEFAULT_PROFILE.device,
      };

      state.selectedUser = u;
      state.evaluator    = new OELEvaluator(state.profile);

      // Fire manager fetch + assignment lookup in parallel — both are optional.
      const [manager] = await Promise.all([
        fetchUserById(rp.managerId),
        state.selectedApp ? hydrateAppuserFromAssignment() : Promise.resolve(),
      ]);
      if (manager) {
        state.profile = { ...state.profile, manager };
        state.evaluator = new OELEvaluator(state.profile);
      }
      closeUserSearch();
    } catch (e) {
      const errEl = document.getElementById('user-api-err');
      if (errEl) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
    } finally {
      if (sp) sp.classList.add('hidden');
      try { rebuildUserControls(); } catch {}
      try { rebuildAppControls(); }  catch {}
      try { refreshChips(); }        catch {}
      scheduleEval();
    }
  }

  function clearSelectedUser() {
    state.selectedUser  = null;
    state.appAssignment = 'unknown';
    // Reset profile to defaults, but preserve any selected app + org info.
    state.profile = {
      ...DEFAULT_PROFILE,
      app: state.selectedApp ? state.profile.app : DEFAULT_PROFILE.app,
      org: state.profile.org,
    };
    state.evaluator = new OELEvaluator(state.profile);
    rebuildUserControls();
    rebuildAppControls();
    refreshChips();
    scheduleEval();
  }

  function rebuildUserControls() {
    const wrap = document.querySelector('.user-ctrl');
    if (!wrap) return;
    if (state.selectedUser) {
      const u = state.selectedUser;
      const name = [u.profile.firstName, u.profile.lastName].filter(Boolean).join(' ') || u.profile.login;
      wrap.innerHTML = `
        <div class="user-selected">
          <div class="avatar">${esc(inits(u.profile.firstName, u.profile.lastName))}</div>
          <div class="user-info">
            <span class="user-name">${esc(name)}</span>
            <span class="user-email">${esc(u.profile.email||u.profile.login)}</span>
          </div>
          <button id="user-change" class="btn-xs btn-ghost">Change</button>
        </div>`;
      document.getElementById('user-change')?.addEventListener('click', () => { clearSelectedUser(); });
    } else {
      wrap.innerHTML = `
        <button id="user-search-btn" class="user-empty-btn">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          Using mock user — click to search org
        </button>`;
      document.getElementById('user-search-btn')?.addEventListener('click', openUserSearch);
    }
  }

  // ── App-user shape helper ─────────────────────────────────────
  // A real user without a valid app assignment has NO appuser at all — not
  // even a null-shape schema. Any appuser.* reference must resolve to null,
  // and the Quick Insert chip list should show "No attributes for appuser".
  // We never invent appuser attributes; only real assignment data populates it.
  function emptyAppuser() {
    return {};
  }

  // ── App selection ─────────────────────────────────────────────
  function buildAppLineHTML() {
    if (!state.selectedApp) {
      return `<button id="app-search-btn" class="user-empty-btn">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
        Using mock app — click to search org
      </button>`;
    }
    const a = state.selectedApp;
    // Some apps (esp. directory sources) only have a name; some SWA/OIDC apps only have a label.
    const label = a.label || a.name || 'App';
    const mode  = a.signOnMode || '';
    const parts = String(label).split(/[\s_-]+/).filter(Boolean);
    // "Assignment" pill only meaningful when a user is also selected.
    let assignPill = '';
    if (state.selectedUser) {
      assignPill = state.appAssignment === 'assigned'
        ? `<span class="app-assign app-assign-ok" title="This user is assigned to this app">assigned</span>`
        : state.appAssignment === 'unassigned'
          ? `<span class="app-assign app-assign-warn" title="This user is not assigned to this app — every appuser attribute evaluates to null">not assigned</span>`
          : '';
    }
    // Warn if the selected app's sign-on mode doesn't fit the current context.
    let mismatchPill = '';
    const filter = contextAppFilter(state.ctx);
    if (filter && !appMatchesContext(a, state.ctx)) {
      mismatchPill = `<span class="app-assign app-assign-warn" title="This is a ${mode} app, but the current context requires ${filter.label}. Pick a different app.">wrong type</span>`;
    }
    return `<div class="user-selected app-selected">
      <div class="avatar app-avatar">${esc(inits(parts[0], parts[1]))}</div>
      <div class="user-info">
        <span class="user-name">${esc(label)}</span>
        <span class="user-email">${esc(mode)}${assignPill}${mismatchPill}</span>
      </div>
      <button id="app-change" class="btn-xs btn-ghost">Change</button>
    </div>`;
  }

  function openAppSearch() {
    state.searchOpen = true;
    document.getElementById('app-search-panel')?.classList.remove('hidden');
    document.getElementById('app-query')?.focus();
    document.getElementById('app-api-err')?.classList.add('hidden');
    // Pre-populate with the tenant's apps so directory sources (AD, LDAP)
    // are visible without knowing an exact prefix.
    scheduleAppSearch('');
  }
  function closeAppSearch() {
    state.searchOpen = false;
    document.getElementById('app-search-panel')?.classList.add('hidden');
    document.getElementById('app-api-err')?.classList.add('hidden');
  }

  function isDirectoryApp(a) {
    // Okta's app `name` for directory sources uses stable slugs.
    const n = (a.name || '').toLowerCase();
    return n === 'active_directory' || n.startsWith('ldap') || n === 'okta_org2org';
  }

  // Which sign-on modes are meaningful in the current expression context.
  // Returns an array of predicates that match Okta's signOnMode values.
  function contextAppFilter(ctx) {
    if (ctx === 'oauth_claims') return { modes: ['OPENID_CONNECT'], label: 'OIDC' };
    if (ctx === 'saml')         return { modes: ['SAML_2_0', 'SAML_1_1'], label: 'SAML' };
    if (ctx === 'inline_hook')  return { modes: ['OPENID_CONNECT', 'SAML_2_0', 'SAML_1_1'], label: 'OIDC or SAML' };
    return null;   // all other contexts accept any app
  }
  function appMatchesContext(a, ctx) {
    const f = contextAppFilter(ctx);
    if (!f) return true;
    return f.modes.includes(a.signOnMode);
  }

  function renderAppResults(apps) {
    const el = document.getElementById('app-results');
    if (!el) return;

    // Context-aware filtering: hide apps whose sign-on mode doesn't apply to
    // the current expression context. E.g. only OIDC apps in OAuth Claims.
    const filter = contextAppFilter(state.ctx);
    const shown  = filter ? apps.filter(a => appMatchesContext(a, state.ctx)) : apps;
    const hiddenCount = apps.length - shown.length;

    let header = '';
    if (filter) {
      header = `<div class="app-filter-hint">Showing ${filter.label} apps only for this context` +
               (hiddenCount ? ` · ${hiddenCount} other app${hiddenCount===1?'':'s'} hidden` : '') +
               `</div>`;
    }

    if (!shown.length) {
      el.innerHTML = header + `<div class="no-results">No ${filter ? filter.label + ' ' : ''}apps found</div>`;
      return;
    }
    el.innerHTML = header + shown.map(a => {
      const label = a.label || a.name || '(unnamed)';
      const sc    = a.status==='ACTIVE' ? 'status-active' : 'status-other';
      const mode  = a.signOnMode ? ` · ${esc(a.signOnMode)}` : '';
      const init  = (label || '?').trim()[0]?.toUpperCase() || '?';
      const dir   = isDirectoryApp(a) ? '<span class="status-pill app-dir-pill">directory</span>' : '';
      return `<button class="user-result" data-a="${esc(JSON.stringify(a))}">
        <div class="avatar ava-sm app-avatar">${esc(init)}</div>
        <div class="result-info">
          <div class="result-name">${esc(label)} ${dir}</div>
          <div class="result-sub">${esc(a.name || '')}<span class="status-pill ${sc}">${esc(a.status)}</span>${mode}</div>
        </div>
      </button>`;
    }).join('');
  }

  // Hydrate state.profile.app from an Okta /api/v1/apps entry.
  //   - clientId: real for OIDC apps, empty otherwise (matches Okta server behavior)
  //   - profile: merges the app's settings.app (custom app profile schema) so
  //     `app.<customField>` expressions can be tested against real tenant data.
  function buildAppContext(a) {
    const isOidc   = a.signOnMode && a.signOnMode.startsWith('OPENID');
    const clientId = isOidc ? (a.settings?.oAuthClient?.client_id ?? a.settings?.oauthClient?.client_id ?? a.credentials?.oauthClient?.client_id ?? '') : '';
    const appProfile = {
      label: a.label || a.name || '',
      ...(a.settings?.app || {}),   // any custom app-level profile properties defined on the app
    };
    return {
      id:         a.id,
      name:       a.name,
      label:      a.label,
      signOnMode: a.signOnMode,
      status:     a.status,
      clientId,
      profile:    appProfile,
    };
  }

  async function hydrateAppuserFromAssignment() {
    // Only attempt when we have both a real user and a real app selected.
    if (!state.selectedUser || !state.selectedApp) {
      state.appAssignment = 'unknown';
      return;
    }
    try {
      const assignment = await fetchAppUser(state.selectedApp.id, state.selectedUser.id);
      if (assignment) {
        // Replace appuser with the ACTUAL app-user data for this app.
        // No merging with derived-from-Okta-profile fields — those don't belong
        // to this app and would mislead expression testing.
        const real = {
          ...(assignment.profile || {}),
        };
        // Top-level metadata fields that Okta expressions commonly reference.
        if (assignment.credentials?.userName) real.userName   = assignment.credentials.userName;
        if (assignment.externalId != null)    real.externalId = assignment.externalId;
        if (assignment.status)                real.status     = assignment.status;
        if (assignment.syncState)             real.syncState  = assignment.syncState;
        if (assignment.lastSync)              real.lastSync   = assignment.lastSync;
        if (assignment.created)               real.created    = assignment.created;
        if (assignment.lastUpdated)           real.lastUpdated = assignment.lastUpdated;
        if (assignment.passwordChanged)       real.passwordChanged = assignment.passwordChanged;
        state.profile = { ...state.profile, appuser: real };
        state.appAssignment = 'assigned';
      } else {
        // Unassigned — the user has no app-user profile for this app, so
        // every appuser.* reference must resolve to null (that's what would
        // happen at runtime in Okta too). Show the shape with all null values.
        state.profile = { ...state.profile, appuser: emptyAppuser() };
        state.appAssignment = 'unassigned';
      }
    } catch (e) {
      // Non-fatal — leave appuser as-is and surface via the api-err element on the app panel.
      const errEl = document.getElementById('app-api-err');
      if (errEl) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
      state.appAssignment = 'unknown';
    }
    state.evaluator = new OELEvaluator(state.profile);
  }

  async function selectApp(a) {
    const sp = document.getElementById('app-spinner');
    if (sp) sp.classList.remove('hidden');
    try {
      state.selectedApp = a;
      state.profile = { ...state.profile, app: buildAppContext(a) };
      state.evaluator = new OELEvaluator(state.profile);
      // Fire schema + assignment fetch in parallel — schema is orthogonal
      // to whether the user is actually assigned to the app.
      const [schema] = await Promise.all([
        fetchAppSchema(a.id),
        hydrateAppuserFromAssignment(),
      ]);
      state.appSchema = schema;
      closeAppSearch();
    } catch (e) {
      const errEl = document.getElementById('app-api-err');
      if (errEl) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
    } finally {
      if (sp) sp.classList.add('hidden');
      // Always re-render UI + chips, even if an earlier step threw, so the
      // Quick Insert section doesn't get left in a stale state.
      try { rebuildAppControls(); } catch {}
      try { refreshChips(); }      catch {}
      scheduleEval();
    }
  }

  function clearSelectedApp() {
    state.selectedApp   = null;
    state.appAssignment = 'unknown';
    state.appSchema     = null;
    // Restore mock app; appuser depends on whether we have a real user or not:
    //   - Real user: no app → no valid appuser (all null)
    //   - Mock user: fall back to the mock appuser
    const newAppuser = state.selectedUser ? emptyAppuser() : DEFAULT_PROFILE.appuser;
    state.profile = { ...state.profile, app: DEFAULT_PROFILE.app, appuser: newAppuser };
    state.evaluator = new OELEvaluator(state.profile);
    rebuildAppControls();
    refreshChips();
    scheduleEval();
  }

  function rebuildAppControls() {
    const wrap = document.querySelector('.app-ctrl');
    if (!wrap) return;
    wrap.innerHTML = buildAppLineHTML();
    if (state.selectedApp) {
      document.getElementById('app-change')?.addEventListener('click', () => { clearSelectedApp(); });
    } else {
      document.getElementById('app-search-btn')?.addEventListener('click', openAppSearch);
    }
  }

  function scheduleAppSearch(q) {
    clearTimeout(state.appSearchTimer);
    const res = document.getElementById('app-results');
    const err = document.getElementById('app-api-err');
    // No 2-char minimum: empty query lists the tenant's first 20 apps,
    // 1 char matches short directory-source names (e.g. "l" → ldap_interface).
    state.appSearchTimer = setTimeout(async () => {
      const sp = document.getElementById('app-spinner');
      if (sp) sp.classList.remove('hidden');
      try {
        renderAppResults(await fetchApps(q));
        if (err) err.classList.add('hidden');
      } catch (e) {
        if (res) res.innerHTML='';
        if (err) { err.textContent=e.message; err.classList.remove('hidden'); }
      } finally {
        if (sp) sp.classList.add('hidden');
      }
    }, 250);
  }

  function refreshChips() {
    // Reset chipVar to 'user' if the current chipVar isn't in the new context's vars
    const ctx = CONTEXTS.find(c => c.id === state.ctx) || CONTEXTS[0];
    if (!(ctx.vars || ['user']).includes(state.chipVar)) state.chipVar = 'user';

    const tabs = document.getElementById('var-tabs');
    if (tabs) tabs.innerHTML = `<span class="var-tab-label">Variable:</span>${buildVarTabs()}`;

    const chips = document.getElementById('attr-chips');
    if (chips) chips.innerHTML = buildChips(state.chipVar);

    // Re-bind var-tab clicks
    document.getElementById('var-tabs')?.addEventListener('click', onVarTabClick);
  }

  function onVarTabClick(e) {
    const btn = e.target.closest('.var-tab');
    if (!btn) return;
    state.chipVar = btn.dataset.var;
    document.querySelectorAll('.var-tab').forEach(b => b.classList.toggle('var-tab-on', b.dataset.var === state.chipVar));
    const chips = document.getElementById('attr-chips');
    if (chips) chips.innerHTML = buildChips(state.chipVar);
  }

  function scheduleSearch(q) {
    clearTimeout(state.searchTimer);
    const res = document.getElementById('user-results');
    const err = document.getElementById('user-api-err');
    if (q.length < 2) { if(res) res.innerHTML=''; return; }
    state.searchTimer = setTimeout(async () => {
      const sp = document.getElementById('user-spinner');
      if (sp) sp.classList.remove('hidden');
      try {
        renderResults(await fetchUsers(q));
        if (err) err.classList.add('hidden');
      } catch (e) {
        if (res) res.innerHTML='';
        if (err) { err.textContent=e.message; err.classList.remove('hidden'); }
      } finally {
        if (sp) sp.classList.add('hidden');
      }
    }, 350);
  }

  // ── Editor autocomplete ───────────────────────────────────────
  // Triggered by typing `.` after a known root identifier. Shows a floating
  // list of completions and inserts on Enter/Tab/click. Roots include profile
  // objects (user, appuser, etc.), function namespaces (String, Arrays, ...),
  // and nested paths (app.profile.x → keys of state.profile.app.profile).
  const AC_ROOTS = new Set([
    'user', 'appuser', 'idpuser', 'app', 'access', 'org',
    'device', 'session', 'security', 'groups',
    // Identity Engine roots. They complete off state.profile like the rest —
    // which is why DEFAULT_PROFILE carries the full documented surface rather
    // than a couple of representative fields.
    'login', 'accessRequest',
    'String', 'Arrays', 'Time', 'Convert', 'Iso3166Convert', 'DateTime', 'Groups',
  ]);

  // Map function-namespace roots to their function names (short form, no signature).
  function acFunctionNames(ns) {
    const nsEntry = FUNCTION_REFERENCE.find(x => x.ns === ns || (ns === 'Groups' && x.ns === 'Groups & User'));
    if (!nsEntry) return [];
    return nsEntry.fns
      .map(f => f.sig.split('(')[0])
      .filter(name => name.startsWith(ns + '.'))
      .map(name => name.substring(ns.length + 1));
  }

  // Resolve a dotted path like "app.profile" against state.profile. Returns
  // the value at that path (may be an object, array, string, etc.), or null
  // if the path can't be resolved.
  function resolveValuePath(path) {
    const parts = path.split('.');
    if (!AC_ROOTS.has(parts[0])) return null;
    let cur = state.profile[parts[0]];
    if (cur == null) return null;
    for (let i = 1; i < parts.length; i++) {
      cur = cur?.[parts[i]];
      if (cur == null) return null;
    }
    return cur;
  }

  // Backwards-compat wrapper — returns the value only if it's a non-array object
  // whose keys should be enumerated as attribute completions.
  function resolveObjectPath(path) {
    const v = resolveValuePath(path);
    if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;
    return v;
  }

  // Identity Engine method-style completions available on string values.
  // Only Okta-documented OEL / IE methods — no invented aliases.
  // Keep in sync with STRING_METHOD_ALIASES in evaluator.js — a name here that
  // isn't in that table autocompletes into an expression that won't evaluate.
  const STRING_METHOD_COMPLETIONS = [
    'substringBefore', 'substringAfter', 'substring',
    'toUpperCase', 'toLowerCase', 'removeSpaces',
    'replace', 'replaceFirst', 'contains', 'length',
    'toInteger', 'toNumber',
    'parseStringTime', 'parseUnixTime', 'parseWindowsTime',
    'parseCountryCode', 'versionGreaterThan', 'versionLessThan',
  ];

  // Method completions on ZonedDateTime-like values (results of parseStringTime,
  // DateTime.now(), etc.). We can't detect these values from the profile without
  // executing, but users chain them after other calls — signature help will
  // still work in that case.
  const DATETIME_METHOD_COMPLETIONS = [
    'withinDays', 'withinHours', 'withinMinutes', 'withinSeconds',
    'plusDays', 'plusHours', 'plusMinutes', 'plusSeconds',
    'minusDays', 'minusHours', 'minusMinutes', 'minusSeconds',
    'toZone', 'toString', 'toUnix', 'toWindows',
  ];

  // Return {items, replaceStart} or null if no autocomplete should show.
  function computeAutocomplete(text, caret) {
    // Grab everything up to caret; scan back to a `.` preceded by an identifier.
    // Match `<identifier(.identifier)*>.<optional partial>` immediately before caret.
    const upto = text.substring(0, caret);
    const m = upto.match(/([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.([A-Za-z_][A-Za-z0-9_]*)?$/);
    if (!m) return null;
    const chain   = m[1];      // e.g. "user" or "app.profile"
    const partial = m[2] || '';
    const rootIdent = chain.split('.')[0];
    if (!AC_ROOTS.has(rootIdent)) return null;

    let candidates = [];
    let completionKind = 'attribute';   // 'attribute' | 'function' | 'method'
    // Function namespaces short-circuit — only their functions apply, and
    // only at the first level (String.foo, not String.foo.bar).
    if (['String','Arrays','Time','Convert','Iso3166Convert','DateTime','Groups'].includes(rootIdent) && chain === rootIdent) {
      candidates = acFunctionNames(rootIdent);
      completionKind = 'function';
    } else {
      const obj = resolveObjectPath(chain);
      if (obj) candidates = Object.keys(obj);
      // For `user.` and `appuser.` also merge in schema keys (declared attrs
      // even if not currently populated).
      if (chain === 'user'    && state.userSchema) candidates = [...new Set([...candidates, ...Object.keys(state.userSchema)])];
      if (chain === 'appuser' && state.appSchema)  candidates = [...new Set([...candidates, ...Object.keys(state.appSchema)])];
      // Method chaining: if the chain resolves to a STRING, offer Identity
      // Engine method-style completions like `.substringBefore(...)`.
      if (!candidates.length) {
        const val = resolveValuePath(chain);
        if (typeof val === 'string') {
          candidates = STRING_METHOD_COMPLETIONS.slice();
          completionKind = 'method';
        }
      }
    }

    // Filter by partial (case-insensitive) and rank prefix-match above contains.
    const p = partial.toLowerCase();
    const scored = candidates
      .filter(c => !p || c.toLowerCase().includes(p))
      .map(c => ({
        name: c,
        rank: p && c.toLowerCase().startsWith(p) ? 0 : (p ? 1 : 0),
      }))
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
      .slice(0, 40);

    if (!scored.length) return null;
    return {
      items: scored.map(s => s.name),
      replaceStart: caret - partial.length,
      chain,
      kind: completionKind,
    };
  }

  const acState = { items: [], index: 0, replaceStart: 0, open: false, chain: '', kind: 'attribute' };

  // Format a value for the right-side hint column in the completion list.
  // Kept short — this is a peek, not a full read. Full-width truncation at 32.
  function acFormatHint(chain, name, kind) {
    if (kind === 'function' || kind === 'method') {
      // For function completions, show a signature snippet from FUNCTION_REFERENCE.
      const fqName = chain + '.' + name;
      let sig = SIG_INDEX.get(fqName);
      if (!sig && kind === 'method') {
        // Method chaining: look up the plain method name (matches String.<method>).
        sig = SIG_INDEX.get('String.' + name) || SIG_INDEX.get('Time.' + name);
      }
      if (sig) {
        const p = sig.params.map(x => x.label).join(', ');
        return `<span class="ac-hint-sig">(${esc(p)})</span>`;
      }
      return `<span class="ac-hint-sig">()</span>`;
    }
    // Attribute: pull the current value from the profile.
    const parent = resolveValuePath(chain);
    const v = parent && typeof parent === 'object' ? parent[name] : undefined;
    if (v === null || v === undefined) return `<span class="ac-hint-null">null</span>`;
    if (Array.isArray(v))               return `<span class="ac-hint-arr">[${v.length} item${v.length===1?'':'s'}]</span>`;
    if (typeof v === 'boolean')         return `<span class="ac-hint-bool">${v}</span>`;
    if (typeof v === 'number')          return `<span class="ac-hint-num">${v}</span>`;
    if (typeof v === 'object')          return `<span class="ac-hint-obj">{…}</span>`;
    const s = String(v);
    const shown = s.length > 32 ? s.substring(0, 32) + '…' : s;
    return `<span class="ac-hint-str">"${esc(shown)}"</span>`;
  }

  // Compute the caret's pixel offset within the textarea using a mirror div.
  // Returns { x, y } relative to the textarea's top-left corner.
  function measureCaret(ta) {
    const style = window.getComputedStyle(ta);
    const mirror = document.createElement('div');
    // Copy every layout-affecting property so the mirror wraps identically.
    for (const p of ['fontFamily','fontSize','fontWeight','fontStyle','letterSpacing',
                     'lineHeight','textTransform','wordSpacing','whiteSpace',
                     'paddingTop','paddingRight','paddingBottom','paddingLeft',
                     'borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth',
                     'boxSizing','tabSize']) {
      mirror.style[p] = style[p];
    }
    mirror.style.position   = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap   = 'break-word';
    mirror.style.width      = ta.clientWidth + 'px';
    mirror.style.overflow   = 'hidden';
    mirror.textContent = ta.value.substring(0, ta.selectionEnd);
    const marker = document.createElement('span');
    marker.textContent = '|';
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const rect = marker.getBoundingClientRect();
    const mrect = mirror.getBoundingClientRect();
    const x = rect.left - mrect.left;
    const y = rect.top  - mrect.top;
    document.body.removeChild(mirror);
    return { x, y, lineHeight: parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4 };
  }

  function renderAutocomplete() {
    const popup = document.getElementById('ac-popup');
    const ta    = document.getElementById('expr-input');
    if (!popup || !ta) return;
    if (!acState.open || !acState.items.length) {
      popup.classList.add('hidden');
      popup.innerHTML = '';
      return;
    }
    popup.innerHTML = acState.items.map((name, i) => {
      const hint = acFormatHint(acState.chain, name, acState.kind);
      return `<button class="ac-item${i===acState.index?' ac-item-sel':''}" data-i="${i}">
        <span class="ac-name">${esc(name)}</span><span class="ac-hint">${hint}</span>
      </button>`;
    }).join('');
    popup.classList.remove('hidden');
    // Position near caret. Cap so it doesn't overflow the container.
    const { x, y, lineHeight } = measureCaret(ta);
    popup.style.left = Math.max(0, Math.min(x, ta.clientWidth - 200)) + 'px';
    popup.style.top  = (y + lineHeight + 2 - ta.scrollTop) + 'px';
  }

  function closeAutocomplete() {
    acState.open = false;
    acState.items = [];
    renderAutocomplete();
  }

  function updateAutocomplete() {
    const ta = document.getElementById('expr-input');
    if (!ta) return;
    const res = computeAutocomplete(ta.value, ta.selectionEnd);
    if (!res) { closeAutocomplete(); return; }
    acState.items        = res.items;
    acState.index        = 0;
    acState.replaceStart = res.replaceStart;
    acState.open         = true;
    acState.chain        = res.chain;
    acState.kind         = res.kind;
    renderAutocomplete();
  }

  function acceptAutocomplete() {
    if (!acState.open || !acState.items.length) return false;
    const ta = document.getElementById('expr-input');
    if (!ta) return false;
    const pick = acState.items[acState.index];
    const before = ta.value.substring(0, acState.replaceStart);
    const after  = ta.value.substring(ta.selectionEnd);

    // Functions and methods get inserted with parens, cursor between them,
    // and signature help fired immediately. Attributes insert plain.
    // Skip appending parens if the user's text already has an open paren
    // right after (e.g., they typed the `(` themselves).
    const isFn = acState.kind === 'function' || acState.kind === 'method';
    const nextChar = after[0] || '';
    const appendParens = isFn && nextChar !== '(';

    const insertion = appendParens ? pick + '()' : pick;
    ta.value = before + insertion + after;
    // Caret goes between the parens for functions, or at end of the pick for attrs.
    const caretPos = appendParens ? before.length + pick.length + 1 : before.length + pick.length;
    ta.setSelectionRange(caretPos, caretPos);
    closeAutocomplete();
    renderHighlight();
    scheduleEval();
    // Trigger signature help so the user sees the params immediately.
    if (appendParens) setTimeout(renderSignatureHelp, 0);
    return true;
  }

  function acKeydown(e) {
    if (!acState.open) return;
    if (e.key === 'ArrowDown') {
      acState.index = (acState.index + 1) % acState.items.length;
      renderAutocomplete();
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      acState.index = (acState.index - 1 + acState.items.length) % acState.items.length;
      renderAutocomplete();
      e.preventDefault();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (acceptAutocomplete()) e.preventDefault();
    } else if (e.key === 'Escape') {
      closeAutocomplete();
      e.preventDefault();
    }
  }

  // ── Signature help ────────────────────────────────────────────
  // When the caret is inside a function call's parens, show the function
  // signature above the caret with the current argument highlighted. Guides
  // users through OEL functions with multi-arg or optional signatures like
  // Groups.contains(app, pat[, limit]) or String.stringSwitch(input, default, k1, v1, ...).

  // Parse a signature string like "Groups.contains(app, pat[, limit])" into
  // { funcName, params: ['app','pat','[limit]'] }. Preserves optional-brackets
  // in the param label so we can render them dimmer.
  function parseSignature(sig) {
    const m = sig.match(/^([^\(]+)\((.*)\)$/);
    if (!m) return null;
    const funcName = m[1].trim();
    const paramStr = m[2].trim();
    if (!paramStr) return { funcName, params: [] };
    // Split by top-level commas — accounting for [optional] groups. Okta sigs
    // use `[, name]` to indicate an optional param, and `...` for varargs.
    const params = [];
    let depth = 0, cur = '';
    for (let i = 0; i < paramStr.length; i++) {
      const ch = paramStr[i];
      if (ch === '[') { depth++; cur += ch; }
      else if (ch === ']') { depth--; cur += ch; }
      else if (ch === ',' && depth === 0) { params.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim()) params.push(cur.trim());
    // Strip leading `[, ` and trailing `]` on optional params, remember it was optional.
    return {
      funcName,
      params: params.map(p => {
        const optional = /^\[,?\s*.+\]$/.test(p);
        const label    = p.replace(/^\[,?\s*/, '').replace(/\]$/, '').trim();
        return { label, optional };
      }),
    };
  }

  // Build a name → signature entry index once so lookups are cheap.
  const SIG_INDEX = (() => {
    const idx = new Map();
    for (const ns of FUNCTION_REFERENCE) {
      for (const fn of ns.fns) {
        const parsed = parseSignature(fn.sig);
        if (!parsed) continue;
        // Ignore method-style signatures like `value.toUpperCase()` — those
        // start with a lowercase pseudo-identifier, not a real function name.
        if (!/^[A-Z]/.test(parsed.funcName)) continue;
        idx.set(parsed.funcName, { ...parsed, desc: fn.desc, ex: fn.ex });
      }
    }
    return idx;
  })();

  // Given the current textarea content + caret position, return the innermost
  // enclosing function call context, or null. Handles nested calls and skips
  // over string literals so parens/commas inside strings don't confuse it.
  function parseCallContext(text, caret) {
    const stack = [];   // { funcName, argCommas }
    let i = 0;
    while (i < caret) {
      const ch = text[i];
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i++;
        while (i < caret && text[i] !== quote) {
          if (text[i] === '\\' && i + 1 < caret) i += 2;
          else i++;
        }
        i++;
        continue;
      }
      if (ch === '(') {
        // Scan back from `(` to grab the function name (identifier chain).
        let j = i - 1;
        while (j >= 0 && /\s/.test(text[j])) j--;
        const nameEnd = j + 1;
        while (j >= 0 && /[\w.]/.test(text[j])) j--;
        const funcName = text.substring(j + 1, nameEnd);
        stack.push({ funcName, argCommas: 0 });
      } else if (ch === ')') {
        stack.pop();
      } else if (ch === ',' && stack.length) {
        stack[stack.length - 1].argCommas++;
      }
      i++;
    }
    if (!stack.length) return null;
    const top = stack[stack.length - 1];
    if (!top.funcName) return null;
    return { funcName: top.funcName, argIndex: top.argCommas };
  }

  function renderSignatureHelp() {
    const popup = document.getElementById('sig-popup');
    const ta    = document.getElementById('expr-input');
    if (!popup || !ta) return;

    const ctx = parseCallContext(ta.value, ta.selectionEnd);
    const sig = ctx && SIG_INDEX.get(ctx.funcName);
    if (!sig) { popup.classList.add('hidden'); popup.innerHTML = ''; return; }

    // Render each param — highlight the one the caret is sitting on. If the
    // signature accepts varargs (`...`) and we're past the last named param,
    // highlight the last one as a repeater.
    const activeIdx = Math.min(ctx.argIndex, sig.params.length - 1);
    const isVarargs = sig.params.some(p => p.label.endsWith('...'));
    const paramsHtml = sig.params.map((p, i) => {
      const active = (i === activeIdx) || (isVarargs && ctx.argIndex >= sig.params.length - 1 && i === sig.params.length - 1);
      const cls    = 'sig-param' + (active ? ' sig-param-active' : '') + (p.optional ? ' sig-param-opt' : '');
      const label  = (p.optional ? '[' + p.label + ']' : p.label);
      return `<span class="${cls}">${esc(label)}</span>`;
    }).join('<span class="sig-sep">, </span>');

    popup.innerHTML =
      `<div class="sig-line"><span class="sig-fn">${esc(sig.funcName)}</span>(${paramsHtml})</div>` +
      `<div class="sig-desc">${esc(sig.desc)}</div>`;
    popup.classList.remove('hidden');

    // Position above the caret line. If not enough room above, drop below.
    const { x, y, lineHeight } = measureCaret(ta);
    popup.style.left = Math.max(0, Math.min(x, ta.clientWidth - 300)) + 'px';
    const above = y - popup.offsetHeight - 4 - ta.scrollTop;
    popup.style.top  = (above >= 0 ? above : (y + lineHeight + 2 - ta.scrollTop)) + 'px';
  }

  function closeSignatureHelp() {
    const popup = document.getElementById('sig-popup');
    if (popup) { popup.classList.add('hidden'); popup.innerHTML = ''; }
  }

  // ── Insert helpers ────────────────────────────────────────────
  function insertAt(text) {
    const ta = document.getElementById('expr-input'); if (!ta) return;
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    ta.focus(); renderHighlight(); scheduleEval();
  }

  // ── Drag & resize ─────────────────────────────────────────────
  function startDrag(e) {
    if (e.button||e.target.closest('.bar-btn')) return;
    const r = document.getElementById('oeb-overlay').getBoundingClientRect();
    state.isDragging = true;
    state.dragStart  = {mx:e.clientX, my:e.clientY, ox:r.left, oy:r.top};
    document.getElementById('oeb-overlay').classList.add('dragging');
    e.preventDefault();
  }
  function onDragMove(e) {
    if (!state.isDragging) return;
    const {mx,my,ox,oy} = state.dragStart, ov = document.getElementById('oeb-overlay');
    ov.style.left = `${clampX(ox+e.clientX-mx)}px`; ov.style.top = `${clampY(oy+e.clientY-my)}px`;
    ov.style.right = 'auto'; ov.style.bottom = 'auto';
  }
  function stopDrag() {
    if (!state.isDragging) return;
    state.isDragging = false;
    const ov = document.getElementById('oeb-overlay');
    ov.classList.remove('dragging');
    state.pos = {x:parseInt(ov.style.left), y:parseInt(ov.style.top)}; sl(LS.POS, state.pos);
  }
  function startResize(e) {
    if (e.button) return;
    const ov = document.getElementById('oeb-overlay');
    state.isResizing = true; state.resizeStart = {mx:e.clientX, my:e.clientY, w:ov.offsetWidth, h:ov.offsetHeight};
    e.preventDefault(); e.stopPropagation();
  }
  function onResizeMove(e) {
    if (!state.isResizing) return;
    const {mx,my,w,h} = state.resizeStart, ov = document.getElementById('oeb-overlay');
    ov.style.width  = `${Math.max(500,w+e.clientX-mx)}px`;
    ov.style.height = `${Math.max(420,h+e.clientY-my)}px`;
  }

  // ── Events ────────────────────────────────────────────────────
  function bindEvents() {
    document.getElementById('oeb-pill')?.addEventListener('click', () => state.visible ? hide() : show());
    document.getElementById('oeb-close')?.addEventListener('click', hide);
    document.getElementById('oeb-bar')?.addEventListener('mousedown', startDrag);
    document.addEventListener('mousemove', e => { onDragMove(e); onResizeMove(e); });
    document.addEventListener('mouseup',   () => { stopDrag(); state.isResizing = false; });
    document.getElementById('oeb-resize')?.addEventListener('mousedown', startResize);

    // Tabs
    document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

    // Context selector
    document.getElementById('ctx-select')?.addEventListener('change', e => switchContext(e.target.value));

    // Policy preset (only visible in app_sign_on context)
    document.getElementById('policy-preset')?.addEventListener('change', e => applyPolicyPreset(e.target.value));

    // Token preview claim-name input — re-renders the preview on every keystroke
    document.getElementById('token-claim-name')?.addEventListener('input', () => scheduleEval());

    // Token type + auth server selectors
    document.getElementById('token-type-select')?.addEventListener('change', e => {
      state.tokenType = e.target.value;
      sl(LS.TOKEN_TYPE, state.tokenType);
      scheduleEval();
    });
    document.getElementById('auth-server-select')?.addEventListener('change', e => {
      state.authServerId = e.target.value;
      sl(LS.AUTH_SERVER, state.authServerId);
      loadClaimsForCurrentAuthServer();
      scheduleEval();
    });

    // Group Rule preview
    document.getElementById('group-rule-run')?.addEventListener('click', runGroupRulePreview);

    // Output section tabs (Result / Token Preview / Rule Preview)
    document.getElementById('output-tabs')?.addEventListener('click', e => {
      const btn = e.target.closest('.output-tab');
      if (btn && !btn.classList.contains('hidden')) setOutputTab(btn.dataset.otab);
    });

    // User search
    document.getElementById('user-search-btn')?.addEventListener('click', openUserSearch);
    document.getElementById('user-cancel')?.addEventListener('click',     closeUserSearch);
    document.getElementById('user-query')?.addEventListener('input', e => scheduleSearch(e.target.value.trim()));
    document.getElementById('user-results')?.addEventListener('click', e => {
      const btn = e.target.closest('.user-result');
      if (btn) { try { selectUser(JSON.parse(btn.dataset.u)); } catch {} }
    });
    // user-change is added dynamically in rebuildUserControls

    // App search
    document.getElementById('app-search-btn')?.addEventListener('click', openAppSearch);
    document.getElementById('app-cancel')?.addEventListener('click',     closeAppSearch);
    document.getElementById('app-query')?.addEventListener('input', e => scheduleAppSearch(e.target.value.trim()));
    document.getElementById('app-results')?.addEventListener('click', e => {
      const btn = e.target.closest('.user-result');
      if (btn) { try { selectApp(JSON.parse(btn.dataset.a)); } catch {} }
    });
    // app-change is added dynamically in rebuildAppControls

    // Expression
    const ta = document.getElementById('expr-input');
    if (ta) {
      const refreshEditorAssist = () => { updateAutocomplete(); renderSignatureHelp(); };
      ta.addEventListener('input', () => { renderHighlight(); scheduleEval(); refreshEditorAssist(); });
      ta.addEventListener('scroll', renderHighlight);
      ta.addEventListener('keydown', e => {
        // Autocomplete keys take priority over the tab-inserts-space handler.
        if (acState.open && ['ArrowUp','ArrowDown','Enter','Tab','Escape'].includes(e.key)) {
          acKeydown(e); return;
        }
        if (e.key === 'Tab') { e.preventDefault(); insertAt('  '); }
      });
      ta.addEventListener('blur', () => setTimeout(() => { closeAutocomplete(); closeSignatureHelp(); }, 120));
      ta.addEventListener('click', refreshEditorAssist);
      ta.addEventListener('keyup', e => {
        // Recompute after cursor moves via arrow/home/end without changing text,
        // or when the user types brackets/commas that change call-context.
        if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key)) {
          refreshEditorAssist();
        }
      });
      // Initial render for whatever expression was persisted.
      renderHighlight();
    }

    // Autocomplete popup click-to-insert.
    document.getElementById('ac-popup')?.addEventListener('mousedown', e => {
      const btn = e.target.closest('.ac-item');
      if (btn) {
        acState.index = parseInt(btn.dataset.i, 10) || 0;
        acceptAutocomplete();
        e.preventDefault();   // keep focus on the textarea
      }
    });

    // Insert
    document.getElementById('fn-select')?.addEventListener('change', e => {
      if (e.target.value) { insertAt(e.target.value); e.target.value=''; }
    });
    // Attribute rows (delegated — list is rebuilt dynamically)
    document.getElementById('pane-builder')?.addEventListener('click', e => {
      const c = e.target.closest('.attr-row'); if (c) insertAt(c.dataset.insert);
    });
    // Variable tab switcher
    document.getElementById('var-tabs')?.addEventListener('click', onVarTabClick);

    // Copy / Clear
    document.getElementById('btn-copy')?.addEventListener('click', () => {
      const ta = document.getElementById('expr-input'); if (!ta?.value.trim()) return;
      navigator.clipboard.writeText(ta.value.trim()).then(() => {
        const btn = document.getElementById('btn-copy');
        if (btn) { const p=btn.textContent; btn.textContent='Copied!'; setTimeout(()=>btn.textContent=p,1200); }
      });
    });
    document.getElementById('btn-clear')?.addEventListener('click', () => {
      const ta = document.getElementById('expr-input'); if(ta){ta.value=''; renderHighlight(); scheduleEval();}
    });

    // Reference: click to use in builder
    document.getElementById('ref-list')?.addEventListener('click', e => {
      const fn = e.target.closest('.ref-fn');
      if (fn?.dataset.insert) { const ta=document.getElementById('expr-input'); if(ta){ta.value=fn.dataset.insert;scheduleEval();} switchTab('builder'); }
    });

    // Reference: filter
    document.getElementById('ref-search')?.addEventListener('input', e => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('.ref-ns').forEach(ns => {
        let any = false;
        ns.querySelectorAll('.ref-fn').forEach(fn => {
          const show = !q || fn.textContent.toLowerCase().includes(q);
          fn.style.display = show ? '' : 'none';
          if (show) any = true;
        });
        ns.style.display = any ? '' : 'none';
      });
    });

    // Templates: filter bar
    document.querySelector('.tpl-filter-bar')?.addEventListener('click', e => {
      const btn = e.target.closest('.tpl-filter-btn');
      if (!btn) return;
      document.querySelectorAll('.tpl-filter-btn').forEach(b => b.classList.remove('tpl-filter-on'));
      btn.classList.add('tpl-filter-on');
      const tplList = document.getElementById('tpl-list');
      if (tplList) tplList.innerHTML = buildTplHTML(btn.dataset.ctx || '');
      // Re-bind click
      bindTplClicks();
    });
    bindTplClicks();

    // Keyboard shortcut
    document.addEventListener('keydown', e => {
      if (e.altKey && e.shiftKey && e.code==='KeyO') { e.preventDefault(); state.visible ? hide() : show(); }
    });
  }

  function bindTplClicks() {
    document.getElementById('tpl-list')?.addEventListener('click', e => {
      const item = e.target.closest('.tpl-item');
      if (item?.dataset.expr) {
        const ta = document.getElementById('expr-input');
        if (ta) { ta.value = item.dataset.expr; renderHighlight(); scheduleEval(); }
        switchTab('builder');
      }
    });
  }

  // ── Session monitoring ────────────────────────────────────
  // If the Okta session ends while the builder is open, close and hide it.

  function handleSessionEnd() {
    clearInterval(state.sessionPollId);
    // Hide the overlay and pill — don't leave our UI floating on a logged-out page
    document.getElementById('oeb-overlay')?.classList.add('hidden');
    document.getElementById('oeb-pill')?.classList.add('hidden');
    state.visible = false;
  }

  async function checkSession() {
    // Returns true  = session valid (or unknown due to network error)
    // Returns false = definitely no active session (401/403/404)
    try {
      const r = await fetch('/api/v1/sessions/me', {
        credentials: 'include', headers: { 'Accept': 'application/json' },
      });
      if (r.status === 401 || r.status === 403 || r.status === 404) {
        handleSessionEnd();
        return false;
      }
      return true;
    } catch {
      // Network error — assume the session is still valid; polling will catch a real logout
      return true;
    }
  }

  function startSessionPolling() {
    // init() already ran the first check; this just sets up the recurring poll
    state.sessionPollId = setInterval(checkSession, 60_000);
  }

  async function init() {
    inject();
    bindEvents();
    updateAppPickerVisibility();

    // Gate all visibility on a confirmed valid session
    const loggedIn = await checkSession();
    if (loggedIn) {
      document.getElementById('oeb-pill')?.classList.remove('hidden');
      if (state.visible) {
        document.getElementById('oeb-overlay')?.classList.remove('hidden');
        scheduleEval();
      }
    }
    // These are non-blocking and run regardless — they handle their own error states
    fetchOrgInfo();
    fetchUserSchema().then(s => {
      if (s) { state.userSchema = s; if (state.visible) refreshChips(); }
    });
    fetchAuthServers().then(list => {
      state.authServers = list;
      populateAuthServerSelect();
      // Kick off a claims fetch for the persisted / default selection so the
      // token preview has data as soon as the user enters oauth_claims context.
      loadClaimsForCurrentAuthServer();
    });
    startSessionPolling();
  }

  function populateAuthServerSelect() {
    const sel = document.getElementById('auth-server-select');
    if (!sel) return;
    sel.innerHTML = state.authServers.map(s => {
      const label = s.id === 'default' || /org authorization server/i.test(s.name || '')
        ? `Org: ${s.name}` : `Custom: ${s.name}`;
      return `<option value="${esc(s.id)}"${s.id === state.authServerId ? ' selected' : ''}>${esc(label)}</option>`;
    }).join('');
    // If the persisted authServerId isn't in the fetched list, fall back to the first entry.
    if (!state.authServers.some(s => s.id === state.authServerId) && state.authServers[0]) {
      state.authServerId = state.authServers[0].id;
      sl(LS.AUTH_SERVER, state.authServerId);
      sel.value = state.authServerId;
    }
  }

  async function loadClaimsForCurrentAuthServer() {
    const id = state.authServerId;
    if (!id) return;
    if (state.authServerClaims[id]) return;   // cached
    const claims = await fetchAuthServerClaims(id);
    state.authServerClaims[id] = claims;
    // If the token section is currently visible, re-render with the fresh claims.
    if (state.ctx === 'oauth_claims' || state.ctx === 'saml') scheduleEval();
  }

  init();

})();
