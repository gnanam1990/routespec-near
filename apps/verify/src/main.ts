/**
 * The verify page. Everything shown comes from `verifyDigestOnChain` (the same decision as
 * `routespec certificate verify --digest`) and is written with `textContent` only.
 *
 * The check ledger (five steps) follows the JSON-RPC calls the page actually makes: a fetch
 * wrapper reads the method of each outgoing request and marks the step it belongs to. A step is
 * only marked done after the whole verification returned, and an error stops the ledger at the
 * step whose call was in flight. Nothing on it is simulated.
 */
import {
  BADGE_STATUS_TEXT,
  BrowserVerifyError,
  latestProjectDigest,
  sha256Digest,
  verifyDigestOnChain,
  type BadgeStatus,
  type PageVerification,
} from '@routespec/registry/browser';
import { parseConfig, type VerifyPageConfig } from './config.ts';
import { icon, type IconName } from './icons.ts';
import {
  inputFromSearch,
  RequestError,
  resolveRequest,
  verifyLink,
  type Notice,
  type ResolvedRequest,
} from './request.ts';

const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function el(
  tag: string,
  attrs: Record<string, string> = {},
  ...children: Array<Node | string | null>
): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children)
    if (c !== null) node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return node;
}

type Tone = 'pass' | 'fail' | 'review' | 'neutral';

const TONE: Readonly<Record<BadgeStatus, Tone>> = {
  CERTIFIED_PASS: 'pass',
  CERTIFIED_FAIL: 'fail',
  CERTIFIED_REVIEW: 'review',
  CERTIFIED_NOT_RUN: 'neutral',
  ATTESTER_REVOKED: 'review',
  ATTESTERS_DISAGREE: 'review',
  NO_CERTIFICATE: 'neutral',
  NOT_CERTIFIED: 'neutral',
  REGISTRY_CODE_UNKNOWN: 'review',
  UNVERIFIED: 'neutral',
};

/** UI-SPEC 4: PASS check, FAIL cross, REVIEW alert, NOT_RUN hollow circle; neutral states say why. */
const STATUS_ICON: Readonly<Record<BadgeStatus, IconName>> = {
  CERTIFIED_PASS: 'check',
  CERTIFIED_FAIL: 'x',
  CERTIFIED_REVIEW: 'alert',
  CERTIFIED_NOT_RUN: 'circle',
  ATTESTER_REVOKED: 'slash',
  ATTESTERS_DISAGREE: 'alert',
  NO_CERTIFICATE: 'circle',
  NOT_CERTIFIED: 'slash',
  REGISTRY_CODE_UNKNOWN: 'question',
  UNVERIFIED: 'disconnected',
};

const VERDICT_ICON: Readonly<Record<string, IconName>> = {
  PASS: 'check',
  FAIL: 'x',
  REVIEW: 'alert',
  NOT_RUN: 'circle',
};

const HEADLINE: Readonly<Record<BadgeStatus, string>> = {
  CERTIFIED_PASS: 'Certified: PASS',
  CERTIFIED_FAIL: 'Certified: FAIL',
  CERTIFIED_REVIEW: 'Certified: REVIEW',
  CERTIFIED_NOT_RUN: 'Certified: NOT_RUN',
  ATTESTER_REVOKED: 'Not certified: attester revoked',
  ATTESTERS_DISAGREE: 'Not certified: attesters disagree',
  NO_CERTIFICATE: 'Not certified: no certificate',
  NOT_CERTIFIED: 'Not certified',
  REGISTRY_CODE_UNKNOWN: 'Not certified: unknown registry code',
  UNVERIFIED: 'Not verified',
};

const NOTICE_TEXT: Readonly<Record<Notice, string>> = {
  REGISTRY_NOT_DEFAULT:
    'This link names a registry other than the one this page is configured with. Its owner decides who may attest.',
  RPC_FROM_LINK: 'This link names an RPC endpoint on this computer. Its answers are used as given.',
  ATTESTERS_FROM_LINK: 'This link pins the attester keys below; only their certificates count.',
};

// ---------------------------------------------------------------------------------------------
// Formatting

function short(text: string, keep = 10): string {
  return text.length <= keep * 2 + 1 ? text : `${text.slice(0, keep)}…${text.slice(-keep)}`;
}

function utc(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, ' UTC');
}

function code(text: string): HTMLElement {
  return el('code', { class: 'digest' }, text);
}

