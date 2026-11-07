from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
import json
import os
import sqlite3

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

load_dotenv(Path(__file__).with_name('.env'))
DB_PATH = Path(__file__).with_name('payshield.db')
PAYPAL_MODE = os.getenv('PAYPAL_MODE', 'sandbox').lower()
PAYPAL_CLIENT_ID = os.getenv('PAYPAL_CLIENT_ID', '')
PAYPAL_CLIENT_SECRET = os.getenv('PAYPAL_CLIENT_SECRET', '')
PAYPAL_BASE = 'https://api-m.paypal.com' if PAYPAL_MODE == 'live' else 'https://api-m.sandbox.paypal.com'

app = FastAPI(title='PayShield AI API', version='1.1.0')
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv('FRONTEND_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173').split(','),
    allow_credentials=True, allow_methods=['*'], allow_headers=['*'],
)

class TransactionInput(BaseModel):
    amount: float = Field(gt=0, le=10_000_000)
    currency: str = 'INR'
    recipient: str = Field(min_length=2, max_length=100)
    recipient_email: str = ''
    payment_url: str = ''
    is_new_recipient: bool = False
    payment_method: str = 'PayPal Sandbox'
    notes: str = ''

class PayPalOrderInput(BaseModel):
    transaction_id: int = Field(gt=0)

class PayPalCaptureInput(BaseModel):
    transaction_id: int = Field(gt=0)


def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    with db() as con:
        con.execute('''CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,
            amount REAL NOT NULL, currency TEXT NOT NULL, recipient TEXT NOT NULL,
            risk_score INTEGER NOT NULL, risk_level TEXT NOT NULL,
            decision TEXT NOT NULL, reasons TEXT NOT NULL)''')
        con.execute('''CREATE TABLE IF NOT EXISTS paypal_payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_id INTEGER NOT NULL,
            order_id TEXT UNIQUE NOT NULL, status TEXT NOT NULL,
            amount REAL NOT NULL, currency TEXT NOT NULL, created_at TEXT NOT NULL,
            capture_id TEXT, payer_email TEXT,
            FOREIGN KEY(transaction_id) REFERENCES transactions(id))''')

init_db()


def inspect_url(value: str):
    if not value.strip(): return 0, []
    reasons, score = [], 0
    parsed = urlparse(value.strip() if '://' in value else 'https://' + value.strip())
    host = (parsed.hostname or '').lower()
    if not host: return 20, ['The payment link could not be parsed.']
    if parsed.scheme != 'https': score += 15; reasons.append('The link does not use HTTPS.')
    if host.replace('.', '').isdigit(): score += 30; reasons.append('The link uses an IP address instead of a recognizable domain.')
    suspicious_terms = ['verify', 'urgent', 'claim', 'gift', 'prize', 'login', 'secure-payment']
    if any(term in host for term in suspicious_terms): score += 25; reasons.append('The domain contains wording commonly used in deceptive payment links.')
    if host.count('-') >= 3 or len(host) > 45: score += 10; reasons.append('The domain structure looks unusual.')
    if host.endswith(('.zip', '.top', '.click', '.work')): score += 15; reasons.append('The domain uses an extension that deserves extra scrutiny.')
    return min(score, 50), reasons


def analyze(data: TransactionInput):
    score, reasons = 0, []
    if data.amount >= 100000: score += 30; reasons.append('Very high transaction amount (100,000 or more).')
    elif data.amount >= 50000: score += 20; reasons.append('High transaction amount (50,000 or more).')
    elif data.amount >= 20000: score += 10; reasons.append('Elevated transaction amount (20,000 or more).')
    if data.is_new_recipient: score += 20; reasons.append('This is a first-time recipient.')
    url_score, url_reasons = inspect_url(data.payment_url); score += url_score; reasons.extend(url_reasons)
    text = f'{data.recipient} {data.recipient_email} {data.notes}'.lower()
    matches = [p for p in ['urgent payment', 'account blocked', 'act now', 'send otp', 'share otp', 'password', 'refund fee'] if p in text]
    if matches: score += min(25, 12 * len(matches)); reasons.append('Payment details contain suspicious pressure or credential-related wording.')
    if not data.recipient_email.strip(): score += 5; reasons.append('No recipient email was supplied, so the recipient could not be cross-checked.')
    score = min(score, 100)
    level, decision = ('High', 'BLOCK / VERIFY') if score >= 60 else (('Medium', 'CAUTION') if score >= 30 else ('Low', 'LOW RISK'))
    if not reasons: reasons.append('No risk indicators were found by the current prototype checks.')
    return {'risk_score': score, 'risk_level': level, 'decision': decision, 'reasons': reasons,
        'recommendation': 'Do not proceed until you independently verify the recipient and payment request.' if level == 'High' else 'Verify the recipient using a trusted channel before paying.' if level == 'Medium' else 'Still verify the recipient and amount before confirming payment.',
        'disclaimer': 'Prototype screening only. This is not a guarantee that a payment is safe or fraudulent.'}


def require_paypal_config():
    if not PAYPAL_CLIENT_ID or not PAYPAL_CLIENT_SECRET:
        raise HTTPException(status_code=503, detail='PayPal is not configured. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to backend/.env.')


