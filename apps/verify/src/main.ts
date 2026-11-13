/**
 * The verify page. Everything shown comes from `verifyDigestOnChain` (the same decision as
 * `routespec certificate verify --digest`) and is written with `textContent` only.
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

const TONE: Readonly<Record<BadgeStatus, 'pass' | 'fail' | 'review' | 'neutral'>> = {
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

function short(text: string, keep = 10): string {
  return text.length <= keep * 2 + 1 ? text : `${text.slice(0, keep)}…${text.slice(-keep)}`;
}

function utc(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, ' UTC');
}

function dl(rows: Array<[string, Node | string]>): HTMLElement {
  const list = el('dl', { class: 'facts' });
  for (const [k, v] of rows) list.append(el('dt', {}, k), el('dd', {}, v));
  return list;
}

function code(text: string, title = text): HTMLElement {
  return el('code', { title, class: 'digest' }, text);
}

let config: VerifyPageConfig | null = null;
let fileDigest: { digest: string; bytes: number; name: string } | null = null;

function result(): HTMLElement {
  return $('result');
}

function showBusy(text: string): void {
  const r = result();
  r.hidden = false;
  r.setAttribute('aria-busy', 'true');
  r.replaceChildren(el('p', { class: 'busy', 'data-state': 'busy' }, text));
}

function showError(message: string, reason: string | null = null): void {
  const r = result();
  r.hidden = false;
  r.setAttribute('aria-busy', 'false');
  r.replaceChildren(
    el(
      'div',
      {
        class: 'verdict tone-neutral',
        'data-status': 'UNVERIFIED',
        'data-reason': reason ?? '',
        role: 'status',
      },
      el('p', { class: 'headline' }, HEADLINE.UNVERIFIED),
      el('p', {}, message),
      reason === null ? null : el('p', { class: 'reason' }, 'Reason: ', el('code', {}, reason)),
    ),
  );
}

function render(req: ResolvedRequest, v: PageVerification, source: string, extra: string | null): void {
  const r = result();
  r.setAttribute('aria-busy', 'false');
  r.hidden = false;
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
    },
    el('p', { class: 'headline' }, HEADLINE[v.status]),
    el('p', {}, BADGE_STATUS_TEXT[v.status]),
    extra === null ? null : el('p', { class: 'reason' }, extra),
  );
  const notices = req.notices.map((n) => el('p', { class: 'notice', 'data-notice': n }, NOTICE_TEXT[n]));

  const codeState =
    v.registry.codeHashKnown === null
      ? 'not checked (no known builds configured)'
      : v.registry.codeHashKnown
        ? 'matches a known reproducible build'
        : 'NOT a known reproducible build';
  const facts = dl([
    ['Bundle digest', el('span', {}, code(v.bundleDigest), el('span', { class: 'sub' }, source))],
    ['Registry', code(v.registry.accountId)],
    ['Network', `${req.network} (node reports chain id "${v.chainId}")`],
    ['Registry code', el('span', {}, code(v.registry.codeHash), el('span', { class: 'sub' }, codeState))],
    ['Registry owner', code(v.registry.ownerId)],
    ['Read at block', String(v.registry.readAtBlockHeight)],
    [
      'Trusted attesters',
      v.trustedAttesters.length === 0
        ? 'any attester the registry reports enrolled and not revoked'
        : el(
            'span',
            {},
            ...v.trustedAttesters.map((k) => el('span', { class: 'key' }, code(short(k, 8), k))),
          ),
    ],
    ['Findings', v.release.findings.length === 0 ? 'none' : v.release.findings.join(', ')],
  ]);

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
    body.append(
      el(
        'tr',
        { 'data-certificate': String(c.id) },
        el('td', {}, String(c.id)),
        el('td', {}, c.verdict),
        el('td', {}, code(short(c.attester, 8), c.attester)),
        el('td', {}, state.trim()),
        el('td', {}, `${utc(c.publishedAtMs)}, block ${String(c.publishedBlockHeight)}`),
        el('td', {}, c.accepted ? 'yes' : 'no'),
        el('td', {}, c.findings.length === 0 ? '-' : c.findings.join(', ')),
      ),
    );
  }
  table.append(body);
  const certs =
    v.certificates.length === 0
      ? el('p', {}, 'The registry holds no certificate for this bundle digest.')
      : el(
          'div',
          {
            class: 'scroll',
            role: 'region',
            'aria-label': 'Certificates (scrolls horizontally)',
            tabindex: '0',
          },
          table,
        );

  const link = verifyLink(window.location.href, req.network, { digest: v.bundleDigest });
  r.replaceChildren(
    verdict,
    ...notices,
    el('h2', {}, 'What was read'),
    facts,
    el('h2', {}, 'Certificates for this bundle'),
    certs,
    el('h2', {}, 'Link to this check'),
    el('p', {}, el('a', { href: link, 'data-link': 'digest' }, short(link, 40))),
  );
}

async function run(req: ResolvedRequest, source: string): Promise<void> {
  const common = {
    rpcUrl: req.rpcUrl,
    registry: req.registry,
    expectedChainId: req.chainId,
    trustedAttesters: req.trustedAttesters,
  };
  try {
    let digest = req.digest;
    let extra: string | null = null;
    if (digest === null && req.project !== null) {
      showBusy(`Looking up the newest certificate of ${req.project}…`);
      const latest = await latestProjectDigest({ ...common, project: req.project });
      if (latest === null) {
        showError(
          `The registry holds no certificate for the project ${req.project}.`,
          'NO_PROJECT_CERTIFICATE',
        );
        return;
      }
      digest = latest.bundleDigest;
      source = `newest certificate (#${String(latest.certificateId)}) of ${req.project}`;
      extra = `Project ${req.project}: ${String(latest.projectCertificates)} certificate(s) in the registry.`;
    }
    if (digest === null) {
      showError('Choose a bundle file, a bundle digest, or a project first.', 'NOTHING_TO_CHECK');
      return;
    }
    showBusy('Reading the registry and checking signatures…');
    const v = await verifyDigestOnChain({
      ...common,
      bundleDigest: digest,
      knownCodeHashes: config?.knownCodeHashes ?? [],
    });
    render(req, v, source, extra);
  } catch (error) {
    if (error instanceof BrowserVerifyError) {
      const message =
        error.reason === 'UNKNOWN_ACCOUNT'
          ? `The registry account ${req.registry} does not exist on ${req.network}. It may not be deployed yet, so nothing can be certified there.`
          : error.code === 'NETWORK_MISMATCH'
            ? `The RPC endpoint serves the network "${error.reason ?? ''}", not ${req.network}.`
            : error.message;
      showError(message, error.reason ?? error.code);
    } else
      showError(
        'Something went wrong while checking. Nothing was verified.',
        error instanceof Error ? error.name : null,
      );
  }
}

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
  if (file.size > MAX_BUNDLE_BYTES) {
    fileDigest = null;
    out.textContent = 'The file is larger than 256 MiB, the bundle size limit.';
    return;
  }
  out.textContent = 'Computing the digest in this browser…';
  const digest = await sha256Digest(new Uint8Array(await file.arrayBuffer()));
  fileDigest = { digest, bytes: file.size, name: file.name };
  out.replaceChildren('Computed in this browser: ', code(digest), ` (${String(file.size)} bytes)`);
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
  });

  $<HTMLFormElement>('verify-form').addEventListener('submit', (e) => {
    e.preventDefault();
    let req: ResolvedRequest;
    try {
      req = resolveRequest(cfg, formInput());
    } catch (error) {
      showError(error instanceof RequestError ? error.message : 'The form is not valid.', 'INPUT_INVALID');
      return;
    }
    const source =
      fileDigest !== null
        ? `computed in this browser from ${fileDigest.name} (${String(fileDigest.bytes)} bytes)`
        : 'as given';
    void run(req, source);
  });

  if (linkError !== null) showError(linkError, 'LINK_INVALID');
  else if (fromLink !== null && (fromLink.digest !== null || fromLink.project !== null)) {
    void run(fromLink, fromLink.digest !== null ? 'from the link' : '');
  }
}

void start();