/**
 * A digest in 8-character groups for scanning. The groups are separate spans spaced by CSS, so
 * the text (copy, screen readers, `textContent`) is the exact digest.
 */
function digestText(digest: string): HTMLElement {
  const [prefix, hex] = digest.includes(':') ? digest.split(':', 2) : ['', digest];
  const node = el('code', { class: 'digest grouped' });
  if (prefix !== '' && prefix !== undefined) node.append(el('span', { class: 'algo' }, `${prefix}:`));
  const body = hex ?? '';
  for (let i = 0; i < body.length; i += 8) node.append(el('span', { class: 'g' }, body.slice(i, i + 8)));
  return node;
}

function sub(text: string): HTMLElement {
  return el('span', { class: 'sub' }, text);
}

function facts(rows: Array<[string, Node | string]>): HTMLElement {
  const list = el('dl', { class: 'facts' });
  for (const [k, v] of rows) list.append(el('div', { class: 'fact' }, el('dt', {}, k), el('dd', {}, v)));
  return list;
}

function announce(text: string): void {
  const live = $('copy-status');
  live.textContent = '';
  window.setTimeout(() => (live.textContent = text), 30);
}

function copyButton(value: string, what: string, visibleText: string | null = null): HTMLElement {
  const button = el(
    'button',
    {
      type: 'button',
      class: visibleText === null ? 'copy icon-only' : 'copy',
      'aria-label': `Copy ${what}`,
      title: `Copy ${what}`,
    },
    icon('copy', 16),
    visibleText === null ? null : el('span', {}, visibleText),
  );
  button.addEventListener('click', () => {
    const done = (ok: boolean): void =>
      announce(ok ? `Copied the ${what}.` : `Copy is not available here; select the ${what} instead.`);
    if (navigator.clipboard === undefined) return done(false);
    navigator.clipboard.writeText(value).then(
      () => done(true),
      () => done(false),
    );
  });
  return button;
}

// ---------------------------------------------------------------------------------------------
// The check ledger

type Stage = 'digest' | 'network' | 'registry' | 'certificates' | 'signatures';
type StepState = 'idle' | 'active' | 'done' | 'flag' | 'stopped' | 'skipped';

const STAGES: readonly Stage[] = ['digest', 'network', 'registry', 'certificates', 'signatures'];
const STAGE_TITLE: Readonly<Record<Stage, string>> = {
  digest: 'Bundle digest',
  network: 'Network',
  registry: 'Registry contract',
  certificates: 'Certificates',
  signatures: 'Signatures and attesters',
};
const STEP_ICON: Readonly<Record<StepState, IconName>> = {
  idle: 'circle',
  active: 'clock',
  done: 'check',
  flag: 'alert',
  stopped: 'x',
  skipped: 'slash',
};
const STEP_STATE_TEXT: Readonly<Record<StepState, string>> = {
  idle: '',
  active: 'Reading',
  done: 'Checked',
  flag: 'Checked, see note',
  stopped: 'Stopped here',
  skipped: 'Not reached',
};

let current: Stage | null = null;
let lookingUpProject = false;
/** The stage of the last call made while looking up a project (its calls also read the node and registry). */
let lookupCall: Stage | null = null;

function step(stage: Stage): HTMLElement {
  return document.querySelector<HTMLElement>(`#ledger [data-step="${stage}"]`) as HTMLElement;
}

function setStep(stage: Stage, state: StepState, out: Array<Node | string> = []): void {
  const li = step(stage);
  if (li.getAttribute('data-state') !== state) {
    li.setAttribute('data-state', state);
    li.querySelector('.step-icon')?.replaceChildren(icon(STEP_ICON[state], 20));
    const label = li.querySelector('.step-state') as HTMLElement;
    label.textContent = STEP_STATE_TEXT[state];
  }
  li.querySelector('.step-out')?.replaceChildren(...out);
}

function ledgerState(state: 'idle' | 'running' | 'done' | 'stopped'): void {
  $('ledger').setAttribute('data-state', state);
}

function resetLedger(): void {
  current = null;
  for (const s of STAGES) setStep(s, 'idle');
}

function enter(stage: Stage): void {
  if (current === stage) return;
  const from = current === null ? 0 : STAGES.indexOf(current);
  const to = STAGES.indexOf(stage);
  for (let i = from; i < to; i++) setStep(STAGES[i] as Stage, 'done');
  current = stage;
  setStep(stage, 'active');
  ledgerState('running');
  $('placeholder-text').textContent =
    `Checking: step ${String(to + 1)} of ${String(STAGES.length)}, ${STAGE_TITLE[stage]}.`;
}

