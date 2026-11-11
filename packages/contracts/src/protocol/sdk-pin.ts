/**
 * Exact official 1Click TypeScript SDK pin recorded at implementation intake (2026-11-11).
 *
 * Evidence class: package source read from the npm registry tarball installed locally under
 * packages/live-dry-adapter (no API call was made). This records the revision the protocol
 * contracts were derived from; it is not a claim that this is the unqualified current
 * version, and it does not prove runtime compatibility with the hosted service.
 * See docs/adr/0002-official-1click-sdk-pin.md.
 */
export const ONECLICK_SDK_PIN = Object.freeze({
  packageName: '@defuse-protocol/one-click-sdk-typescript',
  version: '0.1.26',
  /** `gitHead` field published in the npm registry manifest for 0.1.26. */
  gitHead: '414467b879863661e736eab338b316f567db68fe',
  repository: 'https://github.com/defuse-protocol/one-click-sdk-typescript',
  /** Subresource integrity from pnpm-lock.yaml (npm registry `dist.integrity`). */
  tarballIntegrity:
    'sha512-vYoBgEbppergtYd/H1IaJW9Jm5mPrX+jAwuuhMvDFstirJB53KFe2HnGLTg0KNyg6qztbOeDK0sA/oEAee+EAw==',
  license: 'ISC',
  publishedAt: '2026-09-22T19:17:58.891Z',
  /** `OpenAPI.VERSION` constant embedded in dist/index.mjs (generator-reported API version). */
  embeddedApiVersion: '0.1.10',
  /** Default `OpenAPI.BASE` in dist/index.mjs. RouteSpec never targets it from the networkless runtime. */
  defaultBaseUrl: 'https://1click.chaindefuser.com',
  /**
   * The SDK exports a mutable `OpenAPI` config object whose `BASE` is read on every request, so
   * the base URL is configurable to a local proxy. Verified by source read and by the local
   * loopback test in packages/live-dry-adapter/test/sdk-pin.test.ts.
   */
  baseUrlConfigurable: true,
  baseUrlMechanism: 'exported mutable OpenAPI.BASE',
  /** `OpenAPI.HEADERS` accepts a static map or resolver: the adapter header-injection point. */
  headerInjectionMechanism: 'OpenAPI.HEADERS (Headers | Resolver<Headers>)',
  /** `OpenAPI.TOKEN` is the documented JWT slot; only the live-dry adapter may ever set it. */
  credentialMechanism: 'OpenAPI.TOKEN (string | Resolver<string>)',
  transport: 'axios',
} as const);

/** Every route present in the pinned SDK, with RouteSpec's profile classification. */
export const ONECLICK_SDK_ROUTES = Object.freeze([
  { method: 'GET', path: '/v0/tokens', sdkMethod: 'OneClickService.getTokens', profile: 'UNSUPPORTED' },
  { method: 'POST', path: '/v0/quote', sdkMethod: 'OneClickService.getQuote', profile: 'SUPPORTED' },
  {
    method: 'GET',
    path: '/v0/status',
    sdkMethod: 'OneClickService.getExecutionStatus',
    profile: 'SUPPORTED',
  },
  {
    method: 'POST',
    path: '/v0/deposit/submit',
    sdkMethod: 'OneClickService.submitDepositTx',
    profile: 'SUPPORTED',
  },
  {
    method: 'GET',
    path: '/v0/any-input/withdrawals',
    sdkMethod: 'OneClickService.getAnyInputQuoteWithdrawals',
    profile: 'UNSUPPORTED',
  },
  {
    method: 'POST',
    path: '/v0/generate-intent',
    sdkMethod: 'OneClickService.generateIntent',
    profile: 'UNSUPPORTED',
  },
  {
    method: 'POST',
    path: '/v0/submit-intent',
    sdkMethod: 'OneClickService.submitIntent',
    profile: 'PROHIBITED',
  },
  { method: 'GET', path: '/v0/account/balances', sdkMethod: 'AccountService', profile: 'UNSUPPORTED' },
  { method: 'GET', path: '/v0/account/history', sdkMethod: 'AccountService', profile: 'UNSUPPORTED' },
  { method: 'POST', path: '/v0/orders', sdkMethod: 'OrderService.createOrder', profile: 'PROHIBITED' },
  { method: 'GET', path: '/v0/orders', sdkMethod: 'OrderService', profile: 'UNSUPPORTED' },
  { method: 'POST', path: '/v0/orders/{orderId}/cancel', sdkMethod: 'OrderService', profile: 'PROHIBITED' },
  { method: 'GET', path: '/v0/orders/{orderId}', sdkMethod: 'OrderService', profile: 'UNSUPPORTED' },
  { method: 'POST', path: '/v0/auth/authenticate', sdkMethod: 'UserAuthService', profile: 'PROHIBITED' },
  { method: 'POST', path: '/v0/auth/refresh', sdkMethod: 'UserAuthService', profile: 'PROHIBITED' },
] as const);
