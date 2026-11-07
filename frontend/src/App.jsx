import React, { useEffect, useMemo, useState } from "react";
import { PayPalScriptProvider, PayPalButtons } from '@paypal/react-paypal-js';
import { ShieldCheck, ShieldAlert, Activity, ScanSearch, History, LockKeyhole, ArrowUpRight, CircleHelp } from 'lucide-react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from 'recharts';

const API = import.meta.env.VITE_API_URL;
const money = (n, currency='INR') => new Intl.NumberFormat('en-IN', {style:'currency', currency, maximumFractionDigits:0}).format(n);

function App() {
  const [form, setForm] = useState({amount:'2500', currency:'INR', recipient:'Alex Merchant', recipient_email:'merchant@example.com', payment_url:'https://example.com/pay', is_new_recipient:false, payment_method:'PayPal Sandbox', notes:''});
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('scanner');
  const [paypalConfig, setPaypalConfig] = useState(null);
  const [paypalStatus, setPaypalStatus] = useState('');
  const [paypalError, setPaypalError] = useState('');

  const refresh = async () => {
    try { const r = await fetch(`${API}/api/history`); if (r.ok) setHistory(await r.json()); } catch {}
  };
  useEffect(() => {
    refresh();
    fetch(`${API}/api/paypal/config`).then(r => r.json()).then(setPaypalConfig).catch(() => setPaypalConfig({enabled:false}));
  }, []);
  const stats = useMemo(() => ({
    total: history.length,
    high: history.filter(x => x.risk_level === 'High').length,
    safe: history.filter(x => x.risk_level === 'Low').length
  }), [history]);

  const update = (key, value) => setForm(p => ({...p, [key]:value}));
  const submit = async (e) => {
    e.preventDefault(); setLoading(true); setError(''); setResult(null);
    try {
      const response = await fetch(`${API}/api/analyze`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...form, amount:Number(form.amount)})});
      if (!response.ok) throw new Error((await response.json()).detail || 'Could not analyze this payment.');
      setResult(await response.json()); await refresh();
    } catch (err) { setError(err.message || 'Cannot connect to the API. Start the backend and try again.'); }
    finally { setLoading(false); }
  };

  const createPayPalOrder = async () => {
    setPaypalError(''); setPaypalStatus('Creating secure PayPal order...');
    const response = await fetch(`${API}/api/paypal/create-order`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({transaction_id:result.transaction_id})});
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Could not create PayPal order.');
    return data.id;
  };
  const capturePayPalOrder = async (data) => {
    setPaypalError(''); setPaypalStatus('Confirming payment with PayPal...');
    const response = await fetch(`${API}/api/paypal/capture-order/${data.orderID}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({transaction_id:result.transaction_id})});
    const captured = await response.json();
    if (!response.ok) throw new Error(captured.detail || 'Payment capture failed.');
    setPaypalStatus(captured.status === 'COMPLETED' ? 'Payment completed successfully in PayPal Sandbox.' : `PayPal payment status: ${captured.status}`);
    await refresh();
  };

  return <PayPalScriptProvider options={{'client-id': paypalConfig?.client_id || 'test', currency:'USD', intent:'capture'}}>
  <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-icon"><ShieldCheck size={22}/></div><div><b>PayShield</b><small>AI SECURITY</small></div></div>
      <div className="workspace-label">WORKSPACE</div>
      <button className={tab==='scanner'?'nav active':'nav'} onClick={()=>setTab('scanner')}><ScanSearch size={18}/> Payment scanner</button>
      <button className={tab==='history'?'nav active':'nav'} onClick={()=>setTab('history')}><History size={18}/> Transaction history</button>
      <div className="sidebar-bottom"><div className="secure"><LockKeyhole size={16}/><span><b>Sandbox mode</b><small>Payment test environment</small></span></div><p>PayShield AI · Payment Security Platform</p></div>
    </aside>
    <main className="main">
      <header className="topbar"><div><span className="eyebrow">PAYMENT PROTECTION</span><h1>{tab==='scanner'?'Payment risk scanner':'Transaction history'}</h1></div><div className="status"><span className="dot"/> Risk engine online</div></header>
      <section className="welcome"><div><div className="welcome-kicker">SMARTER PAYMENTS. SAFER DECISIONS.</div><h2>Trust every payment.<br/><em>Verify before you pay.</em></h2><p>Screen payment details for suspicious signals before sending money.</p></div><div className="hero-shield"><ShieldCheck size={76}/><span>ACTIVE<br/>PROTECTION</span></div></section>
      <section className="stats">
        <div className="stat-card"><span className="stat-icon purple"><Activity size={18}/></span><div><small>Scans recorded</small><strong>{stats.total}</strong></div><span className="stat-note">This session</span></div>
        <div className="stat-card"><span className="stat-icon green"><ShieldCheck size={18}/></span><div><small>Low-risk scans</small><strong>{stats.safe}</strong></div><span className="stat-note">No major flags</span></div>
        <div className="stat-card"><span className="stat-icon red"><ShieldAlert size={18}/></span><div><small>High-risk scans</small><strong>{stats.high}</strong></div><span className="stat-note">Review required</span></div>
      </section>
      {tab==='scanner' ? <section className="content-grid">
        <div className="panel">
          <div className="panel-head"><div><span className="eyebrow">NEW SECURITY CHECK</span><h3>Analyze a payment</h3><p>Enter the details you received. No real payment will be made.</p></div><span className="step">01 / SCAN</span></div>
          <form onSubmit={submit}>
            <div className="field-row">
              <label>Amount<input type="number" min="1" step="0.01" required value={form.amount} onChange={e=>update('amount',e.target.value)}/></label>
              <label>Currency<select value={form.currency} onChange={e=>update('currency',e.target.value)}><option>INR</option><option>USD</option><option>EUR</option><option>GBP</option></select></label>
            </div>
            <label>Recipient / merchant name<input required value={form.recipient} onChange={e=>update('recipient',e.target.value)} placeholder="e.g. ABC Store"/></label>
            <label>Recipient email <span className="optional">OPTIONAL</span><input type="email" value={form.recipient_email} onChange={e=>update('recipient_email',e.target.value)} placeholder="merchant@example.com"/></label>
            <label>Payment link / URL <span className="optional">OPTIONAL</span><input value={form.payment_url} onChange={e=>update('payment_url',e.target.value)} placeholder="https://merchant.com/pay"/></label>
            <label>Payment note / message <span className="optional">OPTIONAL</span><textarea rows="3" value={form.notes} onChange={e=>update('notes',e.target.value)} placeholder="Paste the message or payment request you received..."/></label>
            <label className="check"><input type="checkbox" checked={form.is_new_recipient} onChange={e=>update('is_new_recipient',e.target.checked)}/> This is my first payment to this recipient</label>
            <button className="primary" disabled={loading}>{loading?'Analyzing signals...':'Analyze payment risk'} <ArrowUpRight size={17}/></button>
            {error && <div className="error">{error}</div>}
          </form>
          <div className="form-foot"><LockKeyhole size={14}/> Demo data is stored locally in your backend SQLite database.</div>
        </div>
        <div className="right-column">
          <div className="result-panel panel">
            <div className="panel-head"><div><span className="eyebrow">ANALYSIS OUTPUT</span><h3>Risk assessment</h3></div><CircleHelp size={18} className="muted"/></div>
            {!result ? <div className="empty"><div className="empty-icon"><ScanSearch size={30}/></div><b>Waiting for a scan</b><p>Submit payment details to receive a risk score and actionable explanation.</p><div className="empty-line"><span/> Rules engine ready</div></div> :
              <div className="assessment">
                <div className={`score-ring ${result.risk_level.toLowerCase()}`}><div><strong>{result.risk_score}</strong><small>/ 100</small></div></div>
                <div className="decision"><span className={`risk-pill ${result.risk_level.toLowerCase()}`}>{result.risk_level} risk</span><h2>{result.decision}</h2><p>{result.recommendation}</p></div>
                <div className="reasons"><b>Signals detected</b>{result.reasons.map((r,i)=><div className="reason" key={i}><span className="reason-dot"/>{r}</div>)}</div>
                <div className="disclaimer">{result.disclaimer}</div>
              </div>}
          </div>
          {result && <div className="panel paypal-panel">
            <div className="panel-head"><div><span className="eyebrow">PAYPAL CHECKOUT</span><h3>Complete test payment</h3><p>Checkout is available only after a non-high-risk scan.</p></div><span className="step">SANDBOX</span></div>
            {result.risk_score >= 60 ? <p className="error">Checkout disabled: this transaction is high risk. Verify the recipient before proceeding.</p> : form.currency !== 'USD' ? <p className="muted">For this demo, select USD and analyze again to enable PayPal Sandbox Checkout.</p> : !paypalConfig ? <p className="muted">Checking PayPal configuration...</p> : !paypalConfig.enabled ? <p className="muted">PayPal is not configured yet. Add your Sandbox Client ID and Secret to <code>backend/.env</code>, then restart the API.</p> : <PayPalButtons style={{layout:'vertical', label:'paypal'}} createOrder={createPayPalOrder} onApprove={capturePayPalOrder} onError={(err) => { setPaypalError(err?.message || 'PayPal checkout encountered an error.'); setPaypalStatus(''); }} onCancel={() => setPaypalStatus('Checkout cancelled. No payment was captured.')} /> }
            {paypalStatus && <p className="paypal-status">{paypalStatus}</p>}
            {paypalError && <p className="error">{paypalError}</p>}
            <p className="form-foot"><LockKeyhole size={14}/> Sandbox only: test funds, no real money.</p>
          </div>}
          <div className="panel mini-panel"><div className="mini-icon"><ShieldCheck size={19}/></div><div><b>Safety first</b><p>Never share OTPs, passwords or full card details. Verify payment requests independently.</p></div></div>
        </div>
      </section> : <section className="panel history-panel">
        <div className="panel-head"><div><span className="eyebrow">RECENT ACTIVITY</span><h3>Scanned transactions</h3><p>Latest 30 scans recorded by this demo.</p></div><button className="secondary" onClick={refresh}>Refresh</button></div>
        {history.length===0 ? <div className="empty"><b>No scans yet</b><p>Run a payment analysis to populate this table.</p></div> :
          <div className="table-wrap"><table><thead><tr><th>RECIPIENT</th><th>AMOUNT</th><th>RISK SCORE</th><th>LEVEL</th><th>DECISION</th><th>PAYPAL STATUS</th></tr></thead><tbody>{history.map(item=><tr key={item.id}><td>{item.recipient}<small>{new Date(item.created_at).toLocaleString()}</small></td><td>{money(item.amount,item.currency)}</td><td><b>{item.risk_score}/100</b></td><td><span className={`risk-pill ${item.risk_level.toLowerCase()}`}>{item.risk_level}</span></td><td>{item.decision}</td><td>{item.paypal_status || '—'}</td></tr>)}</tbody></table></div>}
      </section>}
      <footer><span>© 2026 PayShield AI</span><span>Built for safer digital payments</span></footer>
    </main>
  </div>
  </PayPalScriptProvider>;
}
export default App;