/** Stop the ledger at the step in flight; earlier steps answered, later ones were not reached. */
function stopAt(stage: Stage, why: string): void {
  const at = STAGES.indexOf(stage);
  const digestOpen = current === 'digest' && stage !== 'digest';
  STAGES.forEach((s, i) => {
    if (s === 'digest' && digestOpen)
      setStep(s, 'skipped', [
        el(
          'p',
          { class: 'step-line' },
          'No digest: the project lookup reads the node and the registry first.',
        ),
      ]);
    else if (i < at) setStep(s, 'done');
    else if (i === at) setStep(s, 'stopped', [el('p', { class: 'step-note' }, why)]);
    else setStep(s, 'skipped');
  });
  ledgerState('stopped');
}

/** The stage a JSON-RPC request belongs to, from its own method and view name. */
function stageOf(body: unknown): Stage | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as { method?: unknown; params?: { request_type?: unknown; method_name?: unknown } };
  if (lookingUpProject) {
    lookupCall = b.method === 'status' ? 'network' : 'registry';
    return 'digest';
  }
  if (b.method === 'status') return 'network';
  if (b.params?.request_type === 'view_account') return 'registry';
  switch (b.params?.method_name) {
    case 'get_info':
      return 'registry';
    case 'get_certificates_by_bundle':
      return 'certificates';
    case 'get_attester':
      return 'signatures';
    default:
      return null;
  }
}

const trackingFetch: typeof fetch = (input, init) => {
  try {
    const stage = stageOf(JSON.parse(String(init?.body ?? 'null')));
    if (stage !== null) enter(stage);
  } catch {
    // Not JSON: not a call the ledger follows.
  }
  return fetch(input, init);
};

// ---------------------------------------------------------------------------------------------
// Result

let config: VerifyPageConfig | null = null;
let fileDigest: { digest: string; bytes: number; name: string } | null = null;

function result(): HTMLElement {
  return $('result');
}

function showBusy(text: string): void {
  const r = result();
  r.hidden = true;
  r.setAttribute('aria-busy', 'true');
  r.replaceChildren();
  $('placeholder').hidden = false;
  $('placeholder').setAttribute('data-state', 'busy');
  $('placeholder-text').textContent = text;
  $('details').hidden = true;
}

function showVerdict(node: HTMLElement, ...after: HTMLElement[]): void {
  const r = result();
  r.setAttribute('aria-busy', 'false');
  r.replaceChildren(node, ...after);
  r.hidden = false;
  $('placeholder').hidden = true;
  $('placeholder').removeAttribute('data-state');
}

function verdictHead(status: BadgeStatus, tone: Tone): HTMLElement {
  return el(
    'div',
    { class: 'verdict-head' },
    el('span', { class: `verdict-icon tone-${tone}` }, icon(STATUS_ICON[status], 24)),
    el('p', { class: 'headline' }, HEADLINE[status]),
  );
}

function showError(message: string, reason: string | null = null, stage: Stage | null = null): void {
  if (stage !== null) stopAt(stage, message);
  const verdict = el(
    'div',
    {
      class: 'verdict tone-neutral',
      'data-status': 'UNVERIFIED',
      'data-reason': reason ?? '',
      role: 'status',
      tabindex: '-1',
    },
    verdictHead('UNVERIFIED', 'neutral'),
    el('p', { class: 'verdict-text' }, message),
    reason === null
      ? null
      : el('p', { class: 'verdict-meta' }, el('span', { class: 'meta-k' }, 'Reason'), el('code', {}, reason)),
  );
  showVerdict(verdict);
  $('details').hidden = true;
}

function badgePreview(v: PageVerification, tone: Tone): HTMLElement {
  return el(
    'p',
    { class: 'verdict-badge' },
    el('span', { class: 'meta-k' }, 'Badge for this result'),
    el(
      'span',
      { class: 'shield' },
      el('span', { class: 'shield-label' }, v.badge.label),
      el('span', { class: `shield-msg tone-${tone}` }, v.badge.message),
    ),
  );
}

