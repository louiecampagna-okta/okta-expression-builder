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
      restrictions: [],
    },
    {
      id: 'idp_attr_mapping',
      label: 'IdP Attribute Mapping',
      desc: 'Map attributes from an external Identity Provider (SAML/OIDC IdP) into the Okta user profile',
      vars: ['user', 'idpuser', 'org'],
      restrictions: [
        { pattern: /\bappuser\./, msg: 'appuser is not available in IdP attribute mapping — use idpuser to reference incoming IdP attributes' },
      ],
    },
    {
      id: 'group_rules',
      label: 'Group Rules',
      desc: 'Dynamic group membership criteria',
      vars: ['user'],
      restrictions: [
        { pattern: /\bTime\./,    msg: 'Time functions are not available in Group Rules' },
        { pattern: /\bConvert\./, msg: 'Convert functions are not available in Group Rules' },
        { pattern: /\bappuser\./, msg: 'appuser is not available in Group Rules' },
        { pattern: /\bidpuser\./, msg: 'idpuser is not available in Group Rules' },
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
      ],
    },
    {
      id: 'saml',
      label: 'SAML Attribute Statements',
      desc: 'Customize SAML response attribute values for an application',
      vars: ['user', 'appuser', 'org'],
      restrictions: [],
    },
    {
      id: 'app_sign_on',
      label: 'App Sign-On Policy',
      desc: 'Authentication and authorization policy conditions (Identity Engine)',
      vars: ['user', 'device', 'security', 'session'],
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
      vars: ['user', 'org'],
      restrictions: [],
    },
  ];

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
      employeeNumber: 'EMP42',
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
      hireDate: '2021-06-15', jobCode: 'SWE-SR', jobLevel: 'L4',
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
    session:  { amr: ['pwd', 'mfa'] },
    security: { risk: { level: 'LOW' } },
    device:   { profile: { managed: true, registered: true } },

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
        { sig:'String.substring(str, start[, end])',          desc:'Extracts a substring by index (0-based, end exclusive).',                 ex:"String.substring(user.firstName, 0, 1)" },
        { sig:'String.substringBefore(str, delimiter)',       desc:'Returns the part of str before the first delimiter.',                      ex:"String.substringBefore(user.email, '@')" },
        { sig:'String.substringAfter(str, delimiter)',        desc:'Returns the part of str after the first delimiter.',                       ex:"String.substringAfter(user.email, '@')" },
        { sig:'String.replace(str, pattern, replacement)',    desc:'Replaces all regex matches (global).',                                     ex:"String.replace(user.displayName, '\\\\s+', '.')" },
        { sig:'String.replaceFirst(str, pattern, replacement)',desc:'Replaces the first regex match only.',                                    ex:"String.replaceFirst(user.login, '@.*', '')" },
        { sig:'String.stringContains(str, substring)',        desc:'True if str contains the substring.',                                      ex:"String.stringContains(user.email, 'acme.com')" },
        { sig:'String.startsWith(str, prefix)',               desc:'True if str starts with prefix.',                                          ex:"String.startsWith(user.userType, 'Emp')" },
        { sig:'String.removeSpaces(str)',                     desc:'Removes all whitespace characters.',                                        ex:"String.removeSpaces(user.displayName)" },
        { sig:'String.trim(str)',                             desc:'Strips leading and trailing whitespace.',                                    ex:"String.trim(user.firstName)" },
        { sig:'String.match(str, regex)',                     desc:'True if str matches the full regex.',                                       ex:"String.match(user.email, '^[a-z]+\\\\.[a-z]+@')" },
        { sig:'String.splitByRegex(str, regex)',              desc:'Splits str by regex and returns an array.',                                 ex:"String.splitByRegex(user.displayName, '\\\\s+')" },
        { sig:'String.stringSwitch(input, default, k1, v1, ...)',desc:'Returns v1 if input==k1, else next pair, else default.',               ex:"String.stringSwitch(user.department,'Other','Engineering','dev')" },
        { sig:'String.toString(value)',                       desc:'Converts any value to its string representation.',                          ex:"String.toString(user.employeeNumber)" },
        { sig:'value.toUpperCase()',                          desc:'Identity Engine method style — same as String.toUpperCase.',               ex:"user.department.toUpperCase()" },
        { sig:'value.toLowerCase()',                          desc:'Identity Engine method style — same as String.toLowerCase.',               ex:"user.firstName.toLowerCase()" },
        { sig:'value.substringBefore(delimiter)',             desc:'Identity Engine method style — same as String.substringBefore.',           ex:"user.email.substringBefore('@')" },
        { sig:'value.substringAfter(delimiter)',              desc:'Identity Engine method style — same as String.substringAfter.',            ex:"user.email.substringAfter('@')" },
      ],
    },
    {
      ns: 'Arrays', color: '#00853b',
      fns: [
        { sig:'Arrays.contains(array, element)',       desc:'True if array contains element.',                         ex:"Arrays.contains(groups, 'Engineering')" },
        { sig:'Arrays.size(array)',                    desc:'Number of elements.',                                      ex:"Arrays.size(groups)" },
        { sig:'Arrays.isEmpty(array)',                 desc:'True if array is null or empty.',                          ex:"Arrays.isEmpty(groups)" },
        { sig:'Arrays.add(array, element)',            desc:'Returns new array with element appended.',                 ex:"Arrays.add(groups, 'NewGroup')" },
        { sig:'Arrays.remove(array, element)',         desc:'Returns new array with element removed.',                  ex:"Arrays.remove(groups, 'Engineering')" },
        { sig:'Arrays.get(array, index)',              desc:'Returns element at index (0-based).',                      ex:"Arrays.get(groups, 0)" },
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
        { sig:'Time.fromStringToIso8601(string)',      desc:'Parses a human-readable date string to ISO 8601.',        ex:"Time.fromStringToIso8601(user.hireDate)" },
        { sig:'Time.fromIso8601ToString(iso, format)', desc:'Formats an ISO 8601 string with a custom format.',        ex:"Time.fromIso8601ToString(user.lastLogin, 'YYYY-MM-dd')" },
        { sig:'DateTime.now()',                        desc:'Identity Engine — returns a ZonedDateTime object for method chaining.', ex:"DateTime.now().toString('YYYY-MM-dd')" },
        { sig:'dateValue.withinDays(n)',               desc:'Identity Engine — true if the date is within n days of now.', ex:"user.created.parseStringTime().withinDays(30)" },
        { sig:'dateValue.plusDays(n)',                 desc:'Identity Engine — returns a new datetime n days in the future.', ex:"user.created.parseStringTime().plusDays(90).toString()" },
        { sig:'dateValue.parseStringTime()',           desc:'Identity Engine — parses an ISO string to a ZonedDateTime.', ex:"user.created.parseStringTime().withinDays(90)" },
      ],
    },
    {
      ns: 'Convert', color: '#6200cc',
      fns: [
        { sig:'Convert.toInt(value)',   desc:'Converts to integer.',       ex:"Convert.toInt(user.employeeNumber)" },
        { sig:'Convert.toNum(value)',   desc:'Converts to decimal number.', ex:"Convert.toNum('3.14')" },
        { sig:'Convert.toString(value)',desc:'Converts to string.',         ex:"Convert.toString(user.id)" },
      ],
    },
    {
      ns: 'Iso3166Convert', color: '#d50000',
      fns: [
        { sig:'Iso3166Convert.toAlpha2(value)',  desc:'Converts country code/name to 2-letter ISO code (e.g. "US").',   ex:"Iso3166Convert.toAlpha2(user.countryCode)" },
        { sig:'Iso3166Convert.toAlpha3(value)',  desc:'Converts to 3-letter ISO code (e.g. "USA").',                    ex:"Iso3166Convert.toAlpha3(user.countryCode)" },
        { sig:'Iso3166Convert.toNumeric(value)', desc:'Converts to numeric ISO code (e.g. "840").',                     ex:"Iso3166Convert.toNumeric('US')" },
        { sig:'Iso3166Convert.toName(value)',    desc:'Converts to country name (e.g. "United States").',               ex:"Iso3166Convert.toName(user.countryCode)" },
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
        { sig:'getFilteredGroups(allowList, expression, limit)', desc:'Returns groups from the allowList that the user belongs to.', ex:"getFilteredGroups(['00g1','00g2'], 'group.name', 10)" },
        { sig:"user.getGroups({'group.type': {'OKTA_GROUP'}})", desc:"Returns user's groups matching a criteria map.", ex:"user.getGroups({'group.type': {'OKTA_GROUP'}})" },
        { sig:"user.isMemberOf({'group.profile.name': 'name', 'operator': 'EXACT'})", desc:'Identity Engine — checks membership with a criteria object. Operators: EXACT, STARTS_WITH.', ex:"user.isMemberOf({'group.profile.name': 'Engineering'})" },
        { sig:'user.getInternalProperty(name)',               desc:"Returns an internal Okta user property ('id', 'status', 'created', etc.).", ex:"user.getInternalProperty('status')" },
        { sig:"Groups.contains(app, pattern, limit)",         desc:'Returns groups from the app whose name contains pattern.', ex:"Groups.contains('OKTA', 'Eng', 10)" },
        { sig:"Groups.startsWith(app, pattern, limit)",       desc:'Returns groups from the app whose name starts with pattern.', ex:"Groups.startsWith('OKTA', 'IT_', 10)" },
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
        { sig:'user.getLinkedObject(primaryName)',                    desc:'Returns the linked user object for a relationship.', ex:"user.getLinkedObject('manager').email" },
      ],
    },
    {
      ns: 'Organization', color: '#546be7',
      fns: [
        { sig:'org.name',      desc:'The name of the Okta organization.',      ex:"org.name" },
        { sig:'org.subDomain', desc:'The subdomain of the Okta organization. Useful for building org-specific URLs or routing logic.', ex:"org.subDomain" },
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
    { ctx:'profile_mapping', tag:'Time',    name:'Hire date → ISO 8601',       desc:'Normalizes the hireDate string from an HR system to ISO 8601.',        expr:"Time.fromStringToIso8601(user.hireDate)" },
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
    { ctx:'group_rules', tag:'Status',    name:'Active employees',          desc:'Matches active users who are employees (not contractors).',           expr:"user.status == 'ACTIVE' AND user.workerType == 'Employee'" },
    { ctx:'group_rules', tag:'Location',  name:'US-based users',            desc:'Matches active users in the United States.',                          expr:"user.countryCode == 'US' AND user.status == 'ACTIVE'" },
    { ctx:'group_rules', tag:'Type',      name:'Contractors and vendors',   desc:'Matches users whose type is Contractor or Vendor.',                   expr:"user.workerType == 'Contractor' OR user.workerType == 'Vendor'" },
    { ctx:'group_rules', tag:'Title',     name:'Senior staff by title',     desc:'Matches Senior, Director, or VP title keywords.',                     expr:"String.stringContains(user.title, 'Senior') OR String.stringContains(user.title, 'Director') OR String.stringContains(user.title, 'VP')" },
    { ctx:'group_rules', tag:'Dept',      name:'Multi-department team',     desc:'Matches Engineering, IT, or DevOps.',                                 expr:"user.department == 'Engineering' OR user.department == 'IT' OR user.department == 'DevOps'" },
    { ctx:'group_rules', tag:'Cost',      name:'Cost center prefix',        desc:'Matches users whose cost center starts with ENG.',                    expr:"String.stringContains(user.costCenter, 'ENG')" },
    { ctx:'group_rules', tag:'Manager',   name:'Has a manager',             desc:'Matches users who have a managerId assigned.',                         expr:"user.managerId != null" },
    { ctx:'group_rules', tag:'AD Group',  name:'AD-synced group by name',   desc:'AD groups synced to Okta appear as Okta groups — check by name.',    expr:"isMemberOfGroupName('Domain Admins')" },
    { ctx:'group_rules', tag:'AD Group',  name:'Group name prefix match',   desc:'Matches users in any group whose name starts with a prefix.',          expr:"isMemberOfGroupNameStartsWith('IT_')" },
    { ctx:'group_rules', tag:'AD Group',  name:'Group name contains',       desc:'Matches users in any group whose name contains a substring.',          expr:"isMemberOfGroupNameContains('Admin')" },
    { ctx:'group_rules', tag:'Combined',  name:'Dept + active + country',   desc:'Combines multiple criteria with AND.',                                 expr:"user.department == 'Engineering' AND user.status == 'ACTIVE' AND user.countryCode == 'US'" },
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
    if (typeof v==='object')     return `<span class="r-obj">${esc(JSON.stringify(v,null,2))}</span>`;
    return `<span class="r-str">"${esc(String(v))}"</span>`;
  }

  function getWarnings(expr, ctxId) {
    if (!expr || !ctxId) return [];
    const ctx = CONTEXTS.find(c => c.id === ctxId);
    if (!ctx) return [];
    return ctx.restrictions
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
          <div class="ref-fn" data-insert="${esc(fn.ex)}">
            <code class="ref-sig">${esc(fn.sig)}</code>
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
  function buildChips(varName) {
    const obj = state.profile[varName] || {};
    const entries = Object.entries(obj).filter(([, v]) => typeof v !== 'function');
    if (!entries.length) {
      return `<div class="attr-empty">No attributes for <code>${esc(varName)}</code></div>`;
    }
    return entries.map(([k, v]) => {
      const raw = v === null || v === undefined ? 'null'
                : Array.isArray(v)              ? `[${v.length} items]`
                : typeof v === 'boolean'        ? String(v)
                : String(v);
      const display = raw.length > 40 ? raw.substring(0, 40) + '…' : raw;
      return `<button class="attr-row" data-insert="${esc(varName)}.${esc(k)}">
        <span class="attr-key">${esc(k)}</span>
        <span class="attr-val">${esc(display)}</span>
      </button>`;
    }).join('');
  }

  // Which var-tab buttons to show depends on the active context's `vars` list
  function buildVarTabs() {
    const ctx = CONTEXTS.find(c => c.id === state.ctx) || CONTEXTS[0];
    const available = ctx.vars || ['user'];
    // Only show the tabs for vars that exist in the current context
    const ALL_VARS = ['user', 'appuser', 'idpuser', 'org', 'app', 'access'];
    return ALL_VARS.filter(v => available.includes(v)).map(v =>
      `<button class="var-tab${state.chipVar === v ? ' var-tab-on' : ''}" data-var="${v}">${v}</button>`
    ).join('');
  }

  function buildFnOptions() {
    return FUNCTION_REFERENCE.map(ns =>
      `<optgroup label="${esc(ns.ns)}">${
        ns.fns.map(fn => `<option value="${esc(fn.ex)}" title="${esc(fn.sig)}">${esc(fn.sig.split('(')[0])}</option>`).join('')
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
      </div>

      <!-- Expression editor -->
      <div class="section expr-section">
        <div class="section-hd">
          <span class="section-title">Expression</span>
          <div class="spacer"></div>
          <button id="btn-copy"  class="btn-sm">Copy</button>
          <button id="btn-clear" class="btn-sm btn-ghost">Clear</button>
        </div>
        <textarea id="expr-input" class="expr-ta" spellcheck="false" autocomplete="off"
          placeholder="Enter an OEL expression…&#10;e.g.  String.substringBefore(user.email, '@')"
        >${esc(state.expr)}</textarea>
      </div>

      <!-- Result -->
      <div class="section result-section">
        <div class="section-hd">
          <span class="section-title">Result</span>
          <div class="spacer"></div>
          <span id="result-badge" class="badge"></span>
        </div>
        <div id="result-box" class="result-box">
          <span class="placeholder">Type an expression above to evaluate it…</span>
        </div>
        <div id="warnings-box" class="warnings-box hidden"></div>
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

    // Context warnings
    const ws = getWarnings(expr, state.ctx);
    if (warn) {
      if (ws.length) {
        warn.innerHTML = ws.map(w => `<div class="warn-item">⚠ ${esc(w)}</div>`).join('');
        warn.classList.remove('hidden');
      } else {
        warn.innerHTML = ''; warn.classList.add('hidden');
      }
    }
  }

  const scheduleEval = () => { clearTimeout(state.evalTimer); state.evalTimer = setTimeout(runEval, 180); };

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
    scheduleEval();
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

  async function fetchUsers(q) {
    const r = await fetch(`/api/v1/users?limit=10&q=${encodeURIComponent(q)}`, {
      credentials:'include', headers:{'Accept':'application/json'},
    });
    if (r.status===401||r.status===403) throw new Error('Not authorised — make sure you are signed in to the Okta Admin Console.');
    if (!r.ok) throw new Error(`Okta API ${r.status}: ${r.statusText}`);
    return r.json();
  }

  async function fetchUserGroups(uid) {
    const r = await fetch(`/api/v1/users/${uid}/groups?limit=200`, {
      credentials:'include', headers:{'Accept':'application/json'},
    });
    if (!r.ok) throw new Error(`Groups fetch error: ${r.status}`);
    return r.json();
  }

  async function fetchOrgInfo() {
    try {
      const r = await fetch('/api/v1/org', {
        credentials:'include', headers:{'Accept':'application/json'},
      });
      if (!r.ok) return;
      const data = await r.json();
      // Update the org context in the active profile with real values
      const org = {
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

      // ── appuser: derived from the real profile.
      // When AD is the source, attribute names differ (mail vs email, sn vs lastName, etc.).
      // We derive as much as possible; AD-only fields we can't fetch are kept as mock.
      const realAppuser = {
        // Base Okta profile attributes
        ...rp,
        // LDAP / AD attribute names derived from Okta profile
        sAMAccountName:    rp.samAccountName
                           || rp.login?.split('@')[0]
                           || rp.email?.split('@')[0],
        userPrincipalName: rp.userPrincipalName || rp.login || rp.email,
        mail:              rp.email,
        mailNickname:      rp.login?.split('@')[0] || rp.email?.split('@')[0],
        givenName:         rp.firstName,
        sn:                rp.lastName,
        cn:                [rp.firstName, rp.lastName].filter(Boolean).join(' '),
        displayName:       rp.displayName
                           || [rp.lastName, rp.firstName].filter(Boolean).join(', '),
        department:        rp.department,
        title:             rp.title,
        company:           rp.organization,
        telephoneNumber:   rp.primaryPhone,
        mobile:            rp.mobilePhone,
        streetAddress:     rp.streetAddress,
        l:                 rp.city,
        st:                rp.state,
        postalCode:        rp.zipCode,
        c:                 rp.countryCode,
        employeeID:        rp.employeeNumber,
        employeeType:      rp.userType || rp.workerType,
        // Copy any extensionAttributes the user may have on their Okta profile
        extensionAttribute1:  rp.extensionAttribute1  ?? DEFAULT_PROFILE.appuser.extensionAttribute1,
        extensionAttribute2:  rp.extensionAttribute2  ?? null,
        // memberOf cannot be fetched without an AD lookup — keep mock but note it
        memberOf: DEFAULT_PROFILE.appuser.memberOf,
      };

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
        app:      DEFAULT_PROFILE.app,
        access:   DEFAULT_PROFILE.access,
        // Use org info already populated by fetchOrgInfo (real name + subdomain)
        org: state.profile.org,
        groups:   groups.map(g => g.profile.name),
        groupIds: groups.map(g => g.id),
        session:  DEFAULT_PROFILE.session,
        security: DEFAULT_PROFILE.security,
        device:   DEFAULT_PROFILE.device,
      };

      state.selectedUser = u;
      state.evaluator    = new OELEvaluator(state.profile);

      // Rebuild the user controls section
      rebuildUserControls();
      closeUserSearch();
      refreshChips();
      scheduleEval();
    } catch (e) {
      const errEl = document.getElementById('user-api-err');
      if (errEl) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
    } finally {
      if (sp) sp.classList.add('hidden');
    }
  }

  function clearSelectedUser() {
    state.selectedUser = null;
    state.profile      = DEFAULT_PROFILE;
    state.evaluator    = new OELEvaluator(DEFAULT_PROFILE);
    rebuildUserControls();
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

  // ── Insert helpers ────────────────────────────────────────────
  function insertAt(text) {
    const ta = document.getElementById('expr-input'); if (!ta) return;
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    ta.focus(); scheduleEval();
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

    // User search
    document.getElementById('user-search-btn')?.addEventListener('click', openUserSearch);
    document.getElementById('user-cancel')?.addEventListener('click',     closeUserSearch);
    document.getElementById('user-query')?.addEventListener('input', e => scheduleSearch(e.target.value.trim()));
    document.getElementById('user-results')?.addEventListener('click', e => {
      const btn = e.target.closest('.user-result');
      if (btn) { try { selectUser(JSON.parse(btn.dataset.u)); } catch {} }
    });
    // user-change is added dynamically in rebuildUserControls

    // Expression
    const ta = document.getElementById('expr-input');
    if (ta) {
      ta.addEventListener('input', scheduleEval);
      ta.addEventListener('keydown', e => { if (e.key==='Tab') { e.preventDefault(); insertAt('  '); } });
    }

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
      const ta = document.getElementById('expr-input'); if(ta){ta.value='';scheduleEval();}
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
        if (ta) { ta.value = item.dataset.expr; scheduleEval(); }
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
    startSessionPolling();
  }

  init();

})();
