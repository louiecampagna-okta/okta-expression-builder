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

  function formatDate(d, fmt) {
    return (fmt || 'yyyy-MM-dd\'T\'HH:mm:ss.SSSZ')
      .replace('yyyy',  d.getUTCFullYear())
      .replace('YYYY',  d.getUTCFullYear())
      .replace('MM',    pad(d.getUTCMonth() + 1))
      .replace('dd',    pad(d.getUTCDate()))
      .replace('HH',    pad(d.getUTCHours()))
      .replace('mm',    pad(d.getUTCMinutes()))
      .replace('ss',    pad(d.getUTCSeconds()))
      .replace('SSS',   pad(d.getUTCMilliseconds(), 3));
  }

  class OELDateTime {
    constructor(date) {
      this._d = date instanceof Date ? new Date(date) : new Date(date);
    }
    // Formatting
    toString(fmt)     { return fmt ? formatDate(this._d, fmt) : this._d.toISOString(); }
    toUnix()          { return String(Math.floor(this._d.getTime() / 1000)); }
    toWindows()       { return String((this._d.getTime() + 11644473600000) * 10000); }
    toZone()          { return this; } // timezone conversion is a no-op in the mock
    // Arithmetic
    plusDays(n)       { const d = new Date(this._d); d.setUTCDate(d.getUTCDate() + n);       return new OELDateTime(d); }
    plusHours(n)      { const d = new Date(this._d); d.setUTCHours(d.getUTCHours() + n);     return new OELDateTime(d); }
    plusMinutes(n)    { const d = new Date(this._d); d.setUTCMinutes(d.getUTCMinutes() + n); return new OELDateTime(d); }
    plusSeconds(n)    { const d = new Date(this._d); d.setUTCSeconds(d.getUTCSeconds() + n); return new OELDateTime(d); }
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
    AND:'AND', OR:'OR', BANG:'BANG',
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
      if      (w === 'true' || w === 'false') this.result.push({ type: T.BOOL, value: w === 'true' });
      else if (w === 'null')                  this.result.push({ type: T.NULL });
      else if (w === 'AND')                   this.result.push({ type: T.AND });
      else if (w === 'OR')                    this.result.push({ type: T.OR });
      else if (w === 'not')                   this.result.push({ type: T.BANG });
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
    parseRel() {
      let l = this.parseAdd();
      const m = {[T.LT]:'<',[T.GT]:'>',[T.LTE]:'<=',[T.GTE]:'>='};
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
      // Object literal: {'key': value, key: value}
      if (t.type===T.LBRACE) {
        this.consume();
        const pairs=[];
        while (!this.is(T.RBRACE,T.EOF)) {
          // key can be a string literal or an identifier
          const keyTok = this.consume();
          const key = (keyTok.type===T.STRING||keyTok.type===T.IDENT) ? keyTok.value
                    : String(keyTok.value ?? keyTok.type);
          this.expect(T.COLON);
          const val = this.parseExpr();
          pairs.push({key, val});
          if (this.is(T.COMMA)) this.consume();
        }
        this.expect(T.RBRACE);
        return {type:'ObjectLit', pairs};
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

  // String method aliases for Identity Engine chaining style
  // (when a plain string has a method called on it that doesn't exist natively,
  //  we fall back to the OEL String namespace equivalent)
  const STRING_METHOD_ALIASES = {
    toUpperCase:     (s)     => String(s).toUpperCase(),
    toLowerCase:     (s)     => String(s).toLowerCase(),
    trim:            (s)     => String(s).trim(),
    removeSpaces:    (s)     => String(s).replace(/\s+/g,''),
    length:          (s)     => String(s).length,
    len:             (s)     => String(s).length,
    contains:        (s,sub) => String(s).includes(String(sub)),
    startsWith:      (s,pre) => String(s).startsWith(String(pre)),
    endsWith:        (s,suf) => String(s).endsWith(String(suf)),
    substring:       (s,a,b) => b!=null ? String(s).substring(a,b) : String(s).substring(a),
    substringBefore: (s,d)   => { const i=String(s).indexOf(String(d)); return i<0?String(s):String(s).substring(0,i); },
    substringAfter:  (s,d)   => { const i=String(s).indexOf(String(d)); return i<0?'':String(s).substring(i+String(d).length); },
    replace:         (s,p,r) => String(s).replace(new RegExp(String(p),'g'),r??''),
    replaceFirst:    (s,p,r) => String(s).replace(new RegExp(String(p)),r??''),
    // Identity Engine time parse methods on date strings
    parseStringTime: (s)     => OELDateTime.fromIso(s),
    parseUnixTime:   (s)     => OELDateTime.fromUnix(s),
    parseWindowsTime:(s)     => OELDateTime.fromWindows(s),
    toInteger:       (s)     => { const n=parseInt(s,10); return isNaN(n)?null:n; },
    toNumber:        (s)     => { const n=parseFloat(s);  return isNaN(n)?null:n; },
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

          // Direct method on object (plain JS or OELDateTime)
          if (typeof obj[node.method] === 'function') return obj[node.method](...args);

          // Identity Engine: method chaining on primitive strings
          if (typeof obj === 'string' && STRING_METHOD_ALIASES[node.method]) {
            return STRING_METHOD_ALIASES[node.method](obj, ...args);
          }

          // Identity Engine: method chaining on arrays
          if (Array.isArray(obj) && ARRAY_METHOD_ALIASES[node.method]) {
            return ARRAY_METHOD_ALIASES[node.method](obj, ...args);
          }

          // OEL namespace method calls already handled via 'Member' lookup
          throw new Error(`'${node.method}' is not a function on ${typeof obj}`);
        }

        case 'Call': {
          const fn = this.ctx[node.name];
          if (typeof fn !== 'function') throw new Error(`'${node.name}' is not a function`);
          const args = node.args.map(a => this.eval(a));
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

  function buildContext(profile) {
    const rawUser  = profile.user     || {};
    const org      = profile.org      || { name:'Example Org', subDomain:'example' };
    const groups   = profile.groups   || [];
    const groupIds = profile.groupIds || [];
    const session  = profile.session  || { amr:['pwd','mfa'] };
    const security = profile.security || { risk:{ level:'LOW' } };
    const device   = profile.device   || { profile:{ managed:false, registered:false } };

    // idpuser — attributes from an external Identity Provider (SAML / OIDC IdP).
    // Populated when the user authenticates through or is mastered from an external IdP.
    const idpuser  = Object.assign(Object.create(null), rawUser, profile.idpuser || {});

    // app — the application object (clientId, id, profile).
    const app      = profile.app      || { id:'', clientId:'', profile:{ label:'' } };

    // access — OAuth 2.0 access request context.
    const access   = profile.access   || { scope:[] };

    // User object — augmented with OEL built-in methods
    const user = Object.assign(Object.create(null), rawUser, {
      getGroups(prefix, conditions, limit) {
        let r = prefix ? groups.filter(g => g.startsWith(String(prefix))) : [...groups];
        if (typeof limit==='number') r = r.slice(0, limit);
        return r;
      },
      getInternalProperty(prop) {
        const map = { id:rawUser.id, status:rawUser.status, created:rawUser.created,
                      lastUpdated:rawUser.lastUpdated, passwordChanged:rawUser.passwordChanged,
                      lastLogin:rawUser.lastLogin };
        return prop in map ? map[prop] : (rawUser[prop] ?? null);
      },
      isMemberOf(criteria) {
        if (!criteria || typeof criteria !== 'object') return false;
        const name = criteria['group.profile.name'];
        const id   = criteria['group.id'];
        const op   = (criteria['operator'] || 'EXACT').toUpperCase();
        if (name) {
          return op === 'STARTS_WITH'
            ? groups.some(g => g.startsWith(String(name)))
            : groups.some(g => g === String(name));
        }
        if (id) return groupIds.includes(String(id));
        return false;
      },
      getLinkedObject(primaryName) { return null; }, // mock
    });

    // appuser — app-specific profile, falls back to user
    const appuser = Object.assign(Object.create(null), rawUser, profile.appuser || {});

    // ── String namespace ──────────────────────────────────────────
    const OELString = {
      len:             (s)          => s==null?0:String(s).length,
      append:          (s,suf)      => (s??'')+(suf??''),
      join:            (sep,...pts) => { const a=Array.isArray(pts[0])?pts[0]:pts; return a.map(p=>p??'').join(sep??''); },
      toUpperCase:     (s)          => s==null?null:String(s).toUpperCase(),
      toLowerCase:     (s)          => s==null?null:String(s).toLowerCase(),
      substring:       (s,a,b)      => s==null?null:(b!=null?String(s).substring(a,b):String(s).substring(a)),
      substringBefore: (s,d)        => { if(s==null)return null; const i=String(s).indexOf(String(d)); return i<0?String(s):String(s).substring(0,i); },
      substringAfter:  (s,d)        => { if(s==null)return null; const i=String(s).indexOf(String(d)); return i<0?'':String(s).substring(i+String(d).length); },
      replace:         (s,p,r)      => s==null?null:String(s).replace(new RegExp(String(p),'g'),r??''),
      replaceFirst:    (s,p,r)      => s==null?null:String(s).replace(new RegExp(String(p)),r??''),
      stringContains:  (s,sub)      => s!=null && String(s).includes(String(sub)),
      startsWith:      (s,pre)      => s!=null && String(s).startsWith(String(pre)),
      removeSpaces:    (s)          => s==null?null:String(s).replace(/\s+/g,''),
      trim:            (s)          => s==null?null:String(s).trim(),
      match:           (s,re)       => s!=null && new RegExp(String(re)).test(String(s)),
      splitByRegex:    (s,re)       => s==null?[]:String(s).split(new RegExp(String(re))),
      toString:        (v)          => v==null?null:String(v),
      stringSwitch(input, def, ...pairs) {
        const str = String(input ?? '');
        for (let i = 0; i+1 < pairs.length; i += 2) {
          if (str === String(pairs[i])) return pairs[i+1];
        }
        return def;
      },
    };

    // ── Arrays namespace ──────────────────────────────────────────
    const OELArrays = {
      add:          (a,el)   => Array.isArray(a)?[...a,el]:[el],
      remove:       (a,el)   => Array.isArray(a)?a.filter(e=>e!==el):[],
      clear:        ()       => [],
      get:          (a,i)    => Array.isArray(a)?(a[i]??null):null,
      contains:     (a,el)   => Array.isArray(a)&&a.includes(el),
      size:         (a)      => a==null?0:(Array.isArray(a)?a.length:String(a).length),
      isEmpty:      (a)      => a==null||(Array.isArray(a)&&a.length===0),
      toCsvString:  (a)      => Array.isArray(a)?a.join(','):'',
      flatten:      (...as)  => as.flat(Infinity),
      unique:       (a)      => Array.isArray(a)?[...new Set(a)]:[],
      intersection: (a,b)    => (Array.isArray(a)&&Array.isArray(b))?a.filter(e=>b.includes(e)):[],
      union:        (a,b)    => [...new Set([...(Array.isArray(a)?a:[]),...(Array.isArray(b)?b:[])])],
    };

    // ── Time namespace ────────────────────────────────────────────
    const OELTime = {
      now(tz, fmt) {
        const dt = new OELDateTime(new Date());
        return fmt ? formatDate(dt._d, fmt) : dt._d.toISOString();
      },
      fromUnixToIso8601:    (s) => s==null?null:OELDateTime.fromUnix(s).toString(),
      fromIso8601ToUnix:    (s) => s==null?null:OELDateTime.fromIso(s).toUnix(),
      fromWindowsToIso8601: (s) => s==null?null:OELDateTime.fromWindows(s).toString(),
      fromIso8601ToWindows: (s) => s==null?null:OELDateTime.fromIso(s).toWindows(),
      fromStringToIso8601:  (s) => { try { return s==null?null:new Date(String(s)).toISOString(); } catch { return null; } },
      fromIso8601ToString:  (s,fmt) => s==null?null:formatDate(new Date(String(s)), fmt),
    };

    // ── Convert namespace ─────────────────────────────────────────
    const OELConvert = {
      toInt:    (v) => { if(v==null)return null; const n=parseInt(String(v),10); return isNaN(n)?null:n; },
      toNum:    (v) => { if(v==null)return null; const n=parseFloat(String(v));   return isNaN(n)?null:n; },
      toString: (v) => v==null?null:String(v),
      toBool:   (v) => v==null?null:(typeof v==='boolean'?v:String(v).toLowerCase()==='true'),
    };

    // ── Iso3166Convert namespace ──────────────────────────────────
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
    const resolveCountry = (v) => {
      if (!v) return null;
      const k = String(v).toUpperCase();
      return COUNTRY_DATA[k] || COUNTRY_DATA[String(v)] || null;
    };
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
    const getFilteredGroups             = (wl, _cond, limit) => {
      let r = Array.isArray(wl) ? groups.filter(g => wl.includes(g)) : [...groups];
      return typeof limit==='number' ? r.slice(0, limit) : r;
    };

    // Legacy Groups.* API
    const Groups = {
      contains:   (_app, pat, limit=10) => { let r=groups.filter(g=>g.includes(String(pat))); return r.slice(0,limit); },
      startsWith: (_app, pat, limit=10) => { let r=groups.filter(g=>g.startsWith(String(pat))); return r.slice(0,limit); },
      endsWith:   (_app, pat, limit=10) => { let r=groups.filter(g=>g.endsWith(String(pat)));   return r.slice(0,limit); },
    };

    // ── Manager / Assistant functions ─────────────────────────────
    const managerProfile = rawUser.managerId ? {
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

    return {
      user, appuser, idpuser, app, access, org, groups, groupIds, session, security, device,
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
      ...namedApps,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ═══════════════════════════════════════════════════════════════

  class OELEvaluator {
    constructor(profile) { this.profile = profile; }

    evaluate(expression, profile) {
      if (!expression?.trim()) return { success:false, result:null, error:null };
      const p = profile || this.profile;
      try {
        const tokens = new Lexer(expression.trim()).tokenize();
        const ast    = new Parser(tokens).parse();
        const result = new Interpreter(buildContext(p)).eval(ast);
        return { success:true, result, error:null };
      } catch (err) {
        return { success:false, result:null, error:err.message };
      }
    }
  }

  global.OELEvaluator = OELEvaluator;

})(typeof window !== 'undefined' ? window : global);