function render(req: ResolvedRequest, v: PageVerification, source: string, extra: string | null): void {
  const tone = TONE[v.status];
  const verdict = el(
    'div',
    {
      class: `verdict tone-${tone}`,
      'data-status': v.status,
      'data-decision': v.release.decision,
      'data-findings': v.release.findings.join(','),
      'data-accepted': v.release.acceptedCertificateIds.join(','),
      'data-digest': v.bundleDigest,
      role: 'status',
      tabindex: '-1',
    },
    verdictHead(v.status, tone),
    el('p', { class: 'verdict-text' }, BADGE_STATUS_TEXT[v.status]),
    extra === null ? null : el('p', { class: 'reason' }, extra),
    el(
      'p',
      { class: 'verdict-meta' },
      el(
        'span',
        { class: 'meta-pair' },
        el('span', { class: 'meta-k' }, 'Release decision'),
        el('code', {}, v.release.decision),
      ),
      el('span', { class: 'meta-pair' }, el('span', { class: 'meta-k' }, 'Status'), el('code', {}, v.status)),
    ),
    badgePreview(v, tone),
  );
  const notices = req.notices.map((n) =>
    el('p', { class: 'notice', 'data-notice': n }, icon('info', 16), el('span', {}, NOTICE_TEXT[n])),
  );
  showVerdict(verdict, ...notices);

  // The ledger, with what each step read.
  const codeState =
    v.registry.codeHashKnown === null
      ? 'not checked (no known builds configured)'
      : v.registry.codeHashKnown
        ? 'matches a known reproducible build'
        : 'NOT a known reproducible build';
  current = null;
  setStep('digest', 'done', [digestText(v.bundleDigest), sub(source === '' ? 'as given' : source)]);
  setStep('network', 'done', [
    el('p', { class: 'step-line' }, `${req.network} (node reports chain id "${v.chainId}")`),
  ]);
  setStep('registry', v.registry.codeHashKnown === false ? 'flag' : 'done', [
    facts([
      ['Registry', code(v.registry.accountId)],
      ['Registry owner', code(v.registry.ownerId)],
      ['Registry code', el('span', {}, code(v.registry.codeHash), sub(codeState))],
      ['Version', code(v.registry.version)],
    ]),
  ]);
  const n = v.certificates.length;
  setStep('certificates', 'done', [
    el(
      'p',
      { class: 'step-line' },
      n === 0
        ? 'None for this bundle digest'
        : `${String(n)} certificate${n === 1 ? '' : 's'} for this bundle digest`,
    ),
    sub(`Read at block ${String(v.registry.readAtBlockHeight)}`),
  ]);
  const accepted = v.release.acceptedCertificateIds.length;
  setStep('signatures', n > 0 && accepted === 0 ? 'flag' : 'done', [
    facts([
      ['Accepted', n === 0 ? 'nothing to check' : `${String(accepted)} of ${String(n)}`],
      [
        'Trusted attesters',
        v.trustedAttesters.length === 0
          ? 'any attester the registry reports enrolled and not revoked'
          : el(
              'span',
              { class: 'keys' },
              ...v.trustedAttesters.map((k) => el('span', { class: 'key' }, code(k))),
            ),
      ],
      [
        'Findings',
        v.release.findings.length === 0
          ? 'none'
          : el('span', { class: 'codes' }, ...v.release.findings.map((f) => el('code', {}, f))),
      ],
    ]),
  ]);
  ledgerState('done');

  // Certificates and the link.
  const table = el('table', { class: 'certs' });
  table.append(
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        ...['Id', 'Verdict', 'Attester', 'Attester state', 'Published', 'Counts', 'Findings'].map((h) =>
          el('th', { scope: 'col' }, h),
        ),
      ),
    ),
  );
  const body = el('tbody');
  for (const c of v.certificates) {
    const s = v.attesters[c.attester] ?? null;
    const state =
      s === null
        ? 'not enrolled'
        : s.revoked
          ? `revoked ${s.revokedAtMs === null ? '' : utc(s.revokedAtMs)}`
          : 'enrolled';
    const verdictTone: Tone =
      c.verdict === 'PASS'
        ? 'pass'
        : c.verdict === 'FAIL'
          ? 'fail'
          : c.verdict === 'REVIEW'
            ? 'review'
            : 'neutral';
    body.append(
      el(
        'tr',
        { 'data-certificate': String(c.id) },
        el('th', { scope: 'row', class: 'num' }, String(c.id)),
        el(
          'td',
          {},
          el(
            'span',
            { class: `vtag tone-${verdictTone}` },
            icon(VERDICT_ICON[c.verdict] ?? 'question', 16),
            el('span', {}, c.verdict),
          ),
        ),
        el(
          'td',
          {},
          el(
            'span',
            { class: 'key-cell' },
            el('code', { class: 'digest' }, short(c.attester, 8)),
            copyButton(c.attester, `attester key of certificate ${String(c.id)}`),
          ),
        ),
        el('td', {}, state.trim()),
        el(
          'td',
          {},
          el('span', { class: 'time' }, utc(c.publishedAtMs)),
          sub(`block ${String(c.publishedBlockHeight)}`),
        ),
        el('td', {}, c.accepted ? 'yes' : 'no'),
        el('td', {}, c.findings.length === 0 ? '-' : c.findings.join(', ')),
      ),
    );
  }
  table.append(body);
  $('certs').replaceChildren(
    n === 0
      ? el('p', { class: 'empty' }, 'The registry holds no certificate for this bundle digest.')
      : el(
          'div',
          {
            class: 'scroll',
            role: 'region',
            'aria-label': 'Certificates (scrolls horizontally)',
            tabindex: '0',
          },
          table,
        ),
  );

  const link = verifyLink(window.location.href, req.network, { digest: v.bundleDigest });
  $('share').replaceChildren(
    el('a', { href: link, 'data-link': 'digest', class: 'share-link' }, short(link, 40)),
    copyButton(link, 'link to this check', 'Copy link'),
  );
  $('details').hidden = false;
}

