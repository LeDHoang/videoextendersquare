import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { Button } from '../ui/controls.jsx';
import StaffActionDialog from './StaffActionDialog.jsx';

// Admin only: the processing kill switches (GET/PUT /api/admin/switches). They apply
// on the next request and survive a restart; every flip goes to the audit log.
const SWITCHES = [
  { key: 'free', label: 'FREE USAGE', on: 'free jobs, publishing and Explore previews run', off: 'free jobs, publishing and Explore previews are paused' },
  { key: 'paid', label: 'ALL PROCESSING', on: 'cloud jobs and uploads run', off: 'every job and upload is paused' },
];

export default function KillSwitchCard() {
  const [switches, setSwitches] = useState(null);
  const [dialog, setDialog] = useState(null);

  useEffect(() => {
    let live = true;
    api.get('/api/admin/switches').then((result) => { if (live) setSwitches(result.switches); }).catch(() => {});
    return () => { live = false; };
  }, []);

  if (!switches) return null;

  const flip = (item) => {
    const next = { ...switches, [item.key]: !switches[item.key] };
    const pausing = !next[item.key];
    setDialog({
      title: (pausing ? 'PAUSE ' : 'RESUME ') + item.label,
      text: pausing ? 'Until resumed, ' + item.off + '.' : 'Once resumed, ' + item.on + '.',
      confirmLabel: pausing ? 'PAUSE' : 'RESUME',
      kind: pausing ? 'switch' : '',
      onSubmit: async (values) => {
        const result = await api.put('/api/admin/switches', { ...next, cancel_running: false, ...values });
        setSwitches(result.switches);
      },
    });
  };

  return (
    <div className="sx-ov">
      <section className="sx-ov-sec" id="sx-ov-switches">
        <h2>KILL SWITCHES</h2>
        <p>Stop work at once during abuse or an incident, without a deploy. Paid jobs need uploads, so only ALL PROCESSING stops uploads.</p>
        <div className="sx-ov-tiles">
          {SWITCHES.map((item) => (
            <div key={item.key} className={'sx-ov-tile' + (switches[item.key] ? '' : ' sx-ov-tile-bad')}>
              <span className="sx-ov-tile-label" data-state={switches[item.key] ? 'ok' : 'bad'}><i className="sx-ov-dot" />{item.label}</span>
              <b className="sx-ov-big">{switches[item.key] ? 'ON' : 'PAUSED'}</b>
              <span className="sx-ov-note">{switches[item.key] ? item.on : item.off}</span>
              <Button onClick={() => flip(item)}>{switches[item.key] ? 'PAUSE' : 'RESUME'}</Button>
            </div>
          ))}
        </div>
      </section>
      {dialog ? <StaffActionDialog {...dialog} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}
