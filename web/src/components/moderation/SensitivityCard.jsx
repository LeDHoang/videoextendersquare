import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { Button } from '../ui/controls.jsx';
import StaffActionDialog from './StaffActionDialog.jsx';

// Alert sensitivity (GET/PUT /api/admin/alert-sensitivity). A stricter step lowers the
// alert limits of its group, so the watchdog and this Overview flag sooner. It only moves
// alerts: the limits that stop users are not changed. Every change goes to the audit log.
const GROUPS = [
  {
    key: 'community',
    label: 'COMMUNITY SAFETY',
    note: 'Report and sign-up spikes, queue backlogs, reporters per post or account, bursts from new accounts.',
    limits: [
      ['spike_min', 'SPIKE FLOOR'],
      ['open_reports', 'OPEN REPORTS'],
      ['reporters_per_target', 'REPORTERS / TARGET'],
      ['reporters_per_account', 'REPORTERS / ACCOUNT'],
      ['new_account_activity', 'NEW-ACCOUNT ACTIONS / H'],
    ],
  },
  {
    key: 'abuse',
    label: 'ACCOUNT ABUSE',
    note: 'Credit bursts and many accounts on one IP or device.',
    limits: [
      ['accounts_per_ip', 'ACCOUNTS / IP'],
      ['accounts_per_device', 'ACCOUNTS / DEVICE'],
      ['user_spend_hourly', 'CREDITS / H'],
      ['new_account_spend', 'NEW-ACCOUNT SPEND'],
    ],
  },
];

export default function SensitivityCard({ viewer, onSaved }) {
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState(null);
  const [dialog, setDialog] = useState(null);
  const isAdmin = viewer.role === 'admin';

  useEffect(() => {
    let live = true;
    api.get('/api/admin/alert-sensitivity').then((result) => {
      if (!live) return;
      setSaved(result);
      setDraft(result.sensitivity);
    }).catch(() => {});
    return () => { live = false; };
  }, []);

  if (!saved || !draft) return null;

  const changed = GROUPS.some((group) => draft[group.key] !== saved.sensitivity[group.key]);
  const save = () => setDialog({
    title: 'SET ALERT SENSITIVITY',
    text: GROUPS.map((group) => group.label + ': ' + saved.labels[draft[group.key]]).join(' · '),
    confirmLabel: 'SAVE',
    onSubmit: async (values) => {
      const result = await api.put('/api/admin/alert-sensitivity', { ...draft, ...values });
      setSaved(result);
      setDraft(result.sensitivity);
      onSaved?.();
    },
  });

  return (
    <div className="sx-ov">
      <section className="sx-ov-sec" id="sx-ov-sensitivity">
        <h2>ALERT SENSITIVITY</h2>
        <p>Stricter means lower alert limits, so trouble is flagged sooner. It only moves alerts; what users may do does not change.</p>
        <div className="sx-ov-tiles">
          {GROUPS.map((group) => (
            <div key={group.key} className="sx-ov-tile sx-sens">
              <label className="sx-ov-tile-label" htmlFor={'sx-sens-' + group.key}>{group.label}</label>
              <b className="sx-ov-big">{saved.labels[draft[group.key]]}</b>
              <input
                id={'sx-sens-' + group.key}
                type="range"
                min={0}
                max={saved.labels.length - 1}
                step={1}
                value={draft[group.key]}
                disabled={!isAdmin}
                aria-valuetext={saved.labels[draft[group.key]]}
                onChange={(event) => setDraft({ ...draft, [group.key]: Number(event.target.value) })}
              />
              <span className="sx-ov-note">{group.note}</span>
              <span className="sx-ov-note">
                {draft[group.key] === saved.sensitivity[group.key] ? 'LIMITS NOW: ' : 'LIMITS BEFORE SAVING: '}
                {group.limits.map(([key, label]) => label + ' ' + saved.limits[key]).join(' · ')}
              </span>
            </div>
          ))}
        </div>
        {isAdmin ? <Button disabled={!changed} onClick={save}>SAVE SENSITIVITY</Button> : null}
      </section>
      {dialog ? <StaffActionDialog {...dialog} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