let lookupFailedAt: Stage | null = null;

function lookingUpProjectFailed(): Stage | null {
  const at = lookupFailedAt;
  lookupFailedAt = null;
  return at;
}

async function run(req: ResolvedRequest, source: string): Promise<void> {
  lookupFailedAt = null;
  const button = $<HTMLButtonElement>('verify');
  button.disabled = true;
  resetLedger();
  const common = {
    rpcUrl: req.rpcUrl,
    registry: req.registry,
    expectedChainId: req.chainId,
    trustedAttesters: req.trustedAttesters,
    fetch: trackingFetch,
  };
  try {
    let digest = req.digest;
    let extra: string | null = null;
    if (digest === null && req.project !== null) {
      showBusy(`Looking up the newest certificate of ${req.project}…`);
      enter('digest');
      lookingUpProject = true;
      lookupCall = null;
      let latest: Awaited<ReturnType<typeof latestProjectDigest>>;
      try {
        latest = await latestProjectDigest({ ...common, project: req.project });
      } catch (error) {
        lookupFailedAt = lookupCall;
        throw error;
      } finally {
        lookingUpProject = false;
      }
      if (latest === null) {
        showError(
          `The registry holds no certificate for the project ${req.project}.`,
          'NO_PROJECT_CERTIFICATE',
          'digest',
        );
        return;
      }
      digest = latest.bundleDigest;
      source = `newest certificate (#${String(latest.certificateId)}) of ${req.project}`;
      extra = `Project ${req.project}: ${String(latest.projectCertificates)} certificate(s) in the registry.`;
    }
    if (digest === null) {
      showError('Choose a bundle file, a bundle digest, or a project first.', 'NOTHING_TO_CHECK', 'digest');
      return;
    }
    showBusy('Reading the registry and checking signatures…');
    enter('network');
    const v = await verifyDigestOnChain({
      ...common,
      bundleDigest: digest,
      knownCodeHashes: config?.knownCodeHashes ?? [],
    });
    render(req, v, source, extra);
  } catch (error) {
    // A failed project lookup stopped at the node or the registry, not at the digest itself.
    const at = lookingUpProjectFailed() ?? current ?? 'digest';
    if (error instanceof BrowserVerifyError) {
      const message =
        error.reason === 'UNKNOWN_ACCOUNT'
          ? `The registry account ${req.registry} does not exist on ${req.network}. It may not be deployed yet, so nothing can be certified there.`
          : error.code === 'NETWORK_MISMATCH'
            ? `The RPC endpoint serves the network "${error.reason ?? ''}", not ${req.network}.`
            : error.message;
      showError(message, error.reason ?? error.code, at);
    } else
      showError(
        'Something went wrong while checking. Nothing was verified.',
        error instanceof Error ? error.name : null,
        at,
      );
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------------------------
// Form

function formInput(): Parameters<typeof resolveRequest>[1] {
  const value = (id: string): string => ($<HTMLInputElement>(id).value ?? '').trim();
  return {
    network: value('network'),
    registry: value('registry'),
    attesters: value('attesters').split(/\s+/),
    digest: fileDigest?.digest ?? value('digest'),
    project: fileDigest !== null || value('digest') !== '' ? null : value('project'),
  };
}

async function onFile(file: File): Promise<void> {
  const out = $('bundle-digest');
  out.removeAttribute('data-state');
  if (file.size > MAX_BUNDLE_BYTES) {
    fileDigest = null;
    out.setAttribute('data-state', 'error');
    out.textContent = 'The file is larger than 256 MiB, the bundle size limit.';
    return;
  }
  out.textContent = 'Computing the digest in this browser…';
  const digest = await sha256Digest(new Uint8Array(await file.arrayBuffer()));
  fileDigest = { digest, bytes: file.size, name: file.name };
  out.setAttribute('data-state', 'done');
  out.replaceChildren(
    el('span', { class: 'computed-k' }, 'Computed in this browser: '),
    el('code', { class: 'digest' }, digest),
    ` (${String(file.size)} bytes)`,
  );
  $<HTMLInputElement>('digest').value = '';
}

function fillForm(cfg: VerifyPageConfig, req: ResolvedRequest | null): void {
  const select = $<HTMLSelectElement>('network');
  select.replaceChildren(...Object.keys(cfg.networks).map((n) => el('option', { value: n }, n)));
  select.value = req?.network ?? cfg.defaultNetwork;
  const syncRegistry = (): void => {
    $<HTMLInputElement>('registry').value = cfg.networks[select.value]?.registry ?? '';
  };
  syncRegistry();
  select.addEventListener('change', syncRegistry);
  if (req !== null) {
    $<HTMLInputElement>('registry').value = req.registry;
    if (req.digest !== null) $<HTMLInputElement>('digest').value = req.digest;
  }
  $<HTMLInputElement>('project').value = req?.project ?? (req?.digest == null ? (cfg.project ?? '') : '');
  $<HTMLTextAreaElement>('attesters').value = (req?.trustedAttesters ?? cfg.trustedAttesters).join('\n');
}

async function start(): Promise<void> {
  document.body.append(el('p', { id: 'copy-status', class: 'visually-hidden', 'aria-live': 'polite' }));
  resetLedger();
  try {
    const response = await fetch('./config.json', { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) throw new Error(`config.json: HTTP ${String(response.status)}`);
    config = parseConfig(await response.json());
  } catch (error) {
    $<HTMLButtonElement>('verify').disabled = true;
    showError(
      'The page configuration could not be loaded, so nothing can be verified.',
      error instanceof Error ? error.message : null,
    );
    return;
  }
  const cfg = config;
  const search = new URLSearchParams(window.location.search);
  let fromLink: ResolvedRequest | null = null;
  let linkError: string | null = null;
  try {
    fromLink = resolveRequest(cfg, inputFromSearch(search));
  } catch (error) {
    linkError = error instanceof Error ? error.message : 'The link is not valid.';
  }
  fillForm(cfg, fromLink);

  $<HTMLInputElement>('bundle-file').addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file !== undefined) void onFile(file);
  });
  const drop = $('drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const file = e.dataTransfer?.files[0];
    if (file !== undefined) void onFile(file);
  });
  $<HTMLInputElement>('digest').addEventListener('input', () => {
    fileDigest = null;
    $('bundle-digest').textContent = '';
    $('bundle-digest').removeAttribute('data-state');
  });

  $<HTMLFormElement>('verify-form').addEventListener('submit', (e) => {
    e.preventDefault();
    let req: ResolvedRequest;
    try {
      req = resolveRequest(cfg, formInput());
    } catch (error) {
      resetLedger();
      showError(
        error instanceof RequestError ? error.message : 'The form is not valid.',
        'INPUT_INVALID',
        'digest',
      );
      // UI-SPEC 8: a failed submit moves focus to the error, keeping every input as it was.
      result().querySelector<HTMLElement>('.verdict')?.focus();
      return;
    }
    const source =
      fileDigest !== null
        ? `computed in this browser from ${fileDigest.name} (${String(fileDigest.bytes)} bytes)`
        : 'as given';
    void run(req, source);
  });

  if (linkError !== null) showError(linkError, 'LINK_INVALID', 'digest');
  else if (fromLink !== null && (fromLink.digest !== null || fromLink.project !== null)) {
    void run(fromLink, fromLink.digest !== null ? 'from the link' : '');
  }
}

void start();
