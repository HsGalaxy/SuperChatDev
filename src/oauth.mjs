import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicJSON, escapeHTML, readJSON } from './common.mjs';

const randomToken = () => randomBytes(32).toString('base64url');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const defaults = Object.freeze({ accessTokenMinutes: 60, authorizationCodeSeconds: 60,
  consentFormMinutes: 5, allowDynamicRegistration: true, maxClients: 1000,
  envBearerEnabled: true, persistAccessTokens: false, refreshTokensEnabled: true, refreshTokenDays: 30 });
const equal = (a, b) => {
  const left = Buffer.from(a || '');
  const right = Buffer.from(b || '');
  return left.length === right.length && timingSafeEqual(left, right);
};

// Single-owner OAuth authorization-code provider with mandatory PKCE S256.
// Codes/tokens are short-lived and in-memory; service restart requires reconnecting.
export class OAuth {
  constructor({ publicBaseURL, password, bearerToken, clientRedirectOrigins = [], dataRoot }) {
    this.base = publicBaseURL;
    this.password = password;
    this.bearer = bearerToken;
    this.redirectOrigins = new Set(clientRedirectOrigins);
    this.clients = new Map();
    this.codes = new Map();
    this.tokens = new Map();
    this.forms = new Map();
    this.attempts = new Map();
    this.clientFile = dataRoot ? path.join(dataRoot, 'oauth-clients.json') : null;
    this.clientWriteQueue = Promise.resolve();
    this.tokenFile = dataRoot ? path.join(dataRoot, 'oauth-access-tokens.json') : null;
    this.bearerFile = dataRoot ? path.join(dataRoot, 'oauth-managed-bearer.json') : null;
    this.tokenWriteQueue = Promise.resolve();
    this.refreshFile = dataRoot ? path.join(dataRoot, 'oauth-refresh-tokens.json') : null;
    this.refreshTokens = new Map();
    this.refreshWriteQueue = Promise.resolve();
    this.refreshLoaded = false;
    this.policy = { ...defaults };
    this.managedBearer = null;
  }

  async setPolicy(policy) {
    const next = { ...defaults, ...policy };
    if (next.refreshTokensEnabled && !this.refreshLoaded) await this.loadRefreshTokens();
    if (next.persistAccessTokens && !this.policy.persistAccessTokens && this.tokenFile) {
      let state;
      try { state = await readJSON(this.tokenFile); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (state) {
        if (state.version !== 1 || !Array.isArray(state.tokens)) throw new Error('Invalid OAuth token registry');
        for (const item of state.tokens) {
          if (typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.hash) ||
              !Number.isSafeInteger(item.expires) || typeof item.client_id !== 'string') {
            throw new Error('Invalid persisted OAuth token');
          }
          if (item.expires > Date.now() && this.clients.has(item.client_id))
            this.tokens.set(item.hash, { expires: item.expires, client_id: item.client_id });
        }
      }
    }
    this.policy = next;
    this.sweep();
    if (this.policy.persistAccessTokens) await this.saveTokens();
    else if (this.tokenFile) await rm(this.tokenFile, { force: true });
    if (this.policy.refreshTokensEnabled) await this.saveRefreshTokens();
    else {
      this.refreshTokens.clear();
      if (this.refreshFile) await rm(this.refreshFile, { force: true });
    }
  }

