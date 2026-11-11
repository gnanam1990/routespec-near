import { useResource } from '../app/context.tsx';
import { usePageTitle } from '../app/usePageTitle.ts';
import type { Settings } from '../api/schemas.ts';
import { StatusBadge } from '../components/Status.tsx';
import { Timestamp } from '../components/Timestamp.tsx';
import { KeyValues, Notice, PageHeader, ResourceView, Section } from '../components/ui.tsx';
import { COMPATIBILITY_CONTENT } from '../content/status-content.ts';

const PROVIDER_TOKEN_TEXT: Readonly<Record<Settings['providerTokenState'], string>> = {
  NOT_REQUIRED: 'Not required',
  OPTIONAL_ABSENT: 'Optional — absent',
  PRESENT_IN_MEMORY: 'Present in live-dry adapter memory only',
  EXPIRED: 'Expired',
};

const RUNTIME_TEXT: Readonly<Record<Settings['modes'][number]['runtime'], string>> = {
  NETWORKLESS_SCENARIO: 'Networkless scenario proxy',
  LIVE_DRY_ADAPTER: 'Separately launched live-dry adapter',
  NONE: 'No runtime',
};

export function SettingsPage() {
  usePageTitle('Safety & Settings');
  const { state, reload } = useResource<Settings>((client, signal) => client.getSettings(signal), []);
  return (
    <>
      <PageHeader title="Safety & Settings" />
      <ResourceView state={state} label="safety settings" onRetry={reload} skeletonLines={8}>
        {(s) => (
          <>
            <Section title="Local service">
              <KeyValues
                items={[
                  ['Bind address', <span className="mono">{s.bindAddress}</span>],
                  ['Port', <span className="mono num">{s.port}</span>],
                  ['Provider credential', PROVIDER_TOKEN_TEXT[s.providerTokenState]],
                  ['Upstream origin', <span className="mono">{s.upstreamOrigin ?? 'none'}</span>],
                  [
                    'Allowlisted routes',
                    <span className="mono">{s.allowlistedRoutes.join(', ') || 'none'}</span>,
                  ],
                ]}
              />
              <p className="small muted">
                The console only ever receives the credential state, never a value or fingerprint.
              </p>
            </Section>
            <Section title="Modes">
              <div className="table-scroll" role="region" aria-label="Modes" tabIndex={0}>
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Mode</th>
                      <th scope="col">Support</th>
                      <th scope="col">Runtime</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.modes.map((m) => (
                      <tr key={m.mode}>
                        <th scope="row" className="mono">
                          {m.mode === 'COMMITTED_LIVE' ? 'Committed live' : m.mode}
                        </th>
                        <td>{m.supported ? 'Supported' : 'UNSUPPORTED'}</td>
                        <td>{RUNTIME_TEXT[m.runtime]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
            <Section title="Official endpoint compatibility">
              <Notice tone="neutral" icon="link" title="Separate from the local gate">
                <p>A dry compatibility probe never changes a local verdict. No settlement is tested.</p>
              </Notice>
              <KeyValues
                items={[
                  ['Dry probe authorization', s.dryProbe.authorized ? 'Authorized' : 'Not authorized'],
                  [
                    'Authorization expiry',
                    <Timestamp value={s.dryProbe.expiresAt} fallback="No authorization" />,
                  ],
                ]}
              />
              {s.compatibilityRecords.length === 0 ? (
                <p className="muted">No compatibility records. Status: NOT_RUN.</p>
              ) : (
                <ul className="plain-list">
                  {s.compatibilityRecords.map((r) => (
                    <li key={r.recordId}>
                      <StatusBadge content={COMPATIBILITY_CONTENT[r.status]} code={r.status} />{' '}
                      <span className="mono small">{r.buildRevisionId}</span> ·{' '}
                      <span className="mono small">{r.profileId}</span> · <Timestamp value={r.observedAt} />
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            <Section title="Retention and exports">
              <KeyValues
                items={[
                  ['Retention', `${s.retention.days} days`],
                  ['Local storage', <span className="mono num">{s.retention.storageBytes} bytes</span>],
                  ['Export privacy policy', s.exportPolicy],
                ]}
              />
            </Section>
            <Section title="Versions">
              <KeyValues
                items={[
                  ['Application', <span className="mono">{s.versions.app}</span>],
                  ['Protocol profile', <span className="mono">{s.versions.protocolProfile}</span>],
                  ['Evaluator', <span className="mono">{s.versions.evaluator}</span>],
                  ['Official SDK pin', <span className="mono">{s.versions.sdk}</span>],
                ]}
              />
            </Section>
          </>
        )}
      </ResourceView>
    </>
  );
}