async def paypal_access_token(client: httpx.AsyncClient):
    require_paypal_config()
    response = await client.post(f'{PAYPAL_BASE}/v1/oauth2/token', auth=(PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET), data={'grant_type': 'client_credentials'}, headers={'Accept': 'application/json', 'Accept-Language': 'en_US'})
    if response.is_error:
        raise HTTPException(status_code=502, detail='PayPal authentication failed. Check your Sandbox app credentials.')
    return response.json()['access_token']


@app.get('/api/health')
def health():
    return {'status': 'ok', 'service': 'PayShield AI'}

@app.post('/api/analyze')
def analyze_transaction(data: TransactionInput):
    result = analyze(data)
    with db() as con:
        cur = con.execute('''INSERT INTO transactions (created_at, amount, currency, recipient, risk_score, risk_level, decision, reasons)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)''', (datetime.now(timezone.utc).isoformat(), data.amount, data.currency.upper(), data.recipient, result['risk_score'], result['risk_level'], result['decision'], json.dumps(result['reasons'])))
        result['transaction_id'] = cur.lastrowid
    return result

@app.get('/api/history')
def history():
    with db() as con:
        rows = con.execute('''SELECT t.*, p.status AS paypal_status, p.order_id AS paypal_order_id
            FROM transactions t LEFT JOIN paypal_payments p ON p.transaction_id=t.id
            ORDER BY t.id DESC LIMIT 30''').fetchall()
    return [{'id': r['id'], 'created_at': r['created_at'], 'amount': r['amount'], 'currency': r['currency'], 'recipient': r['recipient'], 'risk_score': r['risk_score'], 'risk_level': r['risk_level'], 'decision': r['decision'], 'paypal_status': r['paypal_status']} for r in rows]

@app.get('/api/paypal/config')
def paypal_config():
    return {'enabled': bool(PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET), 'client_id': PAYPAL_CLIENT_ID or None, 'currency': 'USD', 'mode': PAYPAL_MODE}

@app.post('/api/paypal/create-order')
async def create_paypal_order(payload: PayPalOrderInput):
    require_paypal_config()
    with db() as con:
        tx = con.execute('SELECT * FROM transactions WHERE id=?', (payload.transaction_id,)).fetchone()
    if not tx: raise HTTPException(status_code=404, detail='Transaction analysis not found. Analyze the payment again.')
    if tx['risk_score'] >= 60: raise HTTPException(status_code=403, detail='High-risk transactions cannot proceed to checkout. Verify the recipient first.')
    # PayPal sandbox checkout is configured in USD to keep the demo predictable.
    # Do not silently convert other currencies; require an explicit USD test amount.
    if tx['currency'].upper() != 'USD':
        raise HTTPException(status_code=400, detail='PayPal checkout in this demo is configured for USD. Select USD and analyze the payment again.')
    amount = f"{tx['amount']:.2f}"
    async with httpx.AsyncClient(timeout=20) as client:
        token = await paypal_access_token(client)
        response = await client.post(f'{PAYPAL_BASE}/v2/checkout/orders', headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}, json={'intent': 'CAPTURE', 'purchase_units': [{'custom_id': str(tx['id']), 'description': 'PayShield AI protected demo payment', 'amount': {'currency_code': 'USD', 'value': amount}}]})
    if response.is_error:
        raise HTTPException(status_code=502, detail='PayPal could not create the order. Check Sandbox configuration and currency.')
    order = response.json()
    with db() as con:
        con.execute('INSERT OR IGNORE INTO paypal_payments (transaction_id, order_id, status, amount, currency, created_at) VALUES (?, ?, ?, ?, ?, ?)', (tx['id'], order['id'], 'CREATED', tx['amount'], 'USD', datetime.now(timezone.utc).isoformat()))
    return {'id': order['id']}

@app.post('/api/paypal/capture-order/{order_id}')
async def capture_paypal_order(order_id: str, payload: PayPalCaptureInput):
    require_paypal_config()
    with db() as con:
        payment = con.execute('SELECT * FROM paypal_payments WHERE order_id=? AND transaction_id=?', (order_id, payload.transaction_id)).fetchone()
    if not payment: raise HTTPException(status_code=404, detail='PayPal order not found for this analyzed transaction.')
    if payment['status'] == 'COMPLETED': return {'id': order_id, 'status': 'COMPLETED', 'message': 'Payment was already captured.'}
    async with httpx.AsyncClient(timeout=20) as client:
        token = await paypal_access_token(client)
        response = await client.post(f'{PAYPAL_BASE}/v2/checkout/orders/{order_id}/capture', headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
    if response.is_error:
        raise HTTPException(status_code=502, detail='PayPal capture failed. The order may need to be approved again.')
    data = response.json()
    capture = (data.get('purchase_units') or [{}])[0].get('payments', {}).get('captures', [{}])[0]
    status = capture.get('status', data.get('status', 'UNKNOWN'))
    payer_email = (data.get('payer') or {}).get('email_address')
    with db() as con:
        con.execute('UPDATE paypal_payments SET status=?, capture_id=?, payer_email=? WHERE order_id=?', (status, capture.get('id'), payer_email, order_id))
    return {'id': order_id, 'status': status, 'capture_id': capture.get('id'), 'payer_email': payer_email}