  async loadRefreshTokens() {
    if (this.refreshLoaded) return;
    let saved;
    if (this.refreshFile) {
      try { saved = await readJSON(this.refreshFile); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (saved) {
      if (saved.version !== 1 || !Array.isArray(saved.tokens)) throw new Error('Invalid persisted OAuth refresh registry');
      for (const item of saved.tokens) {
        if (!item || typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.hash) ||
            typeof item.client_id !== 'string' || !Number.isSafeInteger(item.expires)) {
          throw new Error('Invalid persisted OAuth refresh token');
        }
        if (item.expires > Date.now() && this.clients.has(item.client_id)) {
          this.refreshTokens.set(item.hash, {client_id:item.client_id, expires:item.expires});
        }
      }
    }
    this.refreshLoaded = true;
  }

  saveRefreshTokens() {
    if (!this.policy.refreshTokensEnabled || !this.refreshFile) return Promise.resolve();
    const write = this.refreshWriteQueue.then(() => atomicJSON(this.refreshFile,
      {version:1,tokens:[...this.refreshTokens].map(([hash,item])=>({hash,client_id:item.client_id,expires:item.expires}))}));
    this.refreshWriteQueue = write.catch(()=>{});
    return write;
  }

  async issueTokenPair(clientId, priorRefreshHash=null) {
    const expires_in = this.policy.accessTokenMinutes * 60;
    const access_token = randomToken();
    const hash = sha256(access_token);
    const prior = priorRefreshHash ? this.refreshTokens.get(priorRefreshHash) : null;
    if (priorRefreshHash && (!prior || prior.client_id !== clientId || prior.expires <= Date.now())) {
      throw new Error('OAuth refresh token was already rotated or expired');
    }
    if (priorRefreshHash) this.refreshTokens.delete(priorRefreshHash);
    const refresh_token = this.policy.refreshTokensEnabled ? randomToken() : null;
    const refreshHash = refresh_token ? sha256(refresh_token) : null;
    this.tokens.set(hash, {client_id:clientId,expires:Date.now()+expires_in*1000});
    if(refreshHash)this.refreshTokens.set(refreshHash,{client_id:clientId,expires:Date.now()+this.policy.refreshTokenDays*86400000});
    try {
      await this.saveTokens();
      await this.saveRefreshTokens();
    } catch (error) {
      this.tokens.delete(hash);
      if(refreshHash)this.refreshTokens.delete(refreshHash);
      if(priorRefreshHash && prior)this.refreshTokens.set(priorRefreshHash,prior);
      await Promise.allSettled([this.saveTokens(),this.saveRefreshTokens()]);
      throw error;
    }
    return {access_token,token_type:'Bearer',expires_in,scope:'mcp',
      ...(refresh_token?{refresh_token,refresh_token_expires_in:this.policy.refreshTokenDays*86400}:{})};
  }

  saveTokens() {
    if (!this.policy.persistAccessTokens || !this.tokenFile) return Promise.resolve();
    const write = this.tokenWriteQueue.then(() => atomicJSON(this.tokenFile,
      { version: 1, tokens: [...this.tokens].map(([hash, item]) => ({ hash, expires: item.expires, client_id: item.client_id })) }));
    this.tokenWriteQueue = write.catch(() => {});
    return write;
  }

  status() {
    this.sweep();
    return { activeTokens: this.tokens.size, activeRefreshTokens: this.refreshTokens.size, refreshTokensEnabled: this.policy.refreshTokensEnabled, pendingCodes: this.codes.size,
      pendingConsentForms: this.forms.size, registeredClients: this.clients.size,
      envBearerConfigured: Boolean(this.bearer), envBearerEnabled: this.policy.envBearerEnabled,
      managedBearer: this.managedBearer ? { configured: true, issued_at: this.managedBearer.issued_at,
        expires_at: new Date(this.managedBearer.expires).toISOString(),
        expired: this.managedBearer.expires <= Date.now() } : { configured: false },
      clients: [...this.clients.values()].map(client => ({ client_id: client.client_id,
        client_name: client.client_name, redirect_uris: client.redirect_uris,
        token_endpoint_auth_method: client.token_endpoint_auth_method })) };
  }

  async rotateManagedBearer(days) {
    if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw new Error('Credential lifetime must be 1-365 days');
    const access_token = randomToken();
    const issued_at = new Date().toISOString();
    const state = { version: 1, hash: sha256(access_token), issued_at,
      expires: Date.now() + days * 86400000 };
    if (!this.bearerFile) throw new Error('OAuth key storage not configured');
    await atomicJSON(this.bearerFile, state);
    this.managedBearer = state;
    return { access_token, issued_at, expires_at: new Date(state.expires).toISOString() };
  }

  async revokeManagedBearer() {
    if (!this.bearerFile) throw new Error('OAuth key storage not configured');
    await atomicJSON(this.bearerFile, { version: 1, hash: null, issued_at: null, expires: null });
    this.managedBearer = null;
  }

  async revokeAllAccessTokens() {
    // Global sign-out also revokes refresh credentials.
    const prevAccess = this.tokens, prevRefresh = this.refreshTokens;
    this.tokens = new Map();
    this.refreshTokens = new Map();
    try { await this.saveTokens(); await this.saveRefreshTokens(); }
    catch (error) {
      this.tokens = prevAccess; this.refreshTokens = prevRefresh;
      await Promise.allSettled([this.saveTokens(),this.saveRefreshTokens()]);
      throw error;
    }
  }

  async revokeClient(clientId) {
    const client = this.clients.get(clientId);
    if (!client) throw new Error('Unknown OAuth client');
    this.clients.delete(clientId);
    try { await this.saveClients(); }
    catch (error) { this.clients.set(clientId, client); throw error; }
    for (const [hash, value] of this.tokens) if (value.client_id === clientId) this.tokens.delete(hash);
    for (const [code, value] of this.codes) if (value.client_id === clientId) this.codes.delete(code);
    for (const [hash, value] of this.refreshTokens) if (value.client_id === clientId) this.refreshTokens.delete(hash);
    await this.saveTokens();
    await this.saveRefreshTokens();
  }

  validateRedirects(uris) {
    if (!Array.isArray(uris) || !uris.length || uris.length > 10) throw new Error('redirect_uris is required');
    for (const value of uris) {
      const uri = new URL(value);
      if (uri.protocol !== 'https:' || uri.username || uri.password || uri.hash || !this.redirectOrigins.has(uri.origin)) throw new Error('Redirect origin is not in OAUTH_REDIRECT_ORIGINS');
    }
  }

  async init() {
    if (this.bearerFile) {
      try {
        const state = await readJSON(this.bearerFile);
        if (state.version !== 1 || (state.hash !== null &&
            (typeof state.hash !== 'string' || !/^[a-f0-9]{64}$/.test(state.hash) ||
             !Number.isSafeInteger(state.expires) || typeof state.issued_at !== 'string'))) {
          throw new Error('Invalid managed OAuth credential');
        }
        this.managedBearer = state.hash ? state : null;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!this.clientFile) return;
    let saved;
    try { saved = await readJSON(this.clientFile); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (saved.version !== 1 || !Array.isArray(saved.clients)) throw new Error('Invalid persisted OAuth client registry');
    for (const client of saved.clients) {
      if (typeof client.client_id !== 'string' || !client.client_id || client.token_endpoint_auth_method !== 'none') throw new Error('Invalid persisted OAuth client');
      this.validateRedirects(client.redirect_uris);
      this.clients.set(client.client_id, client);
    }
    this.sweep();
  }

  saveClients() {
    if (!this.clientFile) return Promise.resolve();
    const saving = this.clientWriteQueue.then(() => atomicJSON(this.clientFile, { version: 1, clients: [...this.clients.values()] }));
    this.clientWriteQueue = saving.catch(() => {});
    return saving;
  }

  sweep() {
    const now = Date.now();
    for (const collection of [this.codes, this.tokens, this.refreshTokens, this.forms, this.clients, this.attempts]) {
      for (const [key, value] of collection) if (value.expires <= now) collection.delete(key);
    }
  }

  authorized(req) {
    this.sweep();
    const authorization = req.headers.authorization || '';
    if (!authorization.startsWith('Bearer ')) return false;
    const token = authorization.slice(7);
    if (token.length > 512) return false;
    const hash = sha256(token);
    return Boolean((this.policy.envBearerEnabled && this.bearer && equal(token, this.bearer)) ||
      (this.managedBearer && this.managedBearer.expires > Date.now() && equal(hash, this.managedBearer.hash)) ||
      this.tokens.has(hash));
  }

  challenge(res) {
    res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${this.base}/.well-known/oauth-protected-resource"`, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  }

  metadata() {
    return { issuer: this.base, authorization_endpoint: `${this.base}/oauth/authorize`, token_endpoint: `${this.base}/oauth/token`, registration_endpoint: `${this.base}/oauth/register`, response_types_supported: ['code'], grant_types_supported: this.policy.refreshTokensEnabled ? ['authorization_code','refresh_token'] : ['authorization_code'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: ['mcp'] };
  }

  validateAuthorization(params) {
    const client = this.clients.get(params.get('client_id'));
    if (!client || !client.redirect_uris.includes(params.get('redirect_uri'))) throw new Error('Unknown client or redirect URI');
    if (params.get('response_type') !== 'code' || params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(params.get('code_challenge') || '')) throw new Error('Authorization code with PKCE S256 is required');
    if (params.get('resource') && params.get('resource') !== `${this.base}/mcp`) throw new Error('Invalid resource');
    if (params.get('scope') && params.get('scope') !== 'mcp') throw new Error('Only mcp scope is supported');
    return client;
  }

  async handle(req, res, url, readBody, json) {
    this.sweep();
    if (req.method === 'GET' && url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      json(res, 200, { resource: `${this.base}/mcp`, authorization_servers: [this.base], scopes_supported: ['mcp'], bearer_methods_supported: ['header'] });
      return true;
    }
    if (req.method === 'GET' && (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/openid-configuration')) {
      json(res, 200, this.metadata()); return true;
    }
    if (url.pathname === '/oauth/register' && req.method === 'POST') {
      if (!this.password) throw new Error('OAuth login is not enabled');
      if (!this.policy.allowDynamicRegistration) throw new Error('Dynamic client registration is disabled');
      if (this.clients.size >= this.policy.maxClients) throw new Error('Client registration capacity reached');
      const body = JSON.parse(await readBody(req));
      this.validateRedirects(body.redirect_uris);
      if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none') throw new Error('Only public PKCE clients are supported');
      const client_id = randomToken();
      const client = { client_id, redirect_uris: body.redirect_uris, client_name: String(body.client_name || 'MCP client').slice(0, 100), token_endpoint_auth_method: 'none', grant_types: ['authorization_code','refresh_token'], response_types: ['code'] };
      this.clients.set(client_id, client);
      try { await this.saveClients(); }
      catch (error) { this.clients.delete(client_id); throw error; }
      json(res, 201, client); return true;
    }
    if (url.pathname === '/oauth/authorize' && req.method === 'GET') {
      if (!this.password) throw new Error('OAuth login is not enabled');
      if (this.forms.size >= 1000) throw new Error('Authorization capacity reached');
      const client = this.validateAuthorization(url.searchParams);
      // Browsers can apply form-action to the POST's redirect target too.
      // Allow only this validated callback origin alongside our own form action.
      const callbackOrigin = new URL(url.searchParams.get('redirect_uri')).origin;
      const form = randomToken();
      this.forms.set(form, { params: url.searchParams.toString(), expires: Date.now() + this.policy.consentFormMinutes * 60000 });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin', 'Content-Security-Policy': `default-src 'none'; form-action 'self' ${callbackOrigin}; frame-ancestors 'none'` });
      res.end(`<!doctype html><meta charset="utf-8"><title>Authorize development tools</title><h1>Authorize ${escapeHTML(client.client_name)}</h1><p>This grants access to files and command execution in your development environment.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="form" value="${form}"><label>Server owner password <input type="password" name="password" required autocomplete="current-password"></label><button type="submit">Authorize</button></form>`);
      return true;
    }
    if (url.pathname === '/oauth/authorize' && req.method === 'POST') {
      const body = new URLSearchParams(await readBody(req));
      const form = this.forms.get(body.get('form'));
      this.forms.delete(body.get('form'));
      if (!form) throw new Error('Authorization form expired');
      const key = req.socket.remoteAddress || 'unknown';
      const attempts = this.attempts.get(key) || { count: 0, expires: Date.now() + 300000 };
      attempts.count++;
      this.attempts.set(key, attempts);
      if (attempts.count > 10 || !equal(body.get('password'), this.password)) { json(res, 403, { error: 'access_denied' }); return true; }
      const params = new URLSearchParams(form.params);
      this.validateAuthorization(params);
      const code = randomToken();
      this.codes.set(code, { client_id: params.get('client_id'), redirect_uri: params.get('redirect_uri'), challenge: params.get('code_challenge'), resource: params.get('resource') || `${this.base}/mcp`, expires: Date.now() + this.policy.authorizationCodeSeconds * 1000 });
      const redirect = new URL(params.get('redirect_uri'));
      redirect.searchParams.set('code', code);
      if (params.has('state')) redirect.searchParams.set('state', params.get('state'));
      res.writeHead(302, { Location: redirect.href, 'Cache-Control': 'no-store' }); res.end(); return true;
    }
    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      const body = new URLSearchParams(await readBody(req));
      if (body.get('grant_type') === 'refresh_token') {
        const supplied = body.get('refresh_token') || '';
        const clientId = body.get('client_id') || '';
        const oldHash = supplied.length <= 512 ? sha256(supplied) : '';
        const existing = this.refreshTokens.get(oldHash);
        if (!this.policy.refreshTokensEnabled || !existing || !this.clients.has(clientId) ||
            existing.client_id !== clientId || existing.expires <= Date.now() ||
            (body.get('resource') && body.get('resource') !== this.base + '/mcp') ||
            (body.get('scope') && body.get('scope') !== 'mcp')) {
          json(res, 400, {error:'invalid_grant'}); return true;
        }
        // A refresh is a one-time, client-bound rotation.
        json(res, 200, await this.issueTokenPair(clientId, oldHash)); return true;
      }
      const code = this.codes.get(body.get('code'));
      this.codes.delete(body.get('code'));
      const verifier = body.get('code_verifier') || '';
      if (body.get('grant_type') !== 'authorization_code' || !code || code.client_id !== body.get('client_id') || code.redirect_uri !== body.get('redirect_uri') || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !equal(createHash('sha256').update(verifier).digest('base64url'), code.challenge) || (body.get('resource') && body.get('resource') !== code.resource)) {
        json(res, 400, { error: 'invalid_grant' }); return true;
      }
      json(res, 200, await this.issueTokenPair(code.client_id)); return true;
    }
    return false;
  }
}
