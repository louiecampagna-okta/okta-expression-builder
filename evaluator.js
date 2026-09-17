/**
 * Okta Expression Language (OEL) Evaluator
 *
 * No eval() or new Function() — safe under strict CSPs.
 * Implements a hand-written lexer → parser → tree-walker covering:
 *
 *   Classic OEL  — String.*, Arrays.*, Time.*, Convert.*, Iso3166Convert.*
 *   Identity Engine style — method chaining on strings/arrays/datetimes
 *   Group functions — isMemberOfGroupName* variants, getFilteredGroups, Groups.*
 *   Directory — findDirectoryUser, hasDirectoryUser, findWorkdayUser, hasWorkdayUser
 *   Manager   — getManagerUser, getManagerAppUser, getAssistantUser, getAssistantAppUser
 *   SpEL      — ternary, Elvis ?:, null-coalescing ??, AND/OR, array index [n],
 *               collection projection .![expr]
 */

(function (global) {
  'use strict';

  // ═══════════════════════════════════════════════════════════════
  //  DATETIME WRAPPER  (supports Identity Engine method chaining)
  // ═══════════════════════════════════════════════════════════════

  function pad(n, len = 2) { return String(n).padStart(len, '0'); }

  const DEFAULT_DATE_FORMAT = "yyyy-MM-dd'T'HH:mm:ss.SSSZ";

  // Calendar parts for an instant, read either in UTC or in a named IANA zone.
  // Okta's `.toZone(zoneId)` shifts the wall-clock reading rather than the
  // instant, so every formatter goes through here instead of the UTC getters.
  function zonedParts(d, zone) {
    if (!zone) {
      return { year:d.getUTCFullYear(), month:d.getUTCMonth()+1, day:d.getUTCDate(),
               hour:d.getUTCHours(), minute:d.getUTCMinutes(), second:d.getUTCSeconds(),
               ms:d.getUTCMilliseconds(), offset:'Z' };
    }
    const parts = {};
    for (const p of new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year:'numeric', month:'2-digit', day:'2-digit',
      hour:'2-digit', minute:'2-digit', second:'2-digit',
      timeZoneName:'longOffset',
    }).formatToParts(d)) parts[p.type] = p.value;
    // longOffset renders as "GMT+09:00", or bare "GMT" at zero offset.
    const off = (parts.timeZoneName || '').replace(/^GMT/, '') || 'Z';
    return { year:+parts.year, month:+parts.month, day:+parts.day,
             hour:+parts.hour, minute:+parts.minute, second:+parts.second,
             ms:d.getUTCMilliseconds(), offset:off };
  }

  // Ordered longest-first within each casing so no token is shadowed.
  const DATE_TOKENS = [
    ['yyyy', p => p.year],        ['YYYY', p => p.year],
    ['SSS',  p => pad(p.ms, 3)],
    ['MM',   p => pad(p.month)],  ['dd',   p => pad(p.day)],
    ['HH',   p => pad(p.hour)],   ['mm',   p => pad(p.minute)],
    ['ss',   p => pad(p.second)], ['Z',    p => p.offset],
  ];

  // Joda-style pattern formatter, which is what Okta's Time.* format params
  // take. Text inside single quotes is a literal, so `yyyy-MM-dd'T'HH:mm:ss`
  // renders a bare T rather than treating it as a token; '' is an escaped quote.
  function formatDate(d, fmt, zone) {
    const p   = zonedParts(d, zone);
    const src = fmt || DEFAULT_DATE_FORMAT;
    let out = '';
    for (let i = 0; i < src.length; ) {
      if (src[i] === "'") {
        const end = src.indexOf("'", i + 1);
        if (end < 0) { out += src.slice(i + 1); break; }
        out += end === i + 1 ? "'" : src.slice(i + 1, end);
        i = end + 1;
        continue;
      }
      const tok = DATE_TOKENS.find(([t]) => src.startsWith(t, i));
      if (tok) { out += tok[1](p); i += tok[0].length; }
      else     { out += src[i]; i++; }
    }
    return out;
  }

  // Throws on an unknown zone so a typo surfaces as an expression error rather
  // than silently formatting in UTC.
  function assertZone(zoneId) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: String(zoneId) }); }
    catch { throw new Error(`unknown time zone '${zoneId}'`); }
    return String(zoneId);
  }

  class OELDateTime {
    constructor(date, zone = null) {
      this._d = date instanceof Date ? new Date(date) : new Date(date);
      this._zone = zone;
      // Lets content.js render this as a timestamp instead of dumping the
      // object shape through JSON.stringify.
      this._isOELDateTime = true;
    }
    // Formatting. `fmt` carries an explicit default so Function.length reports 0
    // — chain-method arity falls back to JS length, which would otherwise make
    // the documented bare `.toString()` an arity error.
    toString(fmt = undefined) {
      if (fmt)         return formatDate(this._d, fmt, this._zone);
      if (this._zone)  return formatDate(this._d, DEFAULT_DATE_FORMAT, this._zone);
      return this._d.toISOString();
    }
    toUnix()          { return String(Math.floor(this._d.getTime() / 1000)); }
    toWindows()       { return String((this._d.getTime() + 11644473600000) * 10000); }
    // Shifts the wall-clock reading; the underlying instant is unchanged.
    toZone(zoneId)    { return zoneId == null ? this : new OELDateTime(this._d, assertZone(zoneId)); }
    // Arithmetic — the zone rides along so `.toZone(z).plusDays(1)` stays in z.
    plusDays(n)       { const d = new Date(this._d); d.setUTCDate(d.getUTCDate() + n);       return new OELDateTime(d, this._zone); }
    plusHours(n)      { const d = new Date(this._d); d.setUTCHours(d.getUTCHours() + n);     return new OELDateTime(d, this._zone); }
    plusMinutes(n)    { const d = new Date(this._d); d.setUTCMinutes(d.getUTCMinutes() + n); return new OELDateTime(d, this._zone); }
    plusSeconds(n)    { const d = new Date(this._d); d.setUTCSeconds(d.getUTCSeconds() + n); return new OELDateTime(d, this._zone); }
    minusDays(n)      { return this.plusDays(-n); }
    minusHours(n)     { return this.plusHours(-n); }
    minusMinutes(n)   { return this.plusMinutes(-n); }
    minusSeconds(n)   { return this.plusSeconds(-n); }
    // Comparisons (is the timestamp within N units of NOW?)
    withinDays(n)     { return Math.abs(Date.now() - this._d.getTime()) < n * 86400000; }
    withinHours(n)    { return Math.abs(Date.now() - this._d.getTime()) < n * 3600000; }
    withinMinutes(n)  { return Math.abs(Date.now() - this._d.getTime()) < n * 60000; }
    withinSeconds(n)  { return Math.abs(Date.now() - this._d.getTime()) < n * 1000; }
    // Parsing aliases (so string.parseStringTime() works via method fallback)
    static fromIso(s)     { return new OELDateTime(new Date(String(s))); }
    static fromUnix(s)    { return new OELDateTime(new Date(Number(s) * 1000)); }
    static fromWindows(s) { return new OELDateTime(new Date((Number(s) / 10000) - 11644473600000)); }
    static fromString(s, fmt) { return fmt ? parseWithFormat(s, fmt) : OELDateTime.fromIso(s); }
  }

  // Joda parse tokens → [regex fragment, target field].
  const PARSE_TOKENS = [
    ['yyyy', 'year',   '(\\d{4})'],   ['YYYY', 'year',   '(\\d{4})'],
    ['SSS',  'ms',     '(\\d{1,3})'],
    ['MM',   'month',  '(\\d{1,2})'], ['dd',   'day',    '(\\d{1,2})'],
    ['HH',   'hour',   '(\\d{1,2})'], ['mm',   'minute', '(\\d{1,2})'],
    ['ss',   'second', '(\\d{1,2})'],
  ];

  const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Reads a timestamp positionally against a Joda pattern. Without this, a
  // format argument is ignored and `'01/02/2024'.parseStringTime('MM/dd/yyyy')`
  // falls through to Date's loose parsing and quietly returns the wrong day.
  // Returns null when the input doesn't match the pattern.
  function parseWithFormat(s, fmt) {
    if (s == null) return null;
    const src = String(fmt);
    const fields = [];
    let re = '';
    for (let i = 0; i < src.length; ) {
      if (src[i] === "'") {
        const end = src.indexOf("'", i + 1);
        const lit = end < 0 ? src.slice(i + 1) : (end === i + 1 ? "'" : src.slice(i + 1, end));
        re += reEscape(lit);
        i = end < 0 ? src.length : end + 1;
        continue;
      }
      const tok = PARSE_TOKENS.find(([t]) => src.startsWith(t, i));
      if (tok) { re += tok[2]; fields.push(tok[1]); i += tok[0].length; }
      else     { re += reEscape(src[i]); i++; }
    }
    const m = String(s).match(new RegExp('^' + re + '$'));
    if (!m) return null;
    const v = { year:1970, month:1, day:1, hour:0, minute:0, second:0, ms:0 };
    fields.forEach((f, idx) => { v[f] = Number(m[idx + 1]); });
    return new OELDateTime(new Date(Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second, v.ms)));
  }

  // ═══════════════════════════════════════════════════════════════
  //  TOKEN TYPES
  // ═══════════════════════════════════════════════════════════════

  const T = Object.freeze({
    IDENT:'IDENT', STRING:'STRING', NUMBER:'NUMBER', BOOL:'BOOL', NULL:'NULL',
    DOT:'DOT', COMMA:'COMMA', LPAREN:'LPAREN', RPAREN:'RPAREN',
    LBRACKET:'LBRACKET', RBRACKET:'RBRACKET',
    QUESTION:'QUESTION', COLON:'COLON', ELVIS:'ELVIS',
    PLUS:'PLUS', MINUS:'MINUS', STAR:'STAR', SLASH:'SLASH', PERCENT:'PERCENT',
    EQ:'EQ', NEQ:'NEQ', LT:'LT', GT:'GT', LTE:'LTE', GTE:'GTE',
    AND:'AND', OR:'OR', BANG:'BANG', MATCHES:'MATCHES',
    LBRACE:'LBRACE', RBRACE:'RBRACE',
    EOF:'EOF',
  });

  // ═══════════════════════════════════════════════════════════════
  //  LEXER
  // ═══════════════════════════════════════════════════════════════

  class Lexer {
    constructor(src) { this.src = src; this.pos = 0; this.result = []; }
    err(msg)   { throw new Error(`Lexer error at ${this.pos}: ${msg}`); }
    peek(o=0)  { return this.src[this.pos+o]; }
    at(o=0)    { return this.pos+o < this.src.length; }
    advance()  { return this.src[this.pos++]; }

    skipWs() { while (this.at() && /\s/.test(this.peek())) this.pos++; }

    readString(q) {
      this.pos++;
      let s = '';
      while (this.at() && this.peek() !== q) {
        if (this.peek() === '\\') {
          this.pos++;
          const e = this.advance();
          s += (e==='n'?'\n':e==='t'?'\t':e==='r'?'\r':e);
        } else { s += this.advance(); }
      }
      if (!this.at()) this.err('Unterminated string');
      this.pos++;
      this.result.push({ type: T.STRING, value: s });
    }

    readNumber() {
      const s = this.pos;
      while (this.at() && this.peek() >= '0' && this.peek() <= '9') this.pos++;
      if (this.at() && this.peek() === '.') {
        this.pos++;
        while (this.at() && this.peek() >= '0' && this.peek() <= '9') this.pos++;
      }
      this.result.push({ type: T.NUMBER, value: parseFloat(this.src.slice(s, this.pos)) });
    }

    readIdent() {
      const s = this.pos;
      while (this.at() && /[\w$]/.test(this.peek())) this.pos++;
      const w = this.src.slice(s, this.pos);
      // `matches` is a keyword only in operator position. Unlike AND/OR/not it's
      // a lowercase word that's entirely plausible as a profile attribute or a
      // group name key, so a bare rule would turn `user.matches` into a parse
      // error instead of a null read. A word straight after a '.' is a property.
      const afterDot = this.result.length && this.result[this.result.length-1].type === T.DOT;
      if      (w === 'true' || w === 'false') this.result.push({ type: T.BOOL, value: w === 'true' });
      else if (w === 'null')                  this.result.push({ type: T.NULL });
      else if (w === 'AND')                   this.result.push({ type: T.AND });
      else if (w === 'OR')                    this.result.push({ type: T.OR });
      else if (w === 'not')                   this.result.push({ type: T.BANG });
      else if (w === 'matches' && !afterDot)  this.result.push({ type: T.MATCHES });
      else                                    this.result.push({ type: T.IDENT, value: w });
    }

    tokenize() {
      while (this.pos < this.src.length) {
        this.skipWs();
        if (this.pos >= this.src.length) break;
        const ch = this.peek();
        if (ch==='"'||ch==="'") { this.readString(ch); continue; }
        if (ch>='0'&&ch<='9')   { this.readNumber();   continue; }
        if (ch==='_'||/[a-zA-Z]/.test(ch)) { this.readIdent(); continue; }
        this.pos++;
        switch (ch) {
          case '.': this.result.push({ type: T.DOT });      break;
          case ',': this.result.push({ type: T.COMMA });    break;
          case '(': this.result.push({ type: T.LPAREN });   break;
          case ')': this.result.push({ type: T.RPAREN });   break;
          case '[': this.result.push({ type: T.LBRACKET }); break;
          case ']': this.result.push({ type: T.RBRACKET }); break;
          case '{': this.result.push({ type: T.LBRACE });   break;
          case '}': this.result.push({ type: T.RBRACE });   break;
          case '+': this.result.push({ type: T.PLUS });     break;
          case '-': this.result.push({ type: T.MINUS });    break;
          case '*': this.result.push({ type: T.STAR });     break;
          case '/': this.result.push({ type: T.SLASH });    break;
          case '%': this.result.push({ type: T.PERCENT });  break;
          case ':': this.result.push({ type: T.COLON });    break;
          case '!': if (this.peek()==='='){this.pos++;this.result.push({type:T.NEQ});}else{this.result.push({type:T.BANG});} break;
          case '=': if (this.peek()==='='){this.pos++;this.result.push({type:T.EQ});}else this.err("Expected '=='"); break;
          case '<': if (this.peek()==='='){this.pos++;this.result.push({type:T.LTE});}else{this.result.push({type:T.LT});} break;
          case '>': if (this.peek()==='='){this.pos++;this.result.push({type:T.GTE});}else{this.result.push({type:T.GT});} break;
          case '&': if (this.peek()==='&'){this.pos++;this.result.push({type:T.AND});}else this.err("Expected '&&'"); break;
          case '|': if (this.peek()==='|'){this.pos++;this.result.push({type:T.OR}); }else this.err("Expected '||'"); break;
          case '?': if (this.peek()===':'||this.peek()==='?'){this.pos++;this.result.push({type:T.ELVIS});}else{this.result.push({type:T.QUESTION});} break;
          default: this.err(`Unexpected '${ch}'`);
        }
      }
      this.result.push({ type: T.EOF });
      return this.result;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  PARSER
  // ═══════════════════════════════════════════════════════════════

  class Parser {
    constructor(tokens) { this.tokens = tokens; this.pos = 0; }
    err(msg) { throw new Error(`Parse error: ${msg}`); }
    peek()   { return this.tokens[this.pos]; }
    peekAt(n){ return this.tokens[this.pos+n]; }
    is(...tt) { return tt.includes(this.tokens[this.pos].type); }
    consume() { return this.tokens[this.pos++]; }
    expect(t) {
      const tok = this.consume();
      if (tok.type !== t) this.err(`Expected ${t} but got ${tok.type}`);
      return tok;
    }
    parse() {
      const n = this.parseExpr();
      if (!this.is(T.EOF)) this.err(`Unexpected token after expression: ${this.peek().type}`);
      return n;
    }

    parseExpr()    { return this.parseTernary(); }
    parseTernary() {
      let l = this.parseElvis();
      if (this.is(T.QUESTION)) {
        this.consume();
        const c = this.parseElvis();
        this.expect(T.COLON);
        return { type:'Ternary', test:l, cons:c, alt:this.parseTernary() };
      }
      return l;
    }
    parseElvis() {
      let l = this.parseOr();
      while (this.is(T.ELVIS)) { this.consume(); l = { type:'Elvis', left:l, right:this.parseOr() }; }
      return l;
    }
    parseOr()  { let l=this.parseAnd(); while(this.is(T.OR)) {this.consume();l={type:'Binary',op:'||',left:l,right:this.parseAnd()};} return l; }
    parseAnd() { let l=this.parseEq();  while(this.is(T.AND)){this.consume();l={type:'Binary',op:'&&',left:l,right:this.parseEq()};} return l; }
    parseEq()  {
      let l = this.parseRel();
      while (this.is(T.EQ,T.NEQ)) {
        const op = this.consume().type===T.EQ?'==':'!=';
        l = { type:'Binary', op, left:l, right:this.parseRel() };
      }
      return l;
    }
    // `matches` sits here because that's SpEL's precedence for it: relational,
    // so `user.login matches '.*@acme.com' AND user.status == 'ACTIVE'` groups
    // the way an author reads it without parentheses.
    parseRel() {
      let l = this.parseAdd();
      const m = {[T.LT]:'<',[T.GT]:'>',[T.LTE]:'<=',[T.GTE]:'>=',[T.MATCHES]:'matches'};
      while (this.peek().type in m) { const op=m[this.consume().type]; l={type:'Binary',op,left:l,right:this.parseAdd()}; }
      return l;
    }
    parseAdd() {
      let l = this.parseMul();
      while (this.is(T.PLUS,T.MINUS)) { const op=this.consume().type===T.PLUS?'+':'-'; l={type:'Binary',op,left:l,right:this.parseMul()}; }
      return l;
    }
    parseMul() {
      let l = this.parseUnary();
      const m = {[T.STAR]:'*',[T.SLASH]:'/',[T.PERCENT]:'%'};
      while (this.peek().type in m) { const op=m[this.consume().type]; l={type:'Binary',op,left:l,right:this.parseUnary()}; }
      return l;
    }
    parseUnary() {
      if (this.is(T.BANG))  { this.consume(); return {type:'Unary',op:'!',operand:this.parseUnary()}; }
      if (this.is(T.MINUS)) { this.consume(); return {type:'Unary',op:'-',operand:this.parseUnary()}; }
      return this.parsePostfix();
    }
    parsePostfix() {
      let node = this.parsePrimary();
      while (true) {
        if (this.is(T.DOT)) {
          // Collection projection: .![expr]
          if (this.peekAt(1)?.type === T.BANG && this.peekAt(2)?.type === T.LBRACKET) {
            this.consume(); // .
            this.consume(); // !
            this.consume(); // [
            const expr = this.parseExpr();
            this.expect(T.RBRACKET);
            node = { type:'Projection', collection:node, expr };
          } else {
            this.consume(); // .
            const prop = this.expect(T.IDENT);
            if (this.is(T.LPAREN)) {
              this.consume();
              const args = this.parseArgs();
              this.expect(T.RPAREN);
              node = { type:'MethodCall', object:node, method:prop.value, args };
            } else {
              node = { type:'Member', object:node, prop:prop.value };
            }
          }
        } else if (this.is(T.LBRACKET)) {
          this.consume();
          const index = this.parseExpr();
          this.expect(T.RBRACKET);
          node = { type:'Index', object:node, index };
        } else { break; }
      }
      return node;
    }
    parsePrimary() {
      const t = this.peek();
      if (t.type===T.STRING) { this.consume(); return {type:'Literal',value:t.value}; }
      if (t.type===T.NUMBER) { this.consume(); return {type:'Literal',value:t.value}; }
      if (t.type===T.BOOL)   { this.consume(); return {type:'Literal',value:t.value}; }
      if (t.type===T.NULL)   { this.consume(); return {type:'Literal',value:null};    }
      if (t.type===T.IDENT)  {
        this.consume();
        if (this.is(T.LPAREN)) {
          this.consume();
          const args = this.parseArgs();
          this.expect(T.RPAREN);
          return {type:'Call', name:t.value, args};
        }
        return {type:'Ident', name:t.value};
      }
      if (t.type===T.LPAREN) { this.consume(); const n=this.parseExpr(); this.expect(T.RPAREN); return n; }
      if (t.type===T.LBRACKET) {
        this.consume();
        const elems=[];
        while (!this.is(T.RBRACKET,T.EOF)) { elems.push(this.parseExpr()); if(this.is(T.COMMA))this.consume(); }
        this.expect(T.RBRACKET);
        return {type:'ArrayLit', elems};
      }
      // Brace literal. SpEL spells an inline *list* `{a, b}` and an inline *map*
      // `{'k': v}` with the same delimiter, so which one this is only becomes
      // clear at the first colon. Both forms appear in Okta's docs — the allow
      // list in `getFilteredGroups({'00g…','00g…'}, 'group.name', 100)` is a
      // list, the criteria in `user.isMemberOf({'group.profile.name':'Eng'})`
      // is a map — so decide per entry rather than assuming.
      if (t.type===T.LBRACE) {
        this.consume();
        if (this.is(T.RBRACE)) { this.consume(); return {type:'ArrayLit', elems:[]}; }
        const pairs=[], elems=[];
        let isMap=null;
        while (!this.is(T.RBRACE,T.EOF)) {
          const keyTok = this.peek();
          // A map key is a string literal or bare identifier followed by ':'.
          const mapEntry = (keyTok.type===T.STRING||keyTok.type===T.IDENT)
                        && this.peekAt(1) && this.peekAt(1).type===T.COLON;
          if (isMap !== null && isMap !== mapEntry) {
            this.err("cannot mix 'key: value' pairs and plain values inside {}");
          }
          isMap = mapEntry;
          if (mapEntry) {
            this.consume(); this.consume();          // key, colon
            pairs.push({key: keyTok.value, val: this.parseExpr()});
          } else {
            elems.push(this.parseExpr());
          }
          if (this.is(T.COMMA)) this.consume();
        }
        this.expect(T.RBRACE);
        return isMap ? {type:'ObjectLit', pairs} : {type:'ArrayLit', elems};
      }
      this.err(`Unexpected token '${t.type}'${t.value!==undefined?` ('${t.value}')`:''}`);
    }
    parseArgs() {
      const a=[];
      if (this.is(T.RPAREN)) return a;
      a.push(this.parseExpr());
      while (this.is(T.COMMA)) { this.consume(); a.push(this.parseExpr()); }
      return a;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  INTERPRETER
  // ═══════════════════════════════════════════════════════════════

  // ISO 3166 lookup. Module scope rather than inside the evaluator closure
  // because two callers need it: the `Iso3166Convert.*` namespace and the
  // `.parseCountryCode()` chain method in STRING_METHOD_ALIASES below. The
  // data is per-process constant, so there's nothing per-instance about it.
  const COUNTRY_DATA = {
    'US':{'alpha2':'US','alpha3':'USA','numeric':'840','name':'United States'},
    'GB':{'alpha2':'GB','alpha3':'GBR','numeric':'826','name':'United Kingdom'},
    'CA':{'alpha2':'CA','alpha3':'CAN','numeric':'124','name':'Canada'},
    'DE':{'alpha2':'DE','alpha3':'DEU','numeric':'276','name':'Germany'},
    'FR':{'alpha2':'FR','alpha3':'FRA','numeric':'250','name':'France'},
    'AU':{'alpha2':'AU','alpha3':'AUS','numeric':'036','name':'Australia'},
    'JP':{'alpha2':'JP','alpha3':'JPN','numeric':'392','name':'Japan'},
    'IN':{'alpha2':'IN','alpha3':'IND','numeric':'356','name':'India'},
    'United States':{'alpha2':'US','alpha3':'USA','numeric':'840','name':'United States'},
    'United Kingdom':{'alpha2':'GB','alpha3':'GBR','numeric':'826','name':'United Kingdom'},
  };
  // `own()` rather than `COUNTRY_DATA[k]`: the key comes from a profile
  // attribute, and a plain index would walk Object.prototype — so
  // `Iso3166Convert.toName('constructor')` would find Object itself and
  // report the country name as 'Object' (functions carry a `.name`).
  const resolveCountry = (v) => {
    if (!v) return null;
    return own(COUNTRY_DATA, String(v).toUpperCase()) || own(COUNTRY_DATA, String(v)) || null;
  };

  // What `.parseCountryCode()` returns. A wrapper rather than a plain object so
  // the interpreter's prototype-aware dispatch treats it like OELDateTime — its
  // methods live on the prototype and are reached without the own-property
  // restriction that applies to namespace literals.
  class OELCountryCode {
    constructor(rec) { this._rec = rec; }
    get _isOELCountryCode() { return true; }
    toAlpha2()  { return this._rec ? this._rec.alpha2  : null; }
    toAlpha3()  { return this._rec ? this._rec.alpha3  : null; }
    toNumeric() { return this._rec ? this._rec.numeric : null; }
    toName()    { return this._rec ? this._rec.name    : null; }
    // An unrecognized code yields an object whose accessors all answer null,
    // matching how every other OEL lookup degrades. Rendering it needs
    // *something*, so fall back to the input.
    toString()  { return this._rec ? this._rec.alpha2 : null; }
  }

  // Segment-wise version compare, for `device.profile.osVersion` and
  // `device.provider.oktaVerify.version`. Returns -1/0/1. String comparison is
  // what these methods exist to avoid: '14.10' < '14.9' lexically but is the
  // later release. Missing segments count as 0, so '14' == '14.0.0'.
  const compareVersions = (a, b) => {
    const pa = String(a).split('.'), pb = String(b).split('.');
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = parseInt(pa[i], 10) || 0, nb = parseInt(pb[i], 10) || 0;
      if (na !== nb) return na < nb ? -1 : 1;
    }
    return 0;
  };

  // Identity Engine method-chaining style on string values (`user.email.
  // substringBefore('@')`). This is an allow list, not a fallback: it's the
  // complete set of methods callable on a string, so a native JS method that
  // isn't listed here is rejected rather than silently evaluated.
  // Deliberately absent: .trim(), .len(), .startsWith(), .endsWith() — none are
  // in Okta's reference. `String.len(str)` (namespace form) IS documented and
  // stays; only the chain alias is gone.
  const STRING_METHOD_ALIASES = {
    toUpperCase:     (s)     => String(s).toUpperCase(),
    toLowerCase:     (s)     => String(s).toLowerCase(),
    removeSpaces:    (s)     => String(s).replace(/\s+/g,''),
    length:          (s)     => String(s).length,
    contains:        (s,sub) => String(s).includes(String(sub)),
    substring:       (s,a,b=undefined) => b!=null ? String(s).substring(a,b) : String(s).substring(a),
    substringBefore: (s,d)   => { const i=String(s).indexOf(String(d)); return i<0?String(s):String(s).substring(0,i); },
    substringAfter:  (s,d)   => { const i=String(s).indexOf(String(d)); return i<0?'':String(s).substring(i+String(d).length); },
    replace:         (s,p,r) => String(s).replace(new RegExp(String(p),'g'),r??''),
    replaceFirst:    (s,p,r) => String(s).replace(new RegExp(String(p)),r??''),

    // Identity Engine conversion methods.
    toInteger:       (s)     => { const n = parseInt(String(s), 10);  return isNaN(n) ? null : n; },
    toNumber:        (s)     => { const n = parseFloat(String(s));    return isNaN(n) ? null : n; },

    // Identity Engine time parse methods. `parseStringTime` reads ISO 8601 with
    // no argument and a Joda pattern with one — passing a format used to be
    // accepted and ignored, which let a non-ISO input fall through to Date's
    // loose parsing and come back as the wrong day.
    parseStringTime:   (s, fmt = undefined) => OELDateTime.fromString(s, fmt),
    parseUnixTime:     (s)   => OELDateTime.fromUnix(s),
    parseWindowsTime:  (s)   => OELDateTime.fromWindows(s),

    // Country conversion. Returns a chainable CountryCode object, so the
    // documented form is `user.countryCode.parseCountryCode().toName()`.
    parseCountryCode:  (s)   => new OELCountryCode(resolveCountry(s)),

    // Version comparison. These are documented on the device version strings
    // specifically, but they're string methods — nothing restricts the receiver.
    versionGreaterThan: (s, other) => compareVersions(s, other) > 0,
    versionLessThan:    (s, other) => compareVersions(s, other) < 0,
  };

  // Methods documented on numeric values. A number-typed profile attribute
  // needs its own table for the same reason strings do: Number.prototype
  // carries .toFixed/.toPrecision/.toString, which would otherwise evaluate
  // here as though they were OEL.
  const NUMBER_METHOD_ALIASES = {
    toInteger:        (n) => Math.trunc(Number(n)),
    toNumber:         (n) => Number(n),
    parseUnixTime:    (n) => OELDateTime.fromUnix(n),
    parseWindowsTime: (n) => OELDateTime.fromWindows(n),
  };

  // Array method aliases
  const ARRAY_METHOD_ALIASES = {
    contains: (a,el) => Array.isArray(a) && a.includes(el),
    size:     (a)    => Array.isArray(a) ? a.length : 0,
    isEmpty:  (a)    => !a || (Array.isArray(a) && a.length===0),
    add:      (a,el) => Array.isArray(a) ? [...a,el] : [el],
    remove:   (a,el) => Array.isArray(a) ? a.filter(e=>e!==el) : [],
    flatten:  (a)    => Array.isArray(a) ? a.flat(Infinity) : [],
  };

  // Types for argument validation. `any` skips the check (rare — most params
  // have known shapes). `integer` is checked separately from `number` because
  // many OEL functions specifically want an integer limit/index/count.
  // CSVARR exists because Okta documents that "CSV strings may be supplied as
  // input to all Arrays* functions" — so those params accept an array or a
  // comma-separated string, and nothing else. Typing them AT.ANY would accept
  // an integer too and lose the error message.
  const AT = { STR:'string', INT:'integer', NUM:'number', BOOL:'boolean', ARR:'array',
               CSVARR:'array or CSV string', OBJ:'object', ANY:'any' };

  // Specs for every namespaced OEL function + the top-level ones we ship.
  // Keyed by full name (e.g. "Groups.startsWith"). The interpreter uses this
  // to enforce arity AND arg types, and produces error messages that include
  // the full signature so users understand what's expected.
  //
  // Params notation: `n` = name, `t` = type, `optional` = truthy if optional.
  // Rest params are marked via `rest: true` — any additional args past the
  // last declared param are accepted (and optionally typed via the last param).
  const OEL_SPECS = {
    // ── String namespace ─────────────────────────────────────────────────
    'String.len':             { sig:'String.len(str)',                          params:[{n:'str',t:AT.STR}] },
    'String.append':          { sig:'String.append(str, suffix)',               params:[{n:'str',t:AT.STR},{n:'suffix',t:AT.STR}] },
    'String.join':            { sig:'String.join(sep, str1[, str2, ...])',      params:[{n:'sep',t:AT.STR},{n:'str',t:AT.ANY}], rest:true },
    'String.toUpperCase':     { sig:'String.toUpperCase(str)',                  params:[{n:'str',t:AT.STR}] },
    'String.toLowerCase':     { sig:'String.toLowerCase(str)',                  params:[{n:'str',t:AT.STR}] },
    // Classic documents the namespace form with all three args. The 1- and
    // 2-arg overloads live on the *method* form (`user.email.substring(4)`),
    // which Identity Engine documents separately and specs don't cover.
    'String.substring':       { sig:'String.substring(input, startIndex, endIndex)', params:[{n:'input',t:AT.STR},{n:'startIndex',t:AT.INT},{n:'endIndex',t:AT.INT}] },
    'String.substringBefore': { sig:'String.substringBefore(str, delimiter)',   params:[{n:'str',t:AT.STR},{n:'delimiter',t:AT.STR}] },
    'String.substringAfter':  { sig:'String.substringAfter(str, delimiter)',    params:[{n:'str',t:AT.STR},{n:'delimiter',t:AT.STR}] },
    'String.replace':         { sig:'String.replace(str, pattern, replacement)',params:[{n:'str',t:AT.STR},{n:'pattern',t:AT.STR},{n:'replacement',t:AT.STR}] },
    'String.replaceFirst':    { sig:'String.replaceFirst(str, pattern, replacement)',params:[{n:'str',t:AT.STR},{n:'pattern',t:AT.STR},{n:'replacement',t:AT.STR}] },
    'String.stringContains':  { sig:'String.stringContains(str, substring)',    params:[{n:'str',t:AT.STR},{n:'substring',t:AT.STR}] },
    'String.startsWith':      { sig:'String.startsWith(str, prefix)',           params:[{n:'str',t:AT.STR},{n:'prefix',t:AT.STR}] },
    'String.removeSpaces':    { sig:'String.removeSpaces(str)',                 params:[{n:'str',t:AT.STR}] },
    'String.stringSwitch':    { sig:'String.stringSwitch(input, default, k1, v1[, k2, v2, ...])',
                                params:[{n:'input',t:AT.ANY},{n:'default',t:AT.ANY},{n:'key',t:AT.ANY},{n:'value',t:AT.ANY}], rest:true },
    // Deliberately absent: String.trim and String.toString. Neither appears in
    // Okta's reference. Use String.removeSpaces or Convert.toInt/toNum instead.

    // ── Arrays namespace ─────────────────────────────────────────────────
    // Every `array` param is CSVARR: the docs allow a CSV string anywhere an
    // array is expected, and the impls coerce at the boundary.
    'Arrays.contains':     { sig:'Arrays.contains(array, element)',   params:[{n:'array',t:AT.CSVARR},{n:'element',t:AT.ANY}] },
    'Arrays.size':         { sig:'Arrays.size(array)',                params:[{n:'array',t:AT.CSVARR}] },
    'Arrays.isEmpty':      { sig:'Arrays.isEmpty(array)',             params:[{n:'array',t:AT.CSVARR}] },
    'Arrays.add':          { sig:'Arrays.add(array, element)',        params:[{n:'array',t:AT.CSVARR},{n:'element',t:AT.ANY}] },
    'Arrays.remove':       { sig:'Arrays.remove(array, element)',     params:[{n:'array',t:AT.CSVARR},{n:'element',t:AT.ANY}] },
    'Arrays.get':          { sig:'Arrays.get(array, index)',          params:[{n:'array',t:AT.CSVARR},{n:'index',t:AT.INT}] },
    'Arrays.clear':        { sig:'Arrays.clear(array)',                params:[{n:'array',t:AT.CSVARR}] },
    'Arrays.toCsvString':  { sig:'Arrays.toCsvString(array)',         params:[{n:'array',t:AT.CSVARR}] },
    'Arrays.flatten':      { sig:'Arrays.flatten(...values)',         params:[{n:'value',t:AT.ANY}], rest:true },

    // ── Time namespace ───────────────────────────────────────────────────
    'Time.now':                  { sig:'Time.now([tz[, format]])',                    params:[{n:'tz',t:AT.STR,optional:true},{n:'format',t:AT.STR,optional:true}] },
    'Time.fromUnixToIso8601':    { sig:'Time.fromUnixToIso8601(unix)',                params:[{n:'unix',t:AT.INT}] },
    'Time.fromIso8601ToUnix':    { sig:'Time.fromIso8601ToUnix(iso)',                 params:[{n:'iso',t:AT.STR}] },
    'Time.fromWindowsToIso8601': { sig:'Time.fromWindowsToIso8601(filetime)',         params:[{n:'filetime',t:AT.ANY}] },
    'Time.fromIso8601ToWindows': { sig:'Time.fromIso8601ToWindows(iso)',              params:[{n:'iso',t:AT.STR}] },
    'Time.fromStringToIso8601':  { sig:'Time.fromStringToIso8601(time, format)',       params:[{n:'time',t:AT.STR},{n:'format',t:AT.STR}] },
    'Time.fromIso8601ToString':  { sig:'Time.fromIso8601ToString(iso, format)',       params:[{n:'iso',t:AT.STR},{n:'format',t:AT.STR}] },

    // ── Convert namespace ────────────────────────────────────────────────
    'Convert.toInt':    { sig:'Convert.toInt(value)',    params:[{n:'value',t:AT.ANY}] },
    'Convert.toNum':    { sig:'Convert.toNum(value)',    params:[{n:'value',t:AT.ANY}] },
    // Deliberately absent: Convert.toString. Okta documents only toInt and toNum
    // on this namespace.

    // ── Iso3166Convert namespace ─────────────────────────────────────────
    'Iso3166Convert.toAlpha2':  { sig:'Iso3166Convert.toAlpha2(value)',  params:[{n:'value',t:AT.STR}] },
    'Iso3166Convert.toAlpha3':  { sig:'Iso3166Convert.toAlpha3(value)',  params:[{n:'value',t:AT.STR}] },
    'Iso3166Convert.toNumeric': { sig:'Iso3166Convert.toNumeric(value)', params:[{n:'value',t:AT.STR}] },
    'Iso3166Convert.toName':    { sig:'Iso3166Convert.toName(value)',    params:[{n:'value',t:AT.STR}] },

    // ── Groups namespace ─────────────────────────────────────────────────
    'Groups.contains':   { sig:'Groups.contains(app, pattern, limit)',   params:[{n:'app',t:AT.ANY},{n:'pattern',t:AT.STR},{n:'limit',t:AT.INT}] },
    'Groups.startsWith': { sig:'Groups.startsWith(app, pattern, limit)', params:[{n:'app',t:AT.ANY},{n:'pattern',t:AT.STR},{n:'limit',t:AT.INT}] },
    'Groups.endsWith':   { sig:'Groups.endsWith(app, pattern, limit)',   params:[{n:'app',t:AT.ANY},{n:'pattern',t:AT.STR},{n:'limit',t:AT.INT}] },

    // ── DateTime namespace ───────────────────────────────────────────────
    'DateTime.now': { sig:'DateTime.now()', params:[] },

    // ── User-object methods ──────────────────────────────────────────────
    // Both take one or more criteria objects, ANDed. Specs exist so a bare
    // `user.isMemberOf()` reports the signature instead of silently returning
    // false — the variadic impls have a JS .length of 0, so the fallback
    // arity check can't catch it.
    'user.isMemberOf': { sig:"user.isMemberOf({'group.profile.name': 'Eng'}[, ...])",
                         params:[{n:'criteria',t:AT.ANY}], rest:true },
    // getGroups' criteria are optional — the bare form returns every group,
    // which is what the documented projection example relies on.
    'user.getGroups':  { sig:"user.getGroups([criteria, ...])",
                         params:[{n:'criteria',t:AT.ANY,optional:true}], rest:true },
    'user.getLinkedObject':     { sig:'user.getLinkedObject(primaryName)',
                                  params:[{n:'primaryName',t:AT.STR}] },
    'user.getInternalProperty': { sig:'user.getInternalProperty(name)',
                                  params:[{n:'name',t:AT.STR}] },

    // ── Top-level (Call) functions ───────────────────────────────────────
    'isMemberOfGroupName':           { sig:'isMemberOfGroupName(name)',           params:[{n:'name',t:AT.STR}] },
    'isMemberOfGroup':               { sig:'isMemberOfGroup(groupId)',            params:[{n:'groupId',t:AT.STR}] },
    'isMemberOfAnyGroup':            { sig:'isMemberOfAnyGroup(name1[, name2, ...])', params:[{n:'name',t:AT.STR}], rest:true },
    'isMemberOfGroupNameStartsWith': { sig:'isMemberOfGroupNameStartsWith(prefix)',params:[{n:'prefix',t:AT.STR}] },
    'isMemberOfGroupNameContains':   { sig:'isMemberOfGroupNameContains(substring)',params:[{n:'substring',t:AT.STR}] },
    'isMemberOfGroupNameRegex':      { sig:'isMemberOfGroupNameRegex(regex)',     params:[{n:'regex',t:AT.STR}] },
    'getFilteredGroups':             { sig:'getFilteredGroups(allowList, group_expression, limit)',
                                       params:[{n:'allowList',t:AT.ARR},{n:'group_expression',t:AT.STR},{n:'limit',t:AT.INT}] },
    'getManagerUser':                { sig:'getManagerUser(source)',              params:[{n:'source',t:AT.ANY}] },
    'getManagerAppUser':             { sig:'getManagerAppUser(source, attribute)',params:[{n:'source',t:AT.ANY},{n:'attribute',t:AT.STR}] },
    'getAssistantUser':              { sig:'getAssistantUser(source)',            params:[{n:'source',t:AT.ANY}] },
    'getAssistantAppUser':           { sig:'getAssistantAppUser(source, attribute)',params:[{n:'source',t:AT.ANY},{n:'attribute',t:AT.STR}] },
    'hasDirectoryUser':              { sig:'hasDirectoryUser()',                  params:[] },
    'findDirectoryUser':             { sig:'findDirectoryUser()',                 params:[] },
    'hasWorkdayUser':                { sig:'hasWorkdayUser()',                    params:[] },
    'findWorkdayUser':               { sig:'findWorkdayUser()',                   params:[] },

    // ── Deprecated, but documented ───────────────────────────────────────
    // Okta's reference still lists these five unqualified forms and its runtime
    // still accepts them, so a legacy expression pasted into the builder has to
    // evaluate rather than error. `deprecated` carries the replacement note
    // instead of a bare true: it's the text the Result tab shows, and having one
    // home for it keeps the message from drifting from the flag.
    'toUpperCase':     { sig:'toUpperCase(str)',              params:[{n:'str',t:AT.STR}],
                         deprecated:'toUpperCase(str) is deprecated — use String.toUpperCase(str)' },
    'toLowerCase':     { sig:'toLowerCase(str)',              params:[{n:'str',t:AT.STR}],
                         deprecated:'toLowerCase(str) is deprecated — use String.toLowerCase(str)' },
    'substring':       { sig:'substring(input, startIndex, endIndex)',
                         params:[{n:'input',t:AT.STR},{n:'startIndex',t:AT.INT},{n:'endIndex',t:AT.INT}],
                         deprecated:'substring(input, startIndex, endIndex) is deprecated — use String.substring(...)' },
    'substringBefore': { sig:'substringBefore(str, delimiter)', params:[{n:'str',t:AT.STR},{n:'delimiter',t:AT.STR}],
                         deprecated:'substringBefore(str, delimiter) is deprecated — use String.substringBefore(...)' },
    'substringAfter':  { sig:'substringAfter(str, delimiter)',  params:[{n:'str',t:AT.STR},{n:'delimiter',t:AT.STR}],
                         deprecated:'substringAfter(str, delimiter) is deprecated — use String.substringAfter(...)' },
  };

  // The `matches` operator has no OEL_SPECS entry — it's an operator, not a
  // call — so its note lives here beside the table it would otherwise sit in.
  const MATCHES_DEPRECATION =
    "the 'matches' operator is deprecated — use String.replace / String.replaceFirst, " +
    'or a regex-aware function, depending on what you need';

  // Deprecated constructs an expression uses, read off the AST rather than
  // observed during evaluation: `cond ? toUpperCase(a) : b` should be flagged
  // whichever branch actually runs. Returns a Set of note strings.
  function collectDeprecations(node, out = new Set()) {
    if (!node || typeof node !== 'object') return out;
    if (node.type === 'Call') {
      const spec = own(OEL_SPECS, node.name);
      if (spec && spec.deprecated) out.add(spec.deprecated);
    }
    if (node.type === 'Binary' && node.op === 'matches') out.add(MATCHES_DEPRECATION);
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(c => collectDeprecations(c, out));
      else if (v && typeof v === 'object' && typeof v.type === 'string') collectDeprecations(v, out);
    }
    return out;
  }

  // Own-property lookup. A bare `MAP[name]` walks the prototype chain, so
  // `OEL_SPECS['toString']` would resolve to Object.prototype.toString — truthy
  // but with no `.params` — and `STRING_METHOD_ALIASES['constructor']` would
  // resolve to a callable that isn't an OEL function at all. Every lookup keyed
  // by a user-supplied identifier has to go through this.
  const own = (map, key) => Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;

  // Method lookup for a non-primitive receiver, walking the prototype chain but
  // stopping short of Object.prototype. Both shapes the interpreter dispatches on
  // are covered by the one rule:
  //   · namespace object literals (String, Arrays, Time, …) hold their functions
  //     as own properties, so the loop finds them on the first pass
  //   · classes we define (OELDateTime, OELCountryCode) hold theirs on their own
  //     prototype, so the loop finds them on the second
  // Everything on Object.prototype is out of reach either way, which is the
  // point: `String.toString(x)` must report an unknown function rather than
  // answering "[object Object]", and `DateTime.now().hasOwnProperty('_d')` must
  // not evaluate at all.
  const findMethod = (obj, name) => {
    for (let o = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      const v = own(o, name);
      if (v !== undefined) return v;
    }
    return undefined;
  };

  // Type predicate. Nulls are always allowed (Okta's runtime treats null as a
  // valid value that expressions must handle themselves).
  function argMatchesType(v, t) {
    if (v === null || v === undefined) return true;
    if (t === AT.ANY)     return true;
    if (t === AT.STR)     return typeof v === 'string';
    if (t === AT.INT)     return typeof v === 'number' && Number.isInteger(v);
    if (t === AT.NUM)     return typeof v === 'number' && !Number.isNaN(v);
    if (t === AT.BOOL)    return typeof v === 'boolean';
    if (t === AT.ARR)     return Array.isArray(v);
    if (t === AT.CSVARR)  return Array.isArray(v) || typeof v === 'string';
    if (t === AT.OBJ)     return typeof v === 'object' && v !== null && !Array.isArray(v);
    return true;
  }
  function describeActualType(v) {
    if (v === null)              return 'null';
    if (v === undefined)         return 'undefined';
    if (Array.isArray(v))        return 'array';
    if (typeof v === 'number')   return Number.isInteger(v) ? 'integer' : 'number';
    return typeof v;
  }

  // Reject calls whose arg count or arg types don't match the OEL spec.
  // Falls back to the JS function's own .length for functions not in the
  // spec table (rare — mostly user-object methods like user.isMemberOf).
  function checkCall(fullName, fn, args) {
    const spec = own(OEL_SPECS, fullName);
    if (!spec) {
      const required = fn.length;
      if (args.length < required) {
        throw new Error(`'${fullName}' expected ${required} argument${required===1?'':'s'} but got ${args.length}`);
      }
      return;
    }
    const required = spec.params.filter(p => !p.optional).length;
    if (args.length < required) {
      throw new Error(`${spec.sig} — expected at least ${required} argument${required===1?'':'s'} but got ${args.length}`);
    }
    for (let i = 0; i < args.length; i++) {
      const p = spec.rest && i >= spec.params.length ? spec.params[spec.params.length - 1] : spec.params[i];
      if (!p) break;
      if (!argMatchesType(args[i], p.t)) {
        throw new Error(`${spec.sig} — argument ${i+1} ('${p.n}') must be ${p.t}, got ${describeActualType(args[i])}`);
      }
    }
  }

  class Interpreter {
    constructor(ctx) { this.ctx = ctx; }

    eval(node) {
      switch (node.type) {
        case 'Literal': return node.value;

        case 'Ident': {
          if (!(node.name in this.ctx)) throw new Error(`Unknown variable: '${node.name}'`);
          const v = this.ctx[node.name];
          return v === undefined ? null : v;
        }

        case 'Member': {
          const obj = this.eval(node.object);
          if (obj == null) return null;
          const v = obj[node.prop];
          return v === undefined ? null : v;
        }

        case 'Index': {
          const obj = this.eval(node.object);
          if (obj == null) return null;
          const idx = this.eval(node.index);
          const v = Array.isArray(obj) ? (obj[idx] ?? null) : (obj[String(idx)] ?? null);
          return v === undefined ? null : v;
        }

        case 'MethodCall': {
          const obj = this.eval(node.object);
          const args = node.args.map(a => this.eval(a));

          if (obj == null) return null;

          // Identity Engine method chaining on primitive strings/arrays. These
          // are checked FIRST and are the *only* methods allowed on a primitive:
          // JS strings and arrays carry their own native methods, so falling
          // through to `obj[method]` would make `.charAt()`, `.padStart()`,
          // `.concat()` and the rest evaluate here as though they were OEL — and
          // would shadow the aliases whose names collide with a native one
          // (`.substring`, `.toUpperCase`) with the native arity.
          // The alias fn takes (obj, ...userArgs), so user-visible arity is
          // fn.length - 1. Specs are namespace-keyed and don't cover chains, so
          // arity comes from JS length and there's no type check.
          if (typeof obj === 'string' || Array.isArray(obj)
              || typeof obj === 'number' || typeof obj === 'boolean') {
            const table = typeof obj === 'string' ? STRING_METHOD_ALIASES
                        : Array.isArray(obj)      ? ARRAY_METHOD_ALIASES
                        : typeof obj === 'number' ? NUMBER_METHOD_ALIASES
                        : {};   // booleans have no documented methods
            const kind  = Array.isArray(obj) ? 'array' : typeof obj;
            const fn    = own(table, node.method);
            if (!fn) throw new Error(`'.${node.method}(...)' is not an Okta Expression Language method on a ${kind}`);
            if (args.length + 1 < fn.length) {
              throw new Error(`'.${node.method}(...)' on ${kind} expected ${fn.length - 1} argument${(fn.length-1)===1?'':'s'} but got ${args.length}`);
            }
            return fn(obj, ...args);
          }

          // Direct method on an object (namespace member, OELDateTime, user).
          // If the object is a top-level namespace Ident (Groups/String/etc.),
          // we can derive the fully-qualified name for spec-based validation.
          const nsName = node.object.type === 'Ident' ? node.object.name : null;

          const fn = findMethod(obj, node.method);

          if (typeof fn === 'function') {
            const fullName = nsName ? `${nsName}.${node.method}` : node.method;
            checkCall(fullName, fn, args);
            return fn.apply(obj, args);
          }

          throw new Error(nsName
            ? `'${nsName}.${node.method}' is not an Okta Expression Language function`
            : `'${node.method}' is not a function on ${typeof obj}`);
        }

        case 'Call': {
          const fn = this.ctx[node.name];
          if (typeof fn !== 'function') throw new Error(`'${node.name}' is not a function`);
          const args = node.args.map(a => this.eval(a));
          checkCall(node.name, fn, args);
          return fn(...args);
        }

        case 'ArrayLit':  return node.elems.map(e => this.eval(e));

        case 'ObjectLit': {
          const obj = {};
          for (const {key, val} of node.pairs) obj[key] = this.eval(val);
          return obj;
        }

        case 'Projection': {
          const collection = this.eval(node.collection);
          if (collection == null) return null;
          const arr = Array.isArray(collection) ? collection : [collection];
          return arr.map(item => {
            const projCtx = (item && typeof item === 'object')
              ? { ...this.ctx, ...item }
              : { ...this.ctx, it: item };
            try { return new Interpreter(projCtx).eval(node.expr); }
            catch { return null; }
          });
        }

        case 'Unary': {
          const v = this.eval(node.operand);
          if (node.op==='!') return !v;
          if (node.op==='-') return typeof v==='number' ? -v : NaN;
          throw new Error(`Unknown unary: ${node.op}`);
        }

        case 'Binary': {
          if (node.op==='&&') { const l=this.eval(node.left); return l ? this.eval(node.right) : l; }
          if (node.op==='||') { const l=this.eval(node.left); return l ? l : this.eval(node.right); }
          const l=this.eval(node.left), r=this.eval(node.right);
          // Deprecated `matches` operator. Java's String.matches semantics, which
          // is what SpEL delegates to: the pattern must match the WHOLE string,
          // so the documented `user.login matches '.*@example.com'` needs its
          // leading `.*` — an unanchored fragment won't match a longer subject.
          // A null subject is false rather than an error, like every other
          // null read here.
          if (node.op === 'matches') {
            if (l == null || r == null) return false;
            try { return new RegExp('^(?:' + String(r) + ')$').test(String(l)); }
            catch { throw new Error(`invalid regular expression in 'matches': ${String(r)}`); }
          }
          // eslint-disable-next-line eqeqeq
          switch (node.op) {
            case '+':  return (typeof l==='string'||typeof r==='string')
                               ? String(l??'')+String(r??'') : l+r;
            case '-':  return l-r; case '*': return l*r;
            case '/':  return l/r; case '%': return l%r;
            case '==': return l==r; case '!=': return l!=r;
            case '<':  return l<r;  case '>':  return l>r;
            case '<=': return l<=r; case '>=': return l>=r;
          }
          throw new Error(`Unknown op: ${node.op}`);
        }

        case 'Ternary': return this.eval(node.test) ? this.eval(node.cons) : this.eval(node.alt);

        case 'Elvis': { const v=this.eval(node.left); return v!=null ? v : this.eval(node.right); }

        default: throw new Error(`Unknown AST node: ${node.type}`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  CONTEXT FACTORY
  // ═══════════════════════════════════════════════════════════════

  // ── Group criteria vocabulary ────────────────────────────────────
  // Documented sets, exported on the public class so content.js can drive
  // autocomplete off them instead of keeping a second hand-copied list. The
  // operators and the three group types all appear verbatim in the reference's
  // own getGroups / isMemberOf examples.
  const GROUP_CRITERIA_KEY_NAMES = ['group.id', 'group.type', 'group.source.id', 'group.profile.name'];
  const GROUP_OPERATORS = ['STARTS_WITH', 'EXACT'];   // STARTS_WITH is the default
  const GROUP_TYPES     = ['OKTA_GROUP', 'APP_GROUP', 'BUILT_IN'];
  // The projection fields Okta illustrates. Not a limit — the docs say the
  // projection "can be any group attribute" and point at the List all groups
  // API schema, so a field outside this list still resolves if the record
  // carries it. This is the discoverable set, not the permitted one.
  const GROUP_FIELDS = ['id', 'type', 'created', 'lastUpdated', 'lastMembershipUpdated',
                        'profile.name', 'profile.description'];

  // Okta's docs write a `group.profile.name` criterion as `'Engineering.*'` and
  // describe the result as groups whose name *starts with* `Engineering` — the
  // trailing `.*` is decoration on an already-prefix match, not a pattern the
  // page ever calls a regex. Dropping it is what makes the documented examples
  // return what the documentation says they return. Deliberately only a trailing
  // `.*`: treating the whole value as a regex would break a group legitimately
  // named `C++ Devs` or `R&D (EU)`, and nothing in the docs asks for that.
  const stripTrailingGlob = (v) => String(v).replace(/\.\*$/, '');

  // Okta user-record fields that are NOT profile attributes. Used to split
  // `user.profile.$prop` back out of the flattened user object. Wider than the
  // six properties Okta documents for `user.$property` because these are all
  // record-level fields that can arrive on a fetched user and must not show up
  // as profile attributes.
  const USER_RECORD_KEYS = new Set([
    'id', 'status', 'created', 'activated', 'statusChanged', 'lastLogin',
    'lastUpdated', 'passwordChanged', 'type', 'credentials', 'transitioningToStatus',
    '_links', '_embedded', 'profile',
  ]);

  function buildContext(profile) {
    const rawUser  = profile.user     || {};
    const org      = profile.org      || { name:'Example Org', subDomain:'example' };
    const groups   = profile.groups   || [];
    const groupIds = profile.groupIds || [];

    // Full group records. Criteria matching reads keys the two flat arrays can't
    // answer (`group.type`, `group.source.id`), and documented collection
    // projections like `.![profile.name]` need real objects rather than strings.
    // content.js supplies these from the /groups fetch; when they're absent
    // (mock profile, or a caller passing only the name/id arrays) synthesize
    // minimal records so name/id criteria still behave.
    const groupObjects = Array.isArray(profile.groupObjects) && profile.groupObjects.length
      ? profile.groupObjects
      : groups.map((name, i) => ({ id: groupIds[i] ?? '', type: 'OKTA_GROUP',
                                   profile: { name, description: null } }));

    // Criteria keys Okta documents for group matching, and how to read each one
    // off a group record.
    const GROUP_CRITERIA_KEYS = {
      'group.id':           (g) => g.id,
      'group.type':         (g) => g.type,
      'group.source.id':    (g) => g.source && g.source.id,
      'group.profile.name': (g) => g.profile && g.profile.name,
    };

    // One criteria object vs one group. Documented semantics: `operator` is only
    // meaningful for group.profile.name and defaults to STARTS_WITH (not EXACT);
    // a key holding a list matches if ANY of its values match (OR).
    function groupMatchesCriteria(g, criteria) {
      if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) return false;
      const op = String(criteria['operator'] || 'STARTS_WITH').toUpperCase();
      let sawKey = false;
      for (const key of Object.keys(criteria)) {
        if (key === 'operator') continue;
        const read = own(GROUP_CRITERIA_KEYS, key);
        if (!read) {
          throw new Error(`unsupported group criteria key '${key}' — expected one of `
            + Object.keys(GROUP_CRITERIA_KEYS).join(', '));
        }
        sawKey = true;
        const actual = read(g);
        if (actual == null) return false;
        const wanted = Array.isArray(criteria[key]) ? criteria[key] : [criteria[key]];
        const ok = wanted.some(w => (key === 'group.profile.name' && op === 'STARTS_WITH')
          ? String(actual).startsWith(stripTrailingGlob(w))
          : String(actual) === String(w));
        if (!ok) return false;
      }
      return sawKey;
    }

    // Multiple criteria objects must ALL match (AND).
    const groupsMatching = (criteriaList) =>
      groupObjects.filter(g => criteriaList.every(c => groupMatchesCriteria(g, c)));
    // ── Identity Engine runtime signals ───────────────────────────
    // Fallbacks are deliberately thin: content.js supplies the full documented
    // surface, and a caller that doesn't (the Group Rule preview, a bare
    // `new OELEvaluator({})`) is better served by nulls than by invented signals
    // that would make a policy expression look like it passes.
    const session  = profile.session  || { amr:['pwd','mfa'] };
    const security = profile.security || { risk:{ level:'LOW' } };
    const device   = profile.device   || { profile:{ managed:false, registered:false } };
    // What the user typed at the sign-in widget. Distinct from user.login, which
    // is the resolved account — they differ when the user signs in with an alias.
    const login    = profile.login    || { identifier: rawUser.login ?? null };
    // Identity Governance access-request context (Access Certification rules).
    const accessRequest = profile.accessRequest || {
      operation: null, authenticator: { id:null, key:null }, metadata: { type:null },
    };

    // idpuser — attributes from an external Identity Provider (SAML / OIDC IdP).
    // Populated when the user authenticates through or is mastered from an external IdP.
    const idpuser  = Object.assign(Object.create(null), rawUser, profile.idpuser || {});

    // app — the application object (clientId, id, profile).
    const app      = profile.app      || { id:'', clientId:'', profile:{ label:'' } };

    // access — OAuth 2.0 access request context.
    const access   = profile.access   || { scope:[] };

    // `user.profile.$prop` — Identity Engine separates the profile attributes
    // from the record-level internals, which are read as `user.$property` (only
    // id, status, created, lastUpdated, passwordChanged, lastLogin are
    // documented there). Both forms have to work: this adds the namespaced one
    // without disturbing the flattened access that `user.department` and every
    // shipped template rely on. Derived by subtraction so any custom attribute
    // is included automatically — an allow list would silently drop them.
    const userProfileView = Object.assign(Object.create(null), (() => {
      if (rawUser.profile && typeof rawUser.profile === 'object') return rawUser.profile;
      const out = {};
      for (const k of Object.keys(rawUser)) {
        if (!USER_RECORD_KEYS.has(k)) out[k] = rawUser[k];
      }
      return out;
    })());

    // User object — augmented with OEL built-in methods
    const user = Object.assign(Object.create(null), rawUser, {
      profile: userProfileView,
      // Returns group *objects*, which is what makes the documented projections
      // work: `user.getGroups({'group.type':'OKTA_GROUP'}).![profile.name]`.
      // Takes one or more criteria objects, ANDed together.
      getGroups(...criteria) {
        const objs = criteria.filter(c => c && typeof c === 'object');
        return objs.length ? groupsMatching(objs) : [...groupObjects];
      },
      getInternalProperty(prop) {
        const map = { id:rawUser.id, status:rawUser.status, created:rawUser.created,
                      lastUpdated:rawUser.lastUpdated, passwordChanged:rawUser.passwordChanged,
                      lastLogin:rawUser.lastLogin };
        return prop in map ? map[prop] : (rawUser[prop] ?? null);
      },
      isMemberOf(...criteria) {
        const objs = criteria.filter(c => c && typeof c === 'object');
        return objs.length > 0 && groupsMatching(objs).length > 0;
      },
      // Returns the profile of the user on the other side of a linked-object
      // relationship. `manager` is Okta's one built-in primary name, and it's
      // the only one the extension can answer for real — content.js fetches
      // that user when the profile carries a managerId. A custom relationship
      // ('supervisor', 'mentor', …) is a valid expression that this preview has
      // no data for, so it answers null, the same as an unassigned appuser.
      getLinkedObject(primaryName) {
        return String(primaryName).toLowerCase() === 'manager' ? managerProfile : null;
      },
    });

    // appuser — app-specific profile. Contains ONLY what the selected app's
    // assignment actually has; there is no fallback to the user object. When
    // a user isn't assigned to an app, every appuser.* reference must resolve
    // to null — that matches Okta's real runtime behavior.
    const appuser = Object.assign(Object.create(null), profile.appuser || {});

    // ── String namespace ──────────────────────────────────────────
    const OELString = {
      len:             (s)          => s==null?0:String(s).length,
      append:          (s,suf)      => (s??'')+(suf??''),
      join:            (sep,...pts) => { const a=Array.isArray(pts[0])?pts[0]:pts; return a.map(p=>p??'').join(sep??''); },
      toUpperCase:     (s)          => s==null?null:String(s).toUpperCase(),
      toLowerCase:     (s)          => s==null?null:String(s).toLowerCase(),
      substring:       (s,a,b=undefined) => s==null?null:(b!=null?String(s).substring(a,b):String(s).substring(a)),
      substringBefore: (s,d)        => { if(s==null)return null; const i=String(s).indexOf(String(d)); return i<0?String(s):String(s).substring(0,i); },
      substringAfter:  (s,d)        => { if(s==null)return null; const i=String(s).indexOf(String(d)); return i<0?'':String(s).substring(i+String(d).length); },
      replace:         (s,p,r)      => s==null?null:String(s).replace(new RegExp(String(p),'g'),r??''),
      replaceFirst:    (s,p,r)      => s==null?null:String(s).replace(new RegExp(String(p)),r??''),
      stringContains:  (s,sub)      => s!=null && String(s).includes(String(sub)),
      startsWith:      (s,pre)      => s!=null && String(s).startsWith(String(pre)),
      removeSpaces:    (s)          => s==null?null:String(s).replace(/\s+/g,''),
      stringSwitch(input, def, ...pairs) {
        const str = String(input ?? '');
        for (let i = 0; i+1 < pairs.length; i += 2) {
          if (str === String(pairs[i])) return pairs[i+1];
        }
        return def;
      },
    };

    // ── Deprecated unqualified string functions ───────────────────
    // Okta's reference documents these as the pre-namespace spelling and its
    // runtime still honors them. They delegate to the namespace impls rather
    // than re-implementing, so the two forms can't diverge; the deprecation is
    // surfaced by the `deprecated` field on their OEL_SPECS entries, not by
    // changing what they return.
    const toUpperCase     = (s)     => OELString.toUpperCase(s);
    const toLowerCase     = (s)     => OELString.toLowerCase(s);
    const substring       = (s,a,b) => OELString.substring(s, a, b);
    const substringBefore = (s,d)   => OELString.substringBefore(s, d);
    const substringAfter  = (s,d)   => OELString.substringAfter(s, d);

    // ── Arrays namespace ──────────────────────────────────────────
    // "CSV strings may be supplied as input to all Arrays* functions", so every
    // entry point coerces first. Splitting on ',' and trimming matches how Okta
    // reads a multivalued AD attribute that arrived as one delimited string.
    const csvToArray = (a) => {
      if (a == null) return [];
      if (Array.isArray(a)) return a;
      const s = String(a);
      return s === '' ? [] : s.split(',').map(p => p.trim());
    };
    // Comparison is by string value: a CSV string can only ever yield strings,
    // so `Arrays.contains('1,2,3', 1)` has to match the way Okta's does.
    const sameElement = (x, y) => x === y || (x != null && y != null && String(x) === String(y));
    const OELArrays = {
      add:          (a,el)   => [...csvToArray(a), el],
      remove:       (a,el)   => csvToArray(a).filter(e => !sameElement(e, el)),
      get:          (a,i)    => csvToArray(a)[i] ?? null,
      contains:     (a,el)   => csvToArray(a).some(e => sameElement(e, el)),
      // Documented: Arrays.size(NULL) is 0.
      size:         (a)      => a==null ? 0 : csvToArray(a).length,
      // Documented: Arrays.isEmpty(NULL) is true.
      isEmpty:      (a)      => a==null || csvToArray(a).length === 0,
      // Documented in the classic Array functions table. Returns an empty array
      // rather than mutating — nothing in OEL has reference semantics.
      clear:        (_a)     => [],
      toCsvString:  (a)      => csvToArray(a).join(','),
      // Unlike the others, flatten's params are untyped, so only strings get the
      // CSV treatment — coercing everything would turn numbers into strings.
      flatten:      (...as)  => as.flatMap(a => typeof a === 'string' ? csvToArray(a) : a).flat(Infinity),
    };

    // ── Time namespace ────────────────────────────────────────────
    const OELTime = {
      // Returns a String (not a chainable object) — that's the documented
      // classic return type. `DateTime.now()` is the object-returning form.
      now(tz = undefined, fmt = undefined) {
        const zone = tz == null ? null : assertZone(tz);
        const d = new Date();
        if (fmt)  return formatDate(d, fmt, zone);
        if (zone) return formatDate(d, DEFAULT_DATE_FORMAT, zone);
        return d.toISOString();
      },
      fromUnixToIso8601:    (s) => s==null?null:OELDateTime.fromUnix(s).toString(),
      fromIso8601ToUnix:    (s) => s==null?null:OELDateTime.fromIso(s).toUnix(),
      fromWindowsToIso8601: (s) => s==null?null:OELDateTime.fromWindows(s).toString(),
      fromIso8601ToWindows: (s) => s==null?null:OELDateTime.fromIso(s).toWindows(),
      // `format` describes how to READ `time`, per the docs. Without it the old
      // one-arg version fell through to Date's loose parsing, so a non-ISO input
      // like '01/02/2024' silently came back as the wrong day.
      fromStringToIso8601:  (s, fmt) => {
        if (s == null) return null;
        const dt = parseWithFormat(s, fmt);
        return dt ? dt.toString() : null;
      },
      fromIso8601ToString:  (s,fmt) => s==null?null:formatDate(new Date(String(s)), fmt),
    };

    // ── Convert namespace ─────────────────────────────────────────
    const OELConvert = {
      toInt:    (v) => { if(v==null)return null; const n=parseInt(String(v),10); return isNaN(n)?null:n; },
      toNum:    (v) => { if(v==null)return null; const n=parseFloat(String(v));   return isNaN(n)?null:n; },
    };

    // ── Iso3166Convert namespace ──────────────────────────────────
    // COUNTRY_DATA / resolveCountry live at module scope so `.parseCountryCode()`
    // shares this one table.
    const Iso3166Convert = {
      toAlpha2:  (v) => resolveCountry(v)?.alpha2  ?? null,
      toAlpha3:  (v) => resolveCountry(v)?.alpha3  ?? null,
      toNumeric: (v) => resolveCountry(v)?.numeric ?? null,
      toName:    (v) => resolveCountry(v)?.name    ?? null,
    };

    // ── Group functions ───────────────────────────────────────────
    const isMemberOfGroupName           = (n)   => groups.includes(String(n));
    const isMemberOfGroup               = (id)  => groupIds.includes(String(id));
    const isMemberOfAnyGroup            = (...nn) => nn.flat().some(n => groups.includes(String(n)));
    const isMemberOfGroupNameStartsWith = (pre) => groups.some(g => g.startsWith(String(pre)));
    const isMemberOfGroupNameContains   = (sub) => groups.some(g => g.includes(String(sub)));
    const isMemberOfGroupNameRegex      = (re)  => groups.some(g => new RegExp(String(re)).test(g));
    // getFilteredGroups({allow list}, group_expression, limit). All three are
    // required by Okta's runtime — same precedent as Groups.* and its `limit`.
    // The allow list holds group *IDs* (the docs' example passes `00g…` values);
    // group_expression names the field to emit per matched group, e.g.
    // 'group.name' or 'group.id'.
    const GROUP_EXPRESSION_FIELDS = {
      'group.id':          (g) => g.id,
      'group.name':        (g) => g.profile && g.profile.name,
      'group.description': (g) => g.profile && g.profile.description,
    };
    const getFilteredGroups = (wl, expr, limit) => {
      const allow = Array.isArray(wl) ? wl.map(String) : [String(wl)];
      const read  = own(GROUP_EXPRESSION_FIELDS, String(expr));
      if (!read) {
        throw new Error(`getFilteredGroups: unsupported group_expression '${expr}' — expected one of `
          + Object.keys(GROUP_EXPRESSION_FIELDS).join(', '));
      }
      return groupObjects
        .filter(g => allow.includes(String(g.id)))
        .map(read)
        .filter(v => v != null)
        .slice(0, limit);
    };

    // Legacy Groups.* API. All three params required per Okta docs — no JS
    // defaults so Function.length correctly reports 3 (matches the spec).
    const Groups = {
      contains:   (_app, pat, limit) => { let r=groups.filter(g=>g.includes(String(pat)));   return r.slice(0, limit); },
      startsWith: (_app, pat, limit) => { let r=groups.filter(g=>g.startsWith(String(pat))); return r.slice(0, limit); },
      endsWith:   (_app, pat, limit) => { let r=groups.filter(g=>g.endsWith(String(pat)));   return r.slice(0, limit); },
    };

    // ── Manager / Assistant functions ─────────────────────────────
    // If the content script has fetched the manager's real profile, prefer it.
    // Otherwise derive a minimal profile from the string fields on the user.
    const managerProfile = profile.manager
      ? profile.manager
      : rawUser.managerId ? {
          login:     rawUser.managerEmail || null,
          email:     rawUser.managerEmail || null,
          firstName: rawUser.manager ? rawUser.manager.split(' ')[0] : null,
          lastName:  rawUser.manager ? rawUser.manager.split(' ').slice(1).join(' ') : null,
        } : null;

    const getManagerUser      = (_src)         => managerProfile;
    const getManagerAppUser   = (_src, _attr)  => managerProfile;
    const getAssistantUser    = (_src)         => null;
    const getAssistantAppUser = (_src, _attr)  => null;

    // ── Directory / Workday functions ─────────────────────────────
    const hasDirectoryUser = () => Object.keys(profile.appuser || {}).length > 0;
    const findDirectoryUser= () => hasDirectoryUser() ? appuser : null;
    const hasWorkdayUser   = () => !!(profile.workday);
    const findWorkdayUser  = () => profile.workday || null;

    // ── DateTime.now() — Identity Engine top-level ────────────────
    const DateTime = { now: () => new OELDateTime(new Date()) };

    // ── Named app references (e.g. active_directory.*) ────────────
    const namedApps = {};
    if (profile.apps && typeof profile.apps === 'object') {
      Object.entries(profile.apps).forEach(([k, v]) => { namedApps[k] = v; });
    }

    // ── OAuth-time variables ──────────────────────────────────────
    // Okta claim expressions on authorization servers can reference the OAuth
    // client, request parameters, and general request context. Mocked from the
    // selected app + scopes so tenant claims using these variables evaluate
    // instead of throwing.
    const client = {
      id:   app.clientId || null,
      name: app.profile?.label || app.label || null,
    };
    const oauth_request = {
      client_id: app.clientId || null,
      scope:     Array.isArray(access.scope) ? access.scope.join(' ') : (access.scope || ''),
      scopes:    Array.isArray(access.scope) ? access.scope : [],
    };
    const context = {
      device, session, security,
      // Newer Okta docs also expose `context.oauth2.*` — mirror the request there.
      oauth2: { client, request: oauth_request },
      // Legacy alias for org
      org,
    };

    return {
      user, appuser, idpuser, app, access, org, groups, groupIds, session, security, device,
      login, accessRequest,
      client, oauth_request, context,
      String:  OELString,
      Arrays:  OELArrays,
      Time:    OELTime,
      Convert: OELConvert,
      Iso3166Convert,
      Groups,
      DateTime,
      isMemberOfGroupName, isMemberOfGroup, isMemberOfAnyGroup,
      isMemberOfGroupNameStartsWith, isMemberOfGroupNameContains, isMemberOfGroupNameRegex,
      getFilteredGroups,
      getManagerUser, getManagerAppUser, getAssistantUser, getAssistantAppUser,
      hasDirectoryUser, findDirectoryUser, hasWorkdayUser, findWorkdayUser,
      toUpperCase, toLowerCase, substring, substringBefore, substringAfter,
      ...namedApps,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ═══════════════════════════════════════════════════════════════

  class OELEvaluator {
    constructor(profile) { this.profile = profile; }

    // Returns { success, result, error, deprecations }. `deprecations` is an
    // array of notes about deprecated-but-documented constructs the expression
    // uses — always present so callers can render it without a guard. It stays
    // empty on a parse failure: there's no AST to read, and the error is the
    // more useful thing to show.
    evaluate(expression, profile) {
      if (!expression?.trim()) return { success:false, result:null, error:null, deprecations:[] };
      const p = profile || this.profile;
      let deprecations = [];
      try {
        const tokens = new Lexer(expression.trim()).tokenize();
        const ast    = new Parser(tokens).parse();
        deprecations = [...collectDeprecations(ast)];
        const result = new Interpreter(buildContext(p)).eval(ast);
        return { success:true, result, error:null, deprecations };
      } catch (err) {
        return { success:false, result:null, error:err.message, deprecations };
      }
    }
  }

  // ── Introspection for the UI ─────────────────────────────────────
  // content.js drives autocomplete off these rather than keeping its own copies.
  // The method-name lists in particular used to be hand-maintained mirrors of the
  // alias tables with a "keep in sync" comment; reading the real tables means a
  // method added below can't go missing from the completion list, and a completion
  // can't be offered for a method that doesn't exist.
  OELEvaluator.METHOD_NAMES = {
    string:   Object.keys(STRING_METHOD_ALIASES),
    array:    Object.keys(ARRAY_METHOD_ALIASES),
    number:   Object.keys(NUMBER_METHOD_ALIASES),
    datetime: Object.getOwnPropertyNames(OELDateTime.prototype).filter(n => n !== 'constructor'),
    country:  Object.getOwnPropertyNames(OELCountryCode.prototype)
                .filter(n => n !== 'constructor' && !n.startsWith('_is')),
  };
  OELEvaluator.GROUP_CRITERIA_KEYS = GROUP_CRITERIA_KEY_NAMES;
  OELEvaluator.GROUP_OPERATORS     = GROUP_OPERATORS;
  OELEvaluator.GROUP_TYPES         = GROUP_TYPES;
  OELEvaluator.GROUP_FIELDS        = GROUP_FIELDS;
  OELEvaluator.USER_RECORD_KEYS    = USER_RECORD_KEYS;

  global.OELEvaluator = OELEvaluator;

})(typeof window !== 'undefined' ? window : global);
